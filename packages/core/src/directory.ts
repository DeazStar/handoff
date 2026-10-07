import type { DB } from "./db.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

/** A company from a public list. Every text field is data from the internet: show it, never follow it. */
export interface DirectoryCompany {
  name: string;
  website?: string;
  location?: string;
  oneLiner?: string;
  description?: string;
  industry?: string;
  teamSize?: number;
  /** fully: the list says it is fully remote. partly: partly remote or open to remote. Unset: the list does not say. */
  remoteHint?: "fully" | "partly";
  source: string;
  /** The company's id in that list (for YC, its slug), so a second import updates it instead of adding it again. */
  sourceRef: string;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

/** The website's host without www, or undefined when it is not an http(s) link. */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Adds companies, or updates the ones this list already added (matched by list id), or the ones already known by website. */
export function importDirectory(db: DB, rows: DirectoryCompany[], actor: Actor): ImportResult {
  const result: ImportResult = { added: 0, updated: 0, skipped: 0 };
  const bySourceRef = db.prepare("SELECT id FROM companies WHERE source = ? AND source_ref = ?");
  const byDomain = db.prepare("SELECT id, source FROM companies WHERE domain = ?");
  const insert = db.prepare(
    `INSERT INTO companies (name, domain, website, location, one_liner, description, industry, team_size, remote_hint, source, source_ref, discovered_via, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const update = db.prepare(
    `UPDATE companies SET website = ?, location = ?, one_liner = ?, description = ?, industry = ?, team_size = ?, remote_hint = ?,
       source = COALESCE(source, ?), source_ref = COALESCE(source_ref, ?), collected_at = datetime('now') WHERE id = ?`,
  );
  db.transaction(() => {
    for (const r of rows) {
      const name = text(r.name, 200);
      const sourceRef = text(r.sourceRef, 200);
      if (!name || !sourceRef || !text(r.source, 40)) { result.skipped++; continue; }
      const website = domainOf(r.website) ? r.website!.trim().slice(0, 500) : undefined;
      const domain = domainOf(r.website);
      const f = [
        website ?? null,
        text(r.location, 300) ?? null,
        text(r.oneLiner, 300) ?? null,
        text(r.description, 1500) ?? null,
        text(r.industry, 100) ?? null,
        Number.isInteger(r.teamSize) && r.teamSize! >= 0 ? r.teamSize! : null,
        r.remoteHint === "fully" || r.remoteHint === "partly" ? r.remoteHint : null,
      ];
      let id = (bySourceRef.get(r.source, sourceRef) as { id: number } | undefined)?.id;
      if (id === undefined && domain) {
        const known = byDomain.get(domain) as { id: number; source: string | null } | undefined;
        // A company another list already added keeps that list's data; a company found through a job gets filled in.
        if (known && known.source && known.source !== r.source) { result.skipped++; continue; }
        id = known?.id;
      }
      if (id !== undefined) {
        update.run(...f, r.source, sourceRef, id);
        result.updated++;
      } else {
        insert.run(name, domain ?? null, ...f, r.source, sourceRef, r.source);
        result.added++;
      }
    }
    logEvent(db, actor, "directory_imported", null, { source: rows[0]?.source, ...result });
  })();
  return result;
}

export interface DirectoryRow {
  id: number;
  name: string;
  website?: string;
  location?: string;
  oneLiner?: string;
  industry?: string;
  teamSize?: number;
  remoteHint?: "fully" | "partly";
  source?: string;
  careersStatus: "unknown" | "found" | "none";
  careersUrl?: string;
  careersNote?: string;
  verdict: Verdict;
  verdictReason?: string;
  verdictBy?: "agent" | "user";
  verdictAt?: string;
}

export type Verdict = "unreviewed" | "potential" | "discarded";
export const VERDICTS: Verdict[] = ["unreviewed", "potential", "discarded"];

export interface DirectoryFilter {
  q?: string;
  remote?: boolean;
  source?: string;
  careersStatus?: "unknown" | "found" | "none";
  verdict?: Verdict;
  ids?: number[];
  limit?: number;
}

export function listDirectory(db: DB, f: DirectoryFilter = {}): DirectoryRow[] {
  const where: string[] = ["c.source IS NOT NULL"];
  const args: unknown[] = [];
  if (f.q?.trim()) {
    where.push("(c.name LIKE ? ESCAPE '\\' OR c.one_liner LIKE ? ESCAPE '\\' OR c.industry LIKE ? ESCAPE '\\')");
    const like = `%${f.q.trim().replace(/[\\%_]/g, "\\$&")}%`;
    args.push(like, like, like);
  }
  if (f.remote) where.push("c.remote_hint IS NOT NULL");
  if (f.source) { where.push("c.source = ?"); args.push(f.source); }
  if (f.careersStatus) { where.push("c.careers_status = ?"); args.push(f.careersStatus); }
  if (f.ids) { where.push(`c.id IN (${f.ids.map(() => "?").join(",") || "NULL"})`); args.push(...f.ids); }
  if (f.verdict) { where.push("c.verdict = ?"); args.push(f.verdict); }
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 200), 1), 1000);
  const rows = db
    .prepare(`SELECT * FROM companies c WHERE ${where.join(" AND ")} ORDER BY (c.remote_hint = 'fully') DESC, c.name COLLATE NOCASE LIMIT ?`)
    .all(...args, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    website: r.website ?? undefined,
    location: r.location ?? undefined,
    oneLiner: r.one_liner ?? undefined,
    industry: r.industry ?? undefined,
    teamSize: r.team_size ?? undefined,
    remoteHint: r.remote_hint ?? undefined,
    source: r.source ?? undefined,
    careersStatus: r.careers_status,
    careersUrl: r.careers_url ?? undefined,
    careersNote: r.careers_note ?? undefined,
    verdict: r.verdict,
    verdictReason: r.verdict_reason ?? undefined,
    verdictBy: r.verdict_by ?? undefined,
    verdictAt: r.verdict_at ?? undefined,
  }));
}

export interface DirectoryStats {
  total: number;
  bySource: { source: string; companies: number; remote: number }[];
  careers: { unknown: number; found: number; none: number };
  verdicts: { unreviewed: number; potential: number; discarded: number };
  /** Companies with a career page that no one has judged: what /scout works through. */
  readyToScout: number;
  /** Companies the career-page finder has not looked at yet. */
  notSearched: number;
}

export function directoryStats(db: DB): DirectoryStats {
  const bySource = db
    .prepare("SELECT source, COUNT(*) AS companies, SUM(remote_hint IS NOT NULL) AS remote FROM companies WHERE source IS NOT NULL GROUP BY source ORDER BY companies DESC")
    .all() as DirectoryStats["bySource"];
  const c = db
    .prepare("SELECT careers_status AS s, COUNT(*) AS n FROM companies WHERE source IS NOT NULL GROUP BY careers_status")
    .all() as { s: "unknown" | "found" | "none"; n: number }[];
  const careers = { unknown: 0, found: 0, none: 0 };
  for (const r of c) careers[r.s] = r.n;
  const verdicts = { unreviewed: 0, potential: 0, discarded: 0 };
  for (const r of db.prepare("SELECT verdict AS v, COUNT(*) AS n FROM companies WHERE source IS NOT NULL GROUP BY verdict").all() as { v: Verdict; n: number }[]) verdicts[r.v] = r.n;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    total: bySource.reduce((n, s) => n + s.companies, 0),
    bySource,
    careers,
    verdicts,
    readyToScout: count(`SELECT COUNT(*) AS n FROM companies WHERE ${SCOUT_WHERE}`),
    notSearched: count("SELECT COUNT(*) AS n FROM companies WHERE source IS NOT NULL AND website IS NOT NULL AND careers_status = 'unknown' AND careers_checked_at IS NULL"),
  };
}

// What /scout works on: a career page we have, or one the code could not read and a browser must.
const SCOUT_WHERE = `source IS NOT NULL AND verdict = 'unreviewed' AND (careers_status = 'found' OR (careers_status = 'unknown' AND careers_note LIKE 'needs browser%'))`;

/** The next companies for /scout: fully remote first, then in the order they were collected. */
export function listScoutCompanies(db: DB, limit: number): DirectoryRow[] {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const ids = (db.prepare(`SELECT id FROM companies WHERE ${SCOUT_WHERE} ORDER BY (remote_hint = 'fully') DESC, id LIMIT ?`).all(n) as { id: number }[]).map((r) => r.id);
  if (!ids.length) return [];
  return listDirectory(db, { ids }).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/**
 * Judges a company. The agent may say potential (it needs at least one live-or-pending job of this company, so the verdict rests on something)
 * or discarded (it needs a reason naming what did not fit). The agent cannot change a verdict the user set. The user can set any verdict;
 * unreviewed puts the company back in the queue.
 */
export function setCompanyVerdict(db: DB, companyId: number, verdict: Verdict, reason: string | undefined, actor: Actor): void {
  if (!VERDICTS.includes(verdict)) throw new Error("verdict must be unreviewed, potential or discarded");
  const row = db.prepare("SELECT verdict, verdict_by FROM companies WHERE id = ? AND source IS NOT NULL").get(companyId) as { verdict: Verdict; verdict_by: string | null } | undefined;
  if (!row) throw new Error(`Company ${companyId} is not in the company list`);
  const why = reason?.trim().slice(0, 500);
  if (actor !== "human") {
    if (verdict === "unreviewed") throw new Error("Only the user can put a company back to unreviewed");
    if (row.verdict_by === "user") throw new Error("The user already judged this company; leave their verdict alone");
    if (!why || why.length < 15) throw new Error("Give a reason of at least 15 characters: for potential, the opening that fits; for discarded, what did not fit");
    if (verdict === "potential") {
      const jobs = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND state NOT IN ('dead','skipped')").get(companyId) as { n: number }).n;
      if (jobs === 0) throw new Error("A potential company needs at least one of its jobs added first (add_candidate_job with this companyId)");
    }
  }
  const by = actor === "human" ? "user" : "agent";
  db.prepare("UPDATE companies SET verdict = ?, verdict_reason = ?, verdict_by = ?, verdict_at = datetime('now') WHERE id = ?").run(
    verdict,
    verdict === "unreviewed" ? null : why ?? null,
    verdict === "unreviewed" ? null : by,
    companyId,
  );
  logEvent(db, actor, "company_verdict", null, { companyId, verdict, reason: why });
}
