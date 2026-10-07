import type { DB } from "./db.js";
import type { VerifyDeps } from "./contactVerify.js";
import { domainOf } from "./directory.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

const CAREER_TEXT = /\b(careers?|jobs?|join (us|our team)|work (with|for) us|we['’]?re hiring|open (positions|roles)|openings)\b/i;
const CAREER_PATH = /\/(careers?|jobs?|join(-us)?|work-with-us|openings|positions)(\/|$|\?|#)/i;
// Hosts where companies keep their job lists. A link to one of these from the company's site is its career page.
const JOB_PLATFORMS =
  /(^|\.)(lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|jobs\.gem\.com|greenhouse\.io|workatastartup\.com|ycombinator\.com|personio\.(de|com)|join\.com|pinpointhq\.com|rippling\.com)$/i;
const PROBE_PATHS = ["/careers", "/jobs", "/join-us"];

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** The best link on a page that leads to the company's career page, or undefined. Pure: it only reads the HTML. */
export function findCareersLink(html: string, pageUrl: string): string | undefined {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return undefined; }
  const company = page.hostname.toLowerCase().replace(/^www\./, "");
  let best: { url: string; score: number } | undefined;
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]!.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, page); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const ours = host === company || host.endsWith(`.${company}`);
    const platform = JOB_PLATFORMS.test(host);
    if (!ours && !platform) continue;
    const text = stripTags(m[2]!).slice(0, 80);
    let score = 0;
    if (CAREER_TEXT.test(text)) score += 3;
    if (CAREER_PATH.test(u.pathname + "/")) score += 2;
    if (platform && !ours) score += 2;
    if (platform && !ours && !CAREER_TEXT.test(text) && !CAREER_PATH.test(u.pathname)) score -= 2; // a platform link with nothing about jobs in it
    if (score >= 3 && (!best || score > best.score)) best = { url: u.toString(), score };
  }
  return best?.url;
}

/** True when the page's visible links are too few to trust: it is probably drawn by JavaScript. */
export function looksScripted(html: string): boolean {
  const links = (html.match(/<a\s[^>]*href/gi) ?? []).length;
  return links < 8 || (/<div id=["'](root|__next|app)["']/i.test(html) && links < 15);
}

export type CareersOutcome =
  | { kind: "found"; url: string }
  | { kind: "none" }
  | { kind: "needs_browser" }
  | { kind: "unreachable"; why: string };

export async function findCareersPage(website: string, deps: Pick<VerifyDeps, "fetchPage">): Promise<CareersOutcome> {
  let home = website.trim();
  if (!/^https?:\/\//i.test(home)) home = `https://${home}`;
  home = home.replace(/^http:/i, "https:");
  let html: string;
  try { html = await deps.fetchPage(home); } catch (e) { return { kind: "unreachable", why: (e as Error).message.slice(0, 120) }; }
  const link = findCareersLink(html, home);
  if (link) return { kind: "found", url: link };
  const base = new URL(home);
  for (const path of PROBE_PATHS) {
    const url = new URL(path, base.origin).toString();
    try {
      const body = await deps.fetchPage(url);
      if (CAREER_TEXT.test(stripTags(body).slice(0, 3000))) return { kind: "found", url };
    } catch { /* not there: try the next */ }
  }
  return looksScripted(html) ? { kind: "needs_browser" } : { kind: "none" };
}

export interface FinderResult {
  checked: number;
  found: number;
  none: number;
  needsBrowser: number;
  unreachable: number;
  /** Companies from the lists still waiting after this run. */
  remaining: number;
}

/** Looks for career pages for companies nobody has looked at yet. Code only: no model, one or three requests per company. */
export async function runCareerFinder(
  db: DB,
  deps: Pick<VerifyDeps, "fetchPage">,
  opts: { limit: number; concurrency?: number },
  actor: Actor = "system",
): Promise<FinderResult> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 500);
  const todo = db
    .prepare(
      `SELECT id, website, source, source_ref FROM companies WHERE source IS NOT NULL AND website IS NOT NULL AND careers_status = 'unknown' AND careers_checked_at IS NULL
       ORDER BY (remote_hint = 'fully') DESC, id LIMIT ?`,
    )
    .all(limit) as { id: number; website: string; source: string; source_ref: string }[];
  const result: FinderResult = { checked: 0, found: 0, none: 0, needsBrowser: 0, unreachable: 0, remaining: 0 };
  const save = db.prepare(
    "UPDATE companies SET careers_status = ?, careers_url = COALESCE(?, careers_url), careers_note = ?, careers_checked_at = datetime('now') WHERE id = ?",
  );
  let next = 0;
  const worker = async () => {
    for (;;) {
      const c = todo[next++];
      if (!c) return;
      let r = await findCareersPage(c.website, deps);
      result.checked++;
      // The company's own site shows no link (or needs a browser): a YC company has a jobs page on YC's site, which is a real list of its openings.
      if ((r.kind === "none" || r.kind === "needs_browser") && c.source === "yc" && /^[a-z0-9-]+$/i.test(c.source_ref)) {
        save.run("found", `https://www.ycombinator.com/companies/${c.source_ref}/jobs`, "YC jobs page: the company's own site shows no career link", c.id);
        result.found++;
        continue;
      }
      if (r.kind === "found") { save.run("found", r.url, null, c.id); result.found++; }
      else if (r.kind === "none") { save.run("none", null, "no career link on the home page", c.id); result.none++; }
      else if (r.kind === "needs_browser") { save.run("unknown", null, "needs browser: the home page is drawn by JavaScript", c.id); result.needsBrowser++; }
      else { save.run("unknown", null, `not reachable: ${r.why}`, c.id); result.unreachable++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, todo.length) }, worker));
  result.remaining = (db
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE source IS NOT NULL AND website IS NOT NULL AND careers_status = 'unknown' AND careers_checked_at IS NULL")
    .get() as { n: number }).n;
  logEvent(db, actor, "careers_searched", null, { ...result });
  return result;
}

/** Records a career page found (or ruled out) by someone other than the finder, such as the agent using a browser. */
export function setCareersPage(db: DB, companyId: number, r: { url: string } | { none: true; note?: string }, actor: Actor): void {
  const row = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
  if (!row) throw new Error(`Company ${companyId} not found`);
  if ("url" in r) {
    if (!domainOf(r.url)) throw new Error("The career page must be a web link");
    db.prepare("UPDATE companies SET careers_status = 'found', careers_url = ?, careers_note = NULL, careers_checked_at = datetime('now') WHERE id = ?").run(r.url.trim().slice(0, 500), companyId);
  } else {
    db.prepare("UPDATE companies SET careers_status = 'none', careers_note = ?, careers_checked_at = datetime('now') WHERE id = ?").run((r.note ?? "no career page found in a browser").slice(0, 200), companyId);
  }
  logEvent(db, actor, "careers_set", null, { companyId, ...("url" in r ? { url: r.url } : { none: true }) });
}
