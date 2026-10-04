import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addBullet, addEntry, openDb, setProfile, setSkillGroup, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

const H = "human" as const;
let db: DB;
let client: Client;
let dataDir: string;
let ids: { acme: number; beta: number; edu: number; a1: number; a2: number; b1: number; rust: number };

async function call(name: string, args: Record<string, unknown> = {}) {
  try {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let data: any = r.content[0]!.text;
    try { data = JSON.parse(data); } catch {}
    return { error: r.isError === true, text: r.content[0]!.text, data };
  } catch (e) {
    return { error: true, text: String(e), data: undefined as any };
  }
}

beforeEach(async () => {
  db = openDb(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "jobhunt-cv-"));
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] }, H);
  const acme = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Acme", startDate: "2022-03", endDate: "2024-01" }, H);
  const beta = addEntry(db, { kind: "work", title: "Engineer", organization: "Beta", startDate: "2020", isCurrent: true }, H);
  const edu = addEntry(db, { kind: "education", title: "BSc", organization: "AASTU", startDate: "2020", endDate: "2025" }, H);
  const a1 = addBullet(db, acme, "Built a payments API serving 50000 users", H);
  const a2 = addBullet(db, acme, "Cut query time by 40%", H);
  const b1 = addBullet(db, beta, "Maintained 12 services", H);
  setSkillGroup(db, "Backend", ["Node.js", "Rust"], H);
  const rust = (db.prepare("SELECT id FROM facts WHERE text = 'Rust'").get() as { id: number }).id;
  ids = { acme, beta, edu, a1, a2, b1, rust };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return () => client.close();
});

const job = async () => (await call("add_candidate_job", { title: "Backend Engineer", url: "https://acme.example/jobs/1" })).data.id as number;

describe("the user's weights are enforced on save_cv", () => {
  it("shows weights and guidance, and refuses a plan that ignores them", async () => {
    db.prepare("UPDATE cv_entries SET weight = 'lead' WHERE id = ?").run(ids.beta);
    db.prepare("INSERT INTO preferences (id, cv_guidance) VALUES (1, 'Prefer international client work.')").run();
    const m = (await call("get_cv_material")).data;
    expect(m.entries.find((e: any) => e.id === ids.beta).weight).toBe("lead");
    expect(m.guidance).toBe("Prefer international client work.");

    const wrongOrder = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [ids.a1] }, { entryId: ids.beta, bullets: [ids.b1] }] } });
    expect(wrongOrder.error).toBe(true);
    expect(wrongOrder.text).toMatch(/marked lead with this and must come before/);
    const missing = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [ids.a1] }] } });
    expect(missing.text).toMatch(/must be in the CV/);
    expect(existsSync(join(dataDir, "documents"))).toBe(false);
    const ok = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.beta, bullets: [ids.b1] }, { entryId: ids.acme, bullets: [ids.a1] }] } });
    expect(ok.error).toBe(false);
  });
});

describe("country priority on save_cv", () => {
  it("shows the priority and refuses a plan that breaks it", async () => {
    db.prepare("UPDATE cv_entries SET country = 'Ethiopia' WHERE id = ?").run(ids.acme);
    db.prepare("UPDATE cv_entries SET country = 'United States' WHERE id = ?").run(ids.beta);
    db.prepare("INSERT INTO preferences (id, country_priority) VALUES (1, ?)").run(JSON.stringify(["United States"]));
    const m = (await call("get_cv_material")).data;
    expect(m.countryPriority).toEqual(["United States"]);
    expect(m.entries.find((e: any) => e.id === ids.beta).country).toBe("United States");

    const wrong = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [ids.a1] }, { entryId: ids.beta, bullets: [ids.b1] }] } });
    expect(wrong.error).toBe(true);
    expect(wrong.text).toMatch(/country priority \(United States\) puts the second first/);
    const right = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.beta, bullets: [ids.b1] }, { entryId: ids.acme, bullets: [ids.a1] }] } });
    expect(right.error).toBe(false);
  });
});

describe("get_cv_material", () => {
  it("lists entries with fact ids to choose from", async () => {
    const m = (await call("get_cv_material")).data;
    expect(m.profile.fullName).toBe("Ada Lovelace");
    expect(m.entries.map((e: any) => e.title)).toEqual(["Backend Engineer", "Engineer", "BSc"]);
    expect(m.entries[0].bullets).toEqual([{ id: ids.a1, text: "Built a payments API serving 50000 users" }, { id: ids.a2, text: "Cut query time by 40%" }]);
    expect(m.skills[0]).toMatchObject({ group: "Backend" });
  });
});

describe("save_cv", () => {
  it("builds a PDF from a plan, keeps the file, and records the plan", async () => {
    const jobId = await job();
    const plan = {
      summary: [{ text: "Backend engineer who built a payments API serving 50000 users.", factIds: [ids.a1] }],
      experience: [{ entryId: ids.beta, bullets: [ids.b1] }, { entryId: ids.acme, bullets: [ids.a2, ids.a1] }],
      education: [{ entryId: ids.edu }],
      skills: [{ group: "Backend", factIds: [ids.rust] }],
    };
    const r = await call("save_cv", { jobId, plan });
    expect(r.error).toBe(false);
    expect(r.data).toMatchObject({ version: 1, pages: 1, path: `documents/job-${jobId}-cv-v1.pdf` });
    const file = readFileSync(join(dataDir, r.data.path));
    expect(file.subarray(0, 5).toString()).toBe("%PDF-");

    const doc = (await call("get_job", { jobId })).data.documents[0];
    expect(doc).toMatchObject({ kind: "cv", version: 1 });
    expect(doc.plan.experience[0].entryId).toBe(ids.beta);
    expect(doc.blocks.map((b: any) => b.text)).toContain("Cut query time by 40%");

    const again = await call("save_cv", { jobId, plan });
    expect(again.data.version).toBe(2);
  });

  it("refuses a bullet under the wrong job, and leaves no file behind", async () => {
    const r = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.beta, bullets: [ids.a1] }] } });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/belong to a different entry/);
    expect(existsSync(join(dataDir, "documents"))).toBe(false);
  });

  it("refuses an invented number and says which one", async () => {
    const r = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [{ text: "Built an API for 90000 users", factIds: [ids.a1] }] }] } });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/90000/);
  });

  it("refuses a CV that runs past two pages and tells the agent how long it was", async () => {
    for (let i = 0; i < 7; i++) {
      const e = addEntry(db, { kind: "work", title: `Role ${i}`, organization: "Org", startDate: "2000" }, H);
      for (let j = 0; j < 5; j++) addBullet(db, e, `Responsibility ${j} `.repeat(25).trim(), H);
    }
    const m = (await call("get_cv_material")).data;
    const experience = m.entries.filter((e: any) => e.kind === "work").map((e: any) => ({ entryId: e.id, bullets: e.bullets.map((b: any) => b.id).slice(0, 8) }));
    const r = await call("save_cv", { jobId: null, plan: { experience } });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/runs to \d+ pages and the limit is 2/);
    expect(existsSync(join(dataDir, "documents"))).toBe(false);
  });

  it("rejects a malformed plan before doing anything", async () => {
    expect((await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [] }] } })).error).toBe(true);
    // Layout is not the agent's to change: unknown keys are refused, not ignored.
    const layout = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [ids.a1] }], fontSize: 20 } });
    expect(layout.error).toBe(true);
    expect(layout.text).toMatch(/fontSize|Unrecognized/i);
    const inner = await call("save_cv", { jobId: null, plan: { experience: [{ entryId: ids.acme, bullets: [ids.a1], color: "red" }] } });
    expect(inner.error).toBe(true);
    expect(existsSync(join(dataDir, "documents"))).toBe(false);
  });

  it("is the only way to save a CV", async () => {
    const r = await call("save_document", { jobId: null, kind: "cv", path: "x.pdf", blocks: [{ text: "x", factIds: [ids.a1] }] });
    expect(r.error).toBe(true);
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
