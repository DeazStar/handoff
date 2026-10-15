import { QUESTION_CATEGORIES, QUESTION_MODES, type QuestionCategory, type QuestionMode } from "./questions.js";
import { normalizeSeniority, SENIORITY_LABELS, SENIORITY_LEVELS } from "./levels.js";
import { PRIORITY_MODES, type PriorityMode } from "./priority.js";
import type { DB } from "./db.js";
import { requireCountry } from "./countries.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

export interface Profile {
  fullName: string;
  email?: string;
  phone?: string;
  location?: string;
  links: string[];
  workAuthorization?: string;
  /** True when the user needs a visa sponsored. Unset means not said, and a form's sponsorship question is then left blank. */
  requiresSponsorship?: boolean;
  noticePeriod?: string;
  languages: string[];
}

/** For roles, seniority, locations and industries, an empty list means "any". */
export interface Preferences {
  roles: string[];
  seniority: string[];
  locations: string[];
  remotePolicy: "any" | "remote" | "onsite" | "hybrid";
  industries: string[];
  exclusions: string[];
  salaryFloor?: number;
  salaryTarget?: number;
  salaryCeiling?: number;
  currency?: string;
  dailyApplicationLimit: number;
  /** Most new jobs one day's discovery may add. */
  dailyDiscoveryLimit: number;
  /** True: search Google and any company career page as well as the listed sites. False: only the listed sites. */
  searchAnySite: boolean;
  /** Free text about how tailored CVs should be built, e.g. "prefer international client work". */
  cvGuidance?: string;
  /** Countries, best first. Work from an earlier country is listed before work from a later one. */
  countryPriority?: string[];
  /** Send the user a copy of every email they send. Default true. */
  bccSelf?: boolean;
  /** What the Apply button starts with: tick no consent box, the privacy consent only, or every box needed to submit. */
  consentDefault?: "none" | "privacy" | "required";
  /** When a reply to a sent email is matched for certain (same thread), move the job to replied. Default on. */
  autoMarkReplied?: boolean;
  /** Days after sending with no reply before a follow-up is suggested. Default 7. */
  followUpDays?: number;
  /** Most follow-ups per application. Default 1. */
  maxFollowUps?: number;
  /** Days after applying with no reply before the job is marked no_response. 0 never does. Default 21. */
  noResponseDays?: number;
  /** Days a reply's text snippet is kept. Default 90. */
  replySnippetDays?: number;
  /** Check the mailbox for replies this often while the dashboard is open and the vault unlocked. 0 means only when asked. Default 0. */
  replyCheckMinutes?: number;
  /** How the agent asks for an answer only the user can give. batch: everything at the end, in one chat message, and as cards. chat: at once, in the chat. cards: only in Needs you. Default batch. */
  questionMode?: QuestionMode;
  /** A different way for one kind of question, or never (use the default or skip it). */
  questionOverrides?: Partial<Record<QuestionCategory, QuestionMode | "never">>;
  /** The level given to a skill that has none, when a site asks for one. Unset: the agent asks. */
  defaultSkillLevel?: "beginner" | "intermediate" | "advanced" | "expert";
  /** How the agent answers a cookie banner on a site it visits. accept: click "Accept all" so the page is not blocked. necessary: only strictly necessary cookies. Default accept. */
  cookieBanners?: "accept" | "necessary";
  /** auto: a cover letter for every email job and for forms that ask. off: none. Default auto. */
  coverLetters?: "auto" | "off";
  /** Free text about how cover letters should read, e.g. tone and what to lead with. */
  coverGuidance?: string;
  /** How everything written in the user's name should read, in their words. */
  writingStyle?: string;
  /** What ranks first: remote_first (worldwide remote on top), sponsored_first, or balanced. Default remote_first. */
  priorityMode?: PriorityMode;
  /** Whether the salary range is per month or per year. Needed before any salary is quoted on a form. */
  salaryPeriod?: "month" | "year";
  /** Search a company's own pages for decision makers when a job scores at least this (0 to 10). Default 7. */
  researchMinScore?: number;
  /** all: any job above the score. email_only: only jobs that apply by email. off: never. Default all. */
  researchScope?: "all" | "email_only" | "off";
  /** Most jobs one /tailor or /email run handles. Default 10. */
  batchSize?: number;
  /** Employment types (full_time, part_time, contract, freelance), best first. Used after country priority. */
  employmentPriority?: string[];
}

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "freelance"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Profile, facts and preferences are the user's own truth. The agent reads them, never writes them. */
export function requireHuman(actor: Actor, what: string): void {
  if (actor !== "human") throw new Error(`Only the user can change ${what}`);
}

export function getProfile(db: DB): Profile | null {
  const r = db.prepare("SELECT * FROM profile WHERE id = 1").get() as Record<string, any> | undefined;
  if (!r) return null;
  return {
    fullName: r.full_name as string,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    location: r.location ?? undefined,
    links: JSON.parse(r.links as string),
    workAuthorization: r.work_authorization ?? undefined,
    requiresSponsorship: r.requires_sponsorship === null || r.requires_sponsorship === undefined ? undefined : r.requires_sponsorship === 1,
    noticePeriod: r.notice_period ?? undefined,
    languages: JSON.parse(r.languages as string),
  };
}

export function setProfile(db: DB, p: Profile, actor: Actor): void {
  requireHuman(actor, "the profile");
  if (!p.fullName.trim()) throw new Error("Profile needs a name");
  db.prepare(
    `INSERT INTO profile (id, full_name, email, phone, location, links, work_authorization, notice_period, languages, requires_sponsorship)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       full_name = excluded.full_name, email = excluded.email, phone = excluded.phone,
       location = excluded.location, links = excluded.links,
       work_authorization = excluded.work_authorization, notice_period = excluded.notice_period,
       languages = excluded.languages, requires_sponsorship = excluded.requires_sponsorship, updated_at = datetime('now')`,
  ).run(
    p.fullName.trim(),
    p.email ?? null,
    p.phone ?? null,
    p.location ?? null,
    JSON.stringify(p.links),
    p.workAuthorization ?? null,
    p.noticePeriod ?? null,
    JSON.stringify(p.languages),
    p.requiresSponsorship === undefined ? null : p.requiresSponsorship ? 1 : 0,
  );
  logEvent(db, actor, "profile_updated", null);
}

/** Trimmed, no blanks, no repeats (ignoring case), order kept. */
function dedupeList(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map((c) => c.trim()).filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
}

/** Countries must come from the country list; typos are refused, not silently ignored. */
function cleanCountries(list: string[]): string[] {
  const seen = new Set<string>();
  return list
    .map((c) => c.trim())
    .filter(Boolean)
    .map(requireCountry)
    .filter((c) => !seen.has(c) && seen.add(c));
}

export function getPreferences(db: DB): Preferences | null {
  const r = db.prepare("SELECT * FROM preferences WHERE id = 1").get() as Record<string, any> | undefined;
  if (!r) return null;
  return {
    roles: JSON.parse(r.roles),
    seniority: JSON.parse(r.seniority),
    locations: JSON.parse(r.locations),
    remotePolicy: r.remote_policy,
    industries: JSON.parse(r.industries),
    exclusions: JSON.parse(r.exclusions),
    salaryFloor: r.salary_floor ?? undefined,
    salaryTarget: r.salary_target ?? undefined,
    salaryCeiling: r.salary_ceiling ?? undefined,
    currency: r.currency ?? undefined,
    dailyApplicationLimit: r.daily_application_limit,
    dailyDiscoveryLimit: r.daily_discovery_limit,
    searchAnySite: r.search_any_site === 1,
    cvGuidance: r.cv_guidance ?? undefined,
    countryPriority: JSON.parse(r.country_priority ?? "[]"),
    employmentPriority: JSON.parse(r.employment_priority ?? "[]"),
    bccSelf: r.bcc_self !== 0,
    salaryPeriod: r.salary_period ?? undefined,
    consentDefault: r.consent_default,
    priorityMode: r.priority_mode,
    coverLetters: r.cover_letters,
    cookieBanners: r.cookie_banners,
    defaultSkillLevel: r.default_skill_level ?? undefined,
    questionMode: r.question_mode,
    questionOverrides: JSON.parse(r.question_overrides ?? "{}"),
    autoMarkReplied: r.auto_mark_replied === 1,
    followUpDays: r.follow_up_days,
    maxFollowUps: r.max_follow_ups,
    noResponseDays: r.no_response_days,
    replySnippetDays: r.reply_snippet_days,
    replyCheckMinutes: r.reply_check_minutes,
    coverGuidance: r.cover_guidance ?? undefined,
    writingStyle: r.writing_style ?? undefined,
    researchMinScore: r.research_min_score,
    researchScope: r.research_scope,
    batchSize: r.batch_size,
  };
}

export function setPreferences(db: DB, p: Preferences, actor: Actor): void {
  requireHuman(actor, "preferences");
  const { salaryFloor: lo, salaryTarget: mid, salaryCeiling: hi } = p;
  const given = [lo, mid, hi].filter((n) => n !== undefined) as number[];
  if (given.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("Salary values must be non-negative integers");
  for (let i = 1; i < given.length; i++) {
    if (given[i]! < given[i - 1]!) throw new Error("Salary must satisfy floor <= target <= ceiling");
  }
  if (given.length > 0 && !p.currency) throw new Error("A currency is required when salary is set");
  if ((p.cvGuidance?.length ?? 0) > 1000) throw new Error("CV guidance can be at most 1000 characters");
  for (const [name, n, max] of [
    ["dailyApplicationLimit", p.dailyApplicationLimit, 100],
    ["dailyDiscoveryLimit", p.dailyDiscoveryLimit, 200],
  ] as const) {
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be a whole number from 0 to ${max}`);
  }
  const rs = p.researchMinScore ?? 7;
  if (!Number.isInteger(rs) || rs < 0 || rs > 10) throw new Error("researchMinScore must be a whole number from 0 to 10");
  if (!["all", "email_only", "off"].includes(p.researchScope ?? "all")) throw new Error("researchScope must be all, email_only or off");
  if (p.salaryPeriod !== undefined && !['month', 'year'].includes(p.salaryPeriod)) throw new Error("salaryPeriod must be month or year");
  if (p.consentDefault !== undefined && !["none", "privacy", "required"].includes(p.consentDefault)) throw new Error("consentDefault must be none, privacy or required");
  if (p.priorityMode !== undefined && !PRIORITY_MODES.includes(p.priorityMode)) throw new Error("priorityMode must be remote_first, sponsored_first or balanced");
  if (p.coverLetters !== undefined && !["auto", "off"].includes(p.coverLetters)) throw new Error("coverLetters must be auto or off");
  if ((p.coverGuidance?.length ?? 0) > 1000) throw new Error("Cover letter guidance can be at most 1000 characters");
  if ((p.writingStyle?.length ?? 0) > 1500) throw new Error("The writing style can be at most 1500 characters");
  const whole = (v: number | undefined, name: string, min: number, max: number) => {
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  };
  whole(p.followUpDays, "Follow up after (days)", 1, 90);
  whole(p.maxFollowUps, "Follow-ups per application", 0, 5);
  whole(p.noResponseDays, "No response after (days)", 0, 365);
  whole(p.replySnippetDays, "Keep reply text for (days)", 1, 3650);
  whole(p.replyCheckMinutes, "Check replies every (minutes)", 0, 1440);
  if (p.noResponseDays !== undefined && p.noResponseDays !== 0 && p.followUpDays !== undefined && p.noResponseDays < p.followUpDays) throw new Error("No response after must be later than follow up after");
  if (p.cookieBanners !== undefined && !["accept", "necessary"].includes(p.cookieBanners)) throw new Error("cookieBanners must be accept or necessary");
  if (p.defaultSkillLevel !== undefined && !["beginner", "intermediate", "advanced", "expert"].includes(p.defaultSkillLevel)) throw new Error("defaultSkillLevel must be beginner, intermediate, advanced or expert");
  const seniority = [...new Set(p.seniority.map((x) => {
    const n = normalizeSeniority(x);
    if (!n) throw new Error(`"${x}" is not a level. Choose from: ${SENIORITY_LEVELS.map((l) => SENIORITY_LABELS[l]).join(", ")}`);
    return n;
  }))];
  if (p.questionMode !== undefined && !QUESTION_MODES.includes(p.questionMode)) throw new Error("questionMode must be batch, chat or cards");
  const questionOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.questionOverrides ?? {})) {
    if (!(QUESTION_CATEGORIES as readonly string[]).includes(k)) throw new Error(`"${k}" is not a kind of question`);
    if (v === undefined) continue;
    if (![...QUESTION_MODES, "never"].includes(v as string)) throw new Error(`The way to ask about ${k} must be batch, chat, cards or never`);
    questionOverrides[k] = v as string;
  }
  const bs = p.batchSize ?? 10;
  if (!Number.isInteger(bs) || bs < 1 || bs > 20) throw new Error("batchSize must be a whole number from 1 to 20");
  const types = dedupeList(p.employmentPriority ?? []).map((t) => t.toLowerCase());
  const bad = types.find((t) => !EMPLOYMENT_TYPES.includes(t as EmploymentType));
  if (bad) throw new Error(`Employment priority can list full_time, part_time, contract and freelance, not "${bad}"`);
  db.prepare(
    `INSERT INTO preferences (id, roles, seniority, locations, remote_policy, industries, exclusions,
       salary_floor, salary_target, salary_ceiling, currency, daily_application_limit, daily_discovery_limit, search_any_site, cv_guidance, country_priority, employment_priority, bcc_self, research_min_score, research_scope, batch_size, salary_period, consent_default, priority_mode, cover_letters, cover_guidance, cookie_banners, default_skill_level, question_mode, question_overrides, auto_mark_replied, follow_up_days, max_follow_ups, no_response_days, reply_snippet_days, reply_check_minutes)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       roles = excluded.roles, seniority = excluded.seniority, locations = excluded.locations,
       remote_policy = excluded.remote_policy, industries = excluded.industries,
       exclusions = excluded.exclusions, salary_floor = excluded.salary_floor,
       salary_target = excluded.salary_target, salary_ceiling = excluded.salary_ceiling,
       currency = excluded.currency, daily_application_limit = excluded.daily_application_limit,
       daily_discovery_limit = excluded.daily_discovery_limit, search_any_site = excluded.search_any_site, cv_guidance = excluded.cv_guidance, country_priority = excluded.country_priority, employment_priority = excluded.employment_priority, bcc_self = excluded.bcc_self, research_min_score = excluded.research_min_score, research_scope = excluded.research_scope, batch_size = excluded.batch_size, salary_period = excluded.salary_period, consent_default = excluded.consent_default, priority_mode = excluded.priority_mode, cover_letters = excluded.cover_letters, cookie_banners = excluded.cookie_banners, default_skill_level = excluded.default_skill_level, question_mode = excluded.question_mode, question_overrides = excluded.question_overrides, cover_guidance = excluded.cover_guidance, auto_mark_replied = excluded.auto_mark_replied, follow_up_days = excluded.follow_up_days, max_follow_ups = excluded.max_follow_ups, no_response_days = excluded.no_response_days, reply_snippet_days = excluded.reply_snippet_days, reply_check_minutes = excluded.reply_check_minutes,
       updated_at = datetime('now')`,
  ).run(
    JSON.stringify(p.roles),
    JSON.stringify(seniority),
    JSON.stringify(p.locations),
    p.remotePolicy,
    JSON.stringify(p.industries),
    JSON.stringify(p.exclusions),
    lo ?? null,
    mid ?? null,
    hi ?? null,
    p.currency ?? null,
    p.dailyApplicationLimit,
    p.dailyDiscoveryLimit,
    p.searchAnySite === false ? 0 : 1,
    p.cvGuidance?.trim() || null,
    JSON.stringify(cleanCountries(p.countryPriority ?? [])),
    JSON.stringify(types),
    p.bccSelf === false ? 0 : 1,
    p.researchMinScore ?? 7,
    p.researchScope ?? "all",
    p.batchSize ?? 10,
    p.salaryPeriod ?? null,
    p.consentDefault ?? "none",
    p.priorityMode ?? "remote_first",
    p.coverLetters ?? "auto",
    p.coverGuidance?.trim() || null,
    p.cookieBanners ?? "accept",
    p.defaultSkillLevel ?? null,
    p.questionMode ?? "batch",
    JSON.stringify(questionOverrides),
    p.autoMarkReplied === false ? 0 : 1,
    p.followUpDays ?? 7,
    p.maxFollowUps ?? 1,
    p.noResponseDays ?? 21,
    p.replySnippetDays ?? 90,
    p.replyCheckMinutes ?? 0,
  );
  db.prepare("UPDATE preferences SET writing_style = ? WHERE id = 1").run(p.writingStyle?.trim() || null);
  logEvent(db, actor, "preferences_updated", null);
}

/**
 * Whether the user needs a visa sponsored. The setting wins. When it is not set, the work authorization text is read: "needs sponsorship"
 * means yes, "no sponsorship needed" means no, anything else is not said. The answer says where it came from.
 */
export function effectiveSponsorship(p: Pick<Profile, "requiresSponsorship" | "workAuthorization">): { value: boolean; from: "setting" | "work authorization text" } | undefined {
  if (p.requiresSponsorship !== undefined) return { value: p.requiresSponsorship, from: "setting" };
  const t = (p.workAuthorization ?? "").toLowerCase();
  if (/\b(no|not|without|doesn'?t|don'?t)\s+(?:\w+\s+){0,2}(?:need|require)\w*/.test(t) || /\b(no|without)\s+(?:visa\s+)?spons/.test(t)) return { value: false, from: "work authorization text" };
  if (/\b(need|needs|needing|require|requires|requiring)\b[^.;]{0,30}\bspons/.test(t)) return { value: true, from: "work authorization text" };
  return undefined;
}
