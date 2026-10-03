import type { DB } from "./db.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

export interface Profile {
  fullName: string;
  email?: string;
  phone?: string;
  location?: string;
  links: string[];
  workAuthorization?: string;
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
}

/** Profile, facts and preferences are the user's own truth. The agent reads them, never writes them. */
export function requireHuman(actor: Actor, what: string): void {
  if (actor !== "human") throw new Error(`Only the user can change ${what}`);
}

export function getProfile(db: DB): Profile | null {
  const r = db.prepare("SELECT * FROM profile WHERE id = 1").get() as Record<string, string | null> | undefined;
  if (!r) return null;
  return {
    fullName: r.full_name as string,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    location: r.location ?? undefined,
    links: JSON.parse(r.links as string),
    workAuthorization: r.work_authorization ?? undefined,
    noticePeriod: r.notice_period ?? undefined,
    languages: JSON.parse(r.languages as string),
  };
}

export function setProfile(db: DB, p: Profile, actor: Actor): void {
  requireHuman(actor, "the profile");
  if (!p.fullName.trim()) throw new Error("Profile needs a name");
  db.prepare(
    `INSERT INTO profile (id, full_name, email, phone, location, links, work_authorization, notice_period, languages)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       full_name = excluded.full_name, email = excluded.email, phone = excluded.phone,
       location = excluded.location, links = excluded.links,
       work_authorization = excluded.work_authorization, notice_period = excluded.notice_period,
       languages = excluded.languages, updated_at = datetime('now')`,
  ).run(
    p.fullName.trim(),
    p.email ?? null,
    p.phone ?? null,
    p.location ?? null,
    JSON.stringify(p.links),
    p.workAuthorization ?? null,
    p.noticePeriod ?? null,
    JSON.stringify(p.languages),
  );
  logEvent(db, actor, "profile_updated", null);
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
  for (const [name, n, max] of [
    ["dailyApplicationLimit", p.dailyApplicationLimit, 100],
    ["dailyDiscoveryLimit", p.dailyDiscoveryLimit, 200],
  ] as const) {
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} must be a whole number from 0 to ${max}`);
  }
  db.prepare(
    `INSERT INTO preferences (id, roles, seniority, locations, remote_policy, industries, exclusions,
       salary_floor, salary_target, salary_ceiling, currency, daily_application_limit, daily_discovery_limit, search_any_site)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       roles = excluded.roles, seniority = excluded.seniority, locations = excluded.locations,
       remote_policy = excluded.remote_policy, industries = excluded.industries,
       exclusions = excluded.exclusions, salary_floor = excluded.salary_floor,
       salary_target = excluded.salary_target, salary_ceiling = excluded.salary_ceiling,
       currency = excluded.currency, daily_application_limit = excluded.daily_application_limit,
       daily_discovery_limit = excluded.daily_discovery_limit, search_any_site = excluded.search_any_site,
       updated_at = datetime('now')`,
  ).run(
    JSON.stringify(p.roles),
    JSON.stringify(p.seniority),
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
  );
  logEvent(db, actor, "preferences_updated", null);
}
