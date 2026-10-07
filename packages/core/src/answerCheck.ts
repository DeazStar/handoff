import type { Profile } from "./profile.js";
import type { StandardAnswer } from "./application.js";

/** Where an answer can come from. The agent names the source; the server checks that it exists and whether the answer follows from it. */
export const PROFILE_FIELDS = ["fullName", "email", "phone", "location", "links", "languages", "workAuthorization", "noticePeriod", "requiresSponsorship"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type Check = "verified" | "unchecked" | "differs";
export interface CheckResult {
  check: Check;
  note?: string;
}

/** Lowercase, no accents, no punctuation, single spaces. */
export function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const digits = (s: string) => s.replace(/\D/g, "");
/** True when `needle` appears in `hay` as whole words ("male" is not inside "female"). Both already normalized. */
const containsWords = (hay: string, needle: string) => needle.length > 0 && ` ${hay} `.includes(` ${needle} `);
const bareUrl = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

/** First word as a yes or no, or undefined when it is neither. */
export function yesNo(s: string): boolean | undefined {
  const w = norm(s).split(" ")[0];
  if (w === "yes" || w === "y" || w === "true") return true;
  if (w === "no" || w === "n" || w === "false") return false;
  return undefined;
}

// Words that mean the same answer on a form. Short on purpose: anything not listed is "not checked", never "wrong".
const SAME: string[][] = [
  ["male", "man", "m"],
  ["female", "woman", "f"],
  ["non binary", "nonbinary", "non-binary", "genderqueer"],
  ["yes", "true", "y"],
  ["no", "false", "n"],
  ["prefer not to say", "decline to answer", "decline to self identify", "i do not wish to answer", "i prefer not to answer", "prefer not to disclose", "choose not to disclose"],
  ["white", "caucasian"],
  ["black or african american", "black", "african american", "african"],
  ["asian", "asian american"],
  ["hispanic or latino", "hispanic", "latino", "latina", "latinx"],
  ["no disability", "i do not have a disability", "i don t have a disability", "no i do not have a disability"],
  ["not a veteran", "i am not a veteran", "i am not a protected veteran", "no i am not a veteran"],
];
const sameGroup = (a: string): number => SAME.findIndex((g) => g.map(norm).includes(norm(a)));

const has = (s: string | undefined): s is string => !!s && s.trim().length > 0;

/** The text values a profile field allows an answer to be made from. */
function profileValues(p: Profile, field: ProfileField): string[] {
  switch (field) {
    case "fullName": {
      const parts = p.fullName.trim().split(/\s+/);
      return [p.fullName, parts[0]!, parts.at(-1)!, parts.slice(0, -1).join(" ")].filter(has);
    }
    case "email": return has(p.email) ? [p.email] : [];
    case "phone": return has(p.phone) ? [p.phone] : [];
    case "location": return has(p.location) ? [p.location, ...p.location.split(",").map((x) => x.trim())].filter(has) : [];
    case "links": return p.links;
    case "languages": return [...p.languages, p.languages.join(", ")].filter(has);
    case "workAuthorization": return has(p.workAuthorization) ? [p.workAuthorization] : [];
    case "noticePeriod": return has(p.noticePeriod) ? [p.noticePeriod] : [];
    case "requiresSponsorship": return p.requiresSponsorship === undefined ? [] : [p.requiresSponsorship ? "yes" : "no"];
  }
}

export type SourceError = { ok: false; problem: string };

/** What a cited source is, and whether it exists. */
export function resolveSources(
  from: string[] | undefined,
  kind: "profile" | "standard",
  ctx: { profile: Profile | null; standard: StandardAnswer[] },
): { ok: true; fields: ProfileField[]; labels: StandardAnswer[] } | SourceError {
  const fields: ProfileField[] = [];
  const labels: StandardAnswer[] = [];
  for (const raw of from ?? []) {
    const [type, ...rest] = raw.split(":");
    const name = rest.join(":").trim();
    if (kind === "profile" && type === "profile") {
      if (!PROFILE_FIELDS.includes(name as ProfileField)) return { ok: false, problem: `"${raw}" is not a profile field. Use one of: ${PROFILE_FIELDS.map((f) => `profile:${f}`).join(", ")}` };
      if (!ctx.profile || profileValues(ctx.profile, name as ProfileField).length === 0) return { ok: false, problem: `Your profile has nothing saved for ${name}, so it cannot be the source. Leave the question blank and list it` };
      fields.push(name as ProfileField);
    } else if (kind === "standard" && type === "standard") {
      const hit = ctx.standard.find((s) => s.label.toLowerCase() === name.toLowerCase());
      if (!hit) return { ok: false, problem: `There is no saved standard answer called "${name}". Saved: ${ctx.standard.map((s) => s.label).join("; ") || "none"}. Leave the question blank and list it if none fits` };
      labels.push(hit);
    }
  }
  if (kind === "profile" && fields.length === 0) return { ok: false, problem: `A profile answer must name where it comes from, in "from", such as ["profile:email"]. Fields: ${PROFILE_FIELDS.join(", ")}` };
  if (kind === "standard" && labels.length === 0) return { ok: false, problem: `A standard answer must name the saved answer it comes from, in "from", such as ["standard:How did you hear about us?"]` };
  return { ok: true, fields, labels };
}

/** Does this answer follow from the cited profile fields? Wrong answers are flagged, never refused. */
export function checkProfileAnswer(question: string, answer: string, fields: ProfileField[], p: Profile): CheckResult {
  const a = norm(answer);
  let unchecked: string | undefined;
  for (const field of fields) {
    if (field === "requiresSponsorship") {
      if (!/sponsor/i.test(question)) { unchecked = "This question is not about sponsorship, so your sponsorship setting cannot confirm the answer"; continue; }
      const given = yesNo(answer);
      if (given === undefined) { unchecked = "The answer is not a clear yes or no"; continue; }
      if (given === p.requiresSponsorship) return { check: "verified" };
      return { check: "differs", note: `Your profile says you ${p.requiresSponsorship ? "need" : "do not need"} sponsorship` };
    }
    for (const v of profileValues(p, field)) {
      if (field === "phone") {
        const x = digits(answer), y = digits(v);
        // The same number with or without the country code or a leading zero: compare the last nine digits.
        const k = Math.min(9, x.length, y.length);
        if (k >= 7 && x.slice(-k) === y.slice(-k)) return { check: "verified" };
      } else if (field === "links") {
        if (bareUrl(answer) === bareUrl(v)) return { check: "verified" };
      } else {
        const n = norm(v);
        if (n && (a === n || (n.length >= 4 && containsWords(a, n)) || (a.length >= 4 && containsWords(n, a)))) return { check: "verified" };
      }
    }
  }
  if (unchecked) return { check: "unchecked", note: unchecked };
  const shown = fields.flatMap((f) => profileValues(p, f)).slice(0, 2).join(" / ");
  return { check: "differs", note: `Your profile says: ${shown}` };
}

/** Does this answer follow from the cited saved answers? */
export function checkStandardAnswer(answer: string, labels: StandardAnswer[], options?: string[]): CheckResult {
  const a = norm(answer);
  if (options?.length && !options.some((o) => norm(o) === a)) {
    return { check: "differs", note: "That is not one of the form's options" };
  }
  let sawComparable = false;
  for (const s of labels) {
    const saved = norm(s.answer);
    if (a === saved || (saved.length >= 3 && containsWords(a, saved)) || (a.length >= 3 && containsWords(saved, a))) return { check: "verified" };
    const ga = sameGroup(answer), gs = sameGroup(s.answer);
    if (ga >= 0 && ga === gs) return { check: "verified" };
    const ya = yesNo(answer), ys = yesNo(s.answer);
    if (ya !== undefined && ys !== undefined) { if (ya === ys) return { check: "verified" }; sawComparable = true; }
    else if (ga >= 0 && gs >= 0) sawComparable = true;
  }
  const shown = labels.map((s) => `${s.label}: ${s.answer}`).slice(0, 2).join(" / ");
  return sawComparable
    ? { check: "differs", note: `Your saved answer says: ${shown}` }
    : { check: "unchecked", note: `Worded differently from your saved answer (${shown}); please read it` };
}

/** If the agent read the field back after filling it, the value on the page should be the answer. */
export function checkObserved(answer: string, observed: string | undefined): CheckResult | undefined {
  if (observed === undefined) return undefined;
  const a = norm(answer), o = norm(observed);
  if (a === o || (a.length >= 4 && containsWords(o, a))) return undefined;
  return { check: "differs", note: `The form shows "${observed.slice(0, 80)}" instead` };
}
