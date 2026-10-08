import { promises as dns, lookup as dnsLookup } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface VerifyDeps {
  /** True when the domain can receive mail (it has MX records, or an address as a fallback). */
  hasMail(domain: string): Promise<boolean>;
  /** The text of a page. Must refuse anything that is not a public website. */
  fetchPage(url: string): Promise<string>;
}

/**
 * code: invalid (not an address), no_mail (the domain takes no mail), unreadable (the server could not open the page: it may block
 * automated requests), not_on_page (it opened the page and the address is not there).
 */
export type VerifyResult = { ok: true; email: string } | { ok: false; reason: string; code?: "invalid" | "no_mail" | "unreadable" | "not_on_page" };

/** Local, private and reserved addresses. A page the agent names must never make this machine call them. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

/** Name lookup that only ever hands back public addresses, so the connection cannot be steered inward. */
function safeLookup(hostname: string, options: { all?: boolean }, cb: (...args: any[]) => void) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error("not a public website"), { code: "EBLOCKED" }));
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

function fetchHttps(url: string, hops = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error("the link is not valid")); }
    if (u.protocol !== "https:") return reject(new Error("only https pages can be checked"));
    if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ""))) return reject(new Error("not a public website"));
    const req = https.request(
      u,
      {
        method: "GET",
        lookup: safeLookup as never,
        timeout: 10_000,
        headers: { "user-agent": "jobhunt-contact-check/0.1", accept: "text/html,text/plain;q=0.9", "accept-encoding": "identity" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (hops >= MAX_REDIRECTS) return reject(new Error("too many redirects"));
          return resolve(fetchHttps(new URL(res.headers.location, u).toString(), hops + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`the page returned ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_PAGE_BYTES) return req.destroy(new Error("the page is too large"));
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("the page took too long")));
    req.on("error", (e) => reject(new Error((e as { code?: string }).code === "EBLOCKED" ? "not a public website" : e.message)));
    req.end();
  });
}

async function resolvesMail(domain: string): Promise<boolean> {
  const gone = (e: unknown) => ["ENOTFOUND", "ENODATA"].includes((e as { code?: string }).code ?? "");
  try {
    if ((await dns.resolveMx(domain)).length > 0) return true;
  } catch (e) {
    if (!gone(e)) throw new Error("could not look the domain up right now");
  }
  for (const resolve of [dns.resolve4, dns.resolve6]) {
    try {
      if ((await resolve(domain)).length > 0) return true;
    } catch (e) {
      if (!gone(e)) throw new Error("could not look the domain up right now");
    }
  }
  return false;
}

export const defaultVerifyDeps: VerifyDeps = { hasMail: resolvesMail, fetchPage: (u) => fetchHttps(u) };

const NAMED: Record<string, string> = { commat: "@", period: ".", amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" };

/** Cloudflare hides addresses as hex: the first byte is a key that every other byte is XORed with. */
function decodeCloudflare(hex: string): string {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return "";
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

/** True when the page shows this exact address, in plain text, a mailto link, entity encoding, "[at]/[dot]" or Cloudflare's hiding. */
export function pageShowsEmail(html: string, email: string): boolean {
  const target = email.toLowerCase();
  const decoded = html
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/%40/gi, "@");
  const cf = [...html.matchAll(/(?:data-cfemail="|email-protection#)([0-9a-f]+)/gi)].map((m) => decodeCloudflare(m[1]!)).join(" ");
  const spelled = decoded.replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not part of a longer address on either side: "xhr@acme.com" and "hr@acme.com.au" are different addresses.
  const exact = new RegExp(`(?<![a-z0-9._%+-])${escaped}(?![a-z0-9_-]|\\.[a-z0-9])`, "i");
  return [decoded, cf, spelled].some((t) => exact.test(t));
}

/**
 * Checks an address before it is accepted as a contact. With a source page the address must appear there,
 * which stops guessed addresses. Without one (an address the user typed) only the domain is checked.
 */
export async function verifyContact(
  input: { email: string; sourceUrl?: string },
  deps: VerifyDeps = defaultVerifyDeps,
): Promise<VerifyResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, code: "invalid", reason: `"${input.email}" is not a valid email address` };
  const domain = email.split("@")[1]!;
  try {
    if (!(await deps.hasMail(domain))) return { ok: false, code: "no_mail", reason: `The domain ${domain} has no mail records, so mail to ${email} would bounce` };
  } catch (e) {
    return { ok: false, code: "no_mail", reason: (e as Error).message };
  }
  if (input.sourceUrl) {
    let html: string;
    try {
      html = await deps.fetchPage(input.sourceUrl);
    } catch (e) {
      return { ok: false, code: "unreadable", reason: `Could not read ${input.sourceUrl}: ${(e as Error).message}` };
    }
    if (!pageShowsEmail(html, email)) {
      return {
        ok: false,
        code: "not_on_page",
        reason: `${email} does not appear on ${input.sourceUrl}. Search again: look for a mailto: link or the address written on the company's own site, and never guess an address.`,
      };
    }
  }
  return { ok: true, email };
}

const letters = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");

/** A person's name as two parts. Several given names or a double surname use the first and last word. */
export function splitName(name: string): { first: string; last: string } | null {
  const words = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[\s]+/).map((w) => w.replace(/[^a-z'-]/g, "")).filter(Boolean);
  if (words.length < 2) return null;
  const clean = (w: string) => w.replace(/[^a-z]/g, "");
  return { first: clean(words[0]!), last: clean(words[words.length - 1]!) };
}

/** How a company forms addresses from a name. The server, never the agent, applies these. */
export const ADDRESS_PATTERNS: { id: string; make: (f: string, l: string) => string }[] = [
  { id: "first.last", make: (f, l) => `${f}.${l}` },
  { id: "firstlast", make: (f, l) => `${f}${l}` },
  { id: "first_last", make: (f, l) => `${f}_${l}` },
  { id: "first-last", make: (f, l) => `${f}-${l}` },
  { id: "flast", make: (f, l) => `${f[0]}${l}` },
  { id: "f.last", make: (f, l) => `${f[0]}.${l}` },
  { id: "first.l", make: (f, l) => `${f}.${l[0]}` },
  { id: "firstl", make: (f, l) => `${f}${l[0]}` },
  { id: "last.first", make: (f, l) => `${l}.${f}` },
  { id: "first", make: (f) => f },
  { id: "last", make: (_f, l) => l },
];

/** Which pattern produces this address for this person, or undefined when none does. */
export function inferPattern(exampleName: string, exampleEmail: string): string | undefined {
  const n = splitName(exampleName);
  if (!n) return undefined;
  const local = exampleEmail.trim().toLowerCase().split("@")[0] ?? "";
  return ADDRESS_PATTERNS.find((p) => p.make(n.first, n.last) === local)?.id;
}

export function deriveAddress(patternId: string, personName: string, domain: string): string | undefined {
  const n = splitName(personName);
  const p = ADDRESS_PATTERNS.find((x) => x.id === patternId);
  return n && p ? `${p.make(n.first, n.last)}@${domain.toLowerCase()}` : undefined;
}

/** True when the page shows this person's name (case, accents and extra spaces ignored). */
export function pageShowsName(html: string, name: string): boolean {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ");
  const want = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (want.split(" ").length < 2) return false;
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").includes(want);
}

export type NameCheck = { ok: true } | { ok: false; reason: string };

/** The page must really show the person's name. Stops an invented decision maker. */
export async function verifyPerson(input: { name: string; sourceUrl: string }, deps: VerifyDeps = defaultVerifyDeps): Promise<NameCheck> {
  if (!splitName(input.name)) return { ok: false, reason: `"${input.name}" needs a first and a last name` };
  let html: string;
  try { html = await deps.fetchPage(input.sourceUrl); } catch (e) { return { ok: false, reason: `Could not read ${input.sourceUrl}: ${(e as Error).message}` }; }
  return pageShowsName(html, input.name)
    ? { ok: true }
    : { ok: false, reason: `${input.name} does not appear on ${input.sourceUrl}. Only record people you saw named on a page.` };
}

export type PatternResult = { ok: true; email: string; pattern: string } | { ok: false; reason: string };

/**
 * Derives a person's address from the pattern of a real one at the same company. The agent names the person
 * and one real address (with its owner's name and page); the server checks both pages, finds the pattern,
 * applies it, and confirms the domain takes mail. The agent never writes the derived address itself.
 */
export async function derivePatternContact(
  input: { personName: string; personUrl: string; exampleName: string; exampleEmail: string; exampleUrl: string },
  deps: VerifyDeps = defaultVerifyDeps,
): Promise<PatternResult> {
  const person = await verifyPerson({ name: input.personName, sourceUrl: input.personUrl }, deps);
  if (!person.ok) return person;
  const example = await verifyContact({ email: input.exampleEmail, sourceUrl: input.exampleUrl }, deps);
  if (!example.ok) return { ok: false, reason: `The example address is not usable. ${example.reason}` };
  const owner = await verifyPerson({ name: input.exampleName, sourceUrl: input.exampleUrl }, deps);
  if (!owner.ok) return { ok: false, reason: `The example address belongs to someone who must be named on the same page. ${owner.reason}` };
  const pattern = inferPattern(input.exampleName, example.email);
  if (!pattern) return { ok: false, reason: `${example.email} does not follow a pattern a name can be turned into (first.last, flast and so on), so other addresses cannot be derived from it` };
  const domain = example.email.split("@")[1]!;
  const email = deriveAddress(pattern, input.personName, domain);
  if (!email) return { ok: false, reason: "Could not derive an address from that name" };
  try {
    if (!(await deps.hasMail(domain))) return { ok: false, reason: `The domain ${domain} has no mail records` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true, email, pattern };
}

const hostOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase().replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
};
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

export const MAX_BROWSER_QUOTE = 400;

/**
 * For a page the server could not open (the site blocks automated requests) but the agent read in a real browser. The server cannot
 * look at the page itself, so it accepts the agent's quote only if every check it CAN make passes: the quote is a real line of text
 * that contains the address, the page is on the company's own site, the address is at that same site (not a free-mail or third-party
 * address), and its domain takes mail. The quote is kept and shown to the user, who confirms by sending.
 */
export async function verifyContactFromBrowser(
  input: { email: string; sourceUrl: string; quote: string; companyDomain?: string },
  deps: Pick<VerifyDeps, "hasMail"> = defaultVerifyDeps,
): Promise<VerifyResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, code: "invalid", reason: `"${input.email}" is not a valid email address` };
  const quote = input.quote.replace(/\s+/g, " ").trim();
  if (quote.length < 8 || quote.length > MAX_BROWSER_QUOTE) return { ok: false, code: "not_on_page", reason: `The quote must be the line from the page that contains the address, 8 to ${MAX_BROWSER_QUOTE} characters` };
  if (!pageShowsEmail(quote, email)) return { ok: false, code: "not_on_page", reason: `The quote you gave does not contain ${email}. Quote the exact line from the page` };
  const pageHost = hostOf(input.sourceUrl);
  if (!pageHost) return { ok: false, code: "invalid", reason: "The page must be a web link" };
  const emailDomain = email.split("@")[1]!;
  const company = input.companyDomain?.toLowerCase().replace(/^www\./, "");
  if (company && !sameSite(pageHost, company)) return { ok: false, code: "not_on_page", reason: `${pageHost} is not the company's own site (${company}). Cite a page on the company's site` };
  if (!sameSite(emailDomain, pageHost) && !(company && sameSite(emailDomain, company))) {
    return { ok: false, code: "not_on_page", reason: `${email} is not at the company's own domain (${company ?? pageHost}), so a browser reading is not enough. Find an address at the company's domain` };
  }
  try {
    if (!(await deps.hasMail(emailDomain))) return { ok: false, code: "no_mail", reason: `The domain ${emailDomain} has no mail records, so mail to ${email} would bounce` };
  } catch (e) {
    return { ok: false, code: "no_mail", reason: (e as Error).message };
  }
  return { ok: true, email };
}
