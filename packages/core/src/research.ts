import type { DB } from "./db.js";
import { listContacts, type Contact } from "./email.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

export interface Person {
  id: number;
  companyId: number;
  name: string;
  role: string;
  sourceUrl: string;
}

const toPerson = (r: any): Person => ({ id: r.id, companyId: r.company_id, name: r.name, role: r.role, sourceUrl: r.source_url });

/**
 * Records a decision maker found on a page. The caller has checked the name really is on that page.
 * The same name at the same company is updated, not repeated.
 */
export function addPerson(db: DB, p: { companyId: number; name: string; role: string; sourceUrl: string }, actor: Actor): number {
  const name = p.name.trim().replace(/\s+/g, " ");
  const role = p.role.trim();
  if (!name || !role) throw new Error("A person needs a name and a role");
  if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(p.companyId)) throw new Error(`Company ${p.companyId} not found`);
  let url: string;
  try { url = new URL(p.sourceUrl).toString(); } catch { throw new Error("A person needs the page they were found on"); }
  db.prepare(
    `INSERT INTO people (company_id, name, role, source_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(company_id, name) DO UPDATE SET role = excluded.role, source_url = excluded.source_url, found_at = datetime('now')`,
  ).run(p.companyId, name, role.slice(0, 100), url);
  const row = db.prepare("SELECT id FROM people WHERE company_id = ? AND name = ?").get(p.companyId, name) as { id: number };
  logEvent(db, actor, "person_added", null, { id: row.id, companyId: p.companyId });
  return row.id;
}

export function listPeople(db: DB, companyId: number): Person[] {
  return db.prepare("SELECT * FROM people WHERE company_id = ? ORDER BY id").all(companyId).map(toPerson);
}

export interface CompanyResearch {
  companyId: number;
  name: string;
  domain?: string;
  /** When the company's own pages were last searched. Empty means they have not been. */
  researchedAt?: string;
  people: Person[];
  contacts: Contact[];
}

export function getCompanyResearch(db: DB, companyId: number): CompanyResearch | null {
  const c = db.prepare("SELECT id, name, domain, researched_at FROM companies WHERE id = ?").get(companyId) as any;
  if (!c) return null;
  return { companyId: c.id, name: c.name, domain: c.domain ?? undefined, researchedAt: c.researched_at ?? undefined, people: listPeople(db, companyId), contacts: listContacts(db, companyId) };
}

/** Marks the company's pages as searched, so the same pages are not opened again for its next job. */
export function markCompanyResearched(db: DB, companyId: number, actor: Actor): void {
  const info = db.prepare("UPDATE companies SET researched_at = datetime('now') WHERE id = ?").run(companyId);
  if (info.changes === 0) throw new Error(`Company ${companyId} not found`);
  logEvent(db, actor, "company_researched", null, { companyId });
}
