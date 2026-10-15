import type { DB } from "./db.js";
import { siteOf } from "./accounts.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

export interface SiteProfile {
  site: string;
  complete: boolean;
  /** What showed it: the user said so, or Claude saw the site open the application when it clicked Apply. */
  source: "user" | "agent";
  evidence?: string;
  updatedAt: string;
}

const toProfile = (r: any): SiteProfile => ({ site: r.site, complete: r.complete === 1, source: r.source, evidence: r.evidence ?? undefined, updatedAt: r.updated_at });

/** What is known about a site's candidate profile. Undefined means nobody has checked. */
export function getSiteProfile(db: DB, site: string): SiteProfile | undefined {
  const r = db.prepare("SELECT * FROM site_profiles WHERE site = ?").get(siteOf(site));
  return r ? toProfile(r) : undefined;
}

export function listSiteProfiles(db: DB): SiteProfile[] {
  return (db.prepare("SELECT * FROM site_profiles ORDER BY site").all() as any[]).map(toProfile);
}

/**
 * Records that a site's profile is finished, or not. The user can always say so. The agent may only record what it saw:
 * "complete" needs a line of evidence (for example "clicked Apply and the application message box opened"), and "incomplete"
 * is recorded when clicking Apply sent it to the profile setup. The record only decides whether the agent asks again; it opens or sends nothing.
 */
export function setSiteProfile(db: DB, site: string, complete: boolean, evidence: string | undefined, actor: Actor): SiteProfile {
  const s = siteOf(site);
  const source = actor === "human" ? "user" : "agent";
  const note = evidence?.trim().slice(0, 300);
  if (actor !== "human" && complete && (!note || note.length < 10)) throw new Error("Say what showed it: for example 'clicked Apply and the application message box opened'");
  db.prepare("INSERT INTO site_profiles (site, complete, source, evidence) VALUES (?, ?, ?, ?) ON CONFLICT(site) DO UPDATE SET complete = excluded.complete, source = excluded.source, evidence = excluded.evidence, updated_at = datetime('now')").run(s, complete ? 1 : 0, source, note ?? null);
  if (complete) {
    // The profile cards for this site are no longer needed.
    const cards = db.prepare("SELECT id, payload FROM action_queue WHERE kind = 'signup_needed' AND status = 'open'").all() as { id: number; payload: string }[];
    for (const c of cards) {
      const p = JSON.parse(c.payload) as { site?: string; mode?: string };
      if (p.mode === "profile" && p.site && siteOf(p.site) === s) db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE id = ?").run(c.id);
    }
  }
  logEvent(db, actor, complete ? "site_profile_complete" : "site_profile_incomplete", null, { site: s });
  return getSiteProfile(db, s)!;
}
