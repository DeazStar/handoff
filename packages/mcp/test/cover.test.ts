import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addFact, createAgentApi, openDb, saveDocument, setPreferences, setProfile, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

const H = "human" as const;
let db: DB;
let client: Client;
let dataDir: string;
let uploadDir: string;
let jobId: number;
let companyId: number;
let contactId: number;
let fact: number;

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

const P1 = "I am writing about the Backend Engineer role. Your posting asks for someone who can design and run payment services, and that is the work I have done for most of my career. I built a payments API serving 50000 users, and I own what I build from design through to production support, including the late night incidents that come with it.";
const P2 = "What draws me to Acme is the focus on reliable infrastructure. I like small teams where one engineer can see a change from the first sketch to the customer using it, and I would bring that habit of finishing things, writing down decisions and keeping systems simple enough that the next person can understand them quickly.";
const P3 = "I would welcome the chance to talk about how I could help your team. Thank you for your time and for considering my application.";
const plan = (over: object[] = []) => ({ paragraphs: [{ text: P1, factIds: [fact] }, { text: P2, factIds: [] }, { text: P3, factIds: [] }, ...over].slice(0, 4) });

async function connect(prefs: object = {}) {
  setPreferences(db, { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...prefs }, H);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir, uploadDir }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
}

beforeEach(async () => {
  db = openDb(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "jobhunt-cover-"));
  uploadDir = mkdtempSync(join(tmpdir(), "jobhunt-cover-up-"));
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "0911", location: "Addis Ababa, Ethiopia", links: ["https://ada.dev"], languages: [] }, H);
  const agent = createAgentApi(db);
  companyId = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
  jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId }).id;
  fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  contactId = agent.addContact({ companyId, email: "jane@acme.example", name: "Jane Doe", role: "Head of Engineering", sourceUrl: "https://acme.example/team" });
  agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "email");
  saveDocument(db, { jobId, kind: "cv", path: "documents/job-1-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
  agent.transitionJob(jobId, "materials_ready");
  await connect();
  return () => client.close();
});

describe("writing a cover letter", () => {
  it("gives the material to write from", async () => {
    const r = await call("get_cover_material", { jobId });
    expect(r.data).toMatchObject({ job: { title: "Backend Engineer", company: "Acme", route: "email" }, mode: "auto" });
    expect(r.data.namedContacts).toEqual([expect.objectContaining({ name: "Jane Doe" })]);
    expect(r.data.existing).toBeUndefined();
  });

  it("saves a PDF, numbers the versions, and addresses the contact", async () => {
    const r = await call("save_cover_letter", { jobId, contactId, plan: plan() });
    expect(r.error).toBe(false);
    expect(r.data).toMatchObject({ version: 1, pages: 1 });
    expect(readFileSync(join(dataDir, "documents", `job-${jobId}-cover-v1.pdf`)).subarray(0, 5).toString()).toBe("%PDF-");
    const again = await call("save_cover_letter", { jobId, plan: plan() });
    expect(again.data.version).toBe(2);
    const doc = db.prepare("SELECT content FROM documents WHERE id = ?").get(r.data.documentId) as { content: string };
    expect(JSON.parse(doc.content)[0].text).toBe("Dear Jane,");
    expect((await call("get_cover_material", { jobId })).data.existing.version).toBe(2);
  });

  it("refuses an invented number and writes no file", async () => {
    const bad = plan();
    bad.paragraphs[0] = { text: P1.replace("50000", "90000"), factIds: [fact] };
    const r = await call("save_cover_letter", { jobId, plan: bad });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/"90000" does not appear/);
    expect(existsSync(join(dataDir, "documents", `job-${jobId}-cover-v1.pdf`))).toBe(false);
    expect((await call("get_cover_material", { jobId })).data.existing).toBeUndefined();
  });

  it("refuses layout keys and a letter with too few paragraphs", async () => {
    expect((await call("save_cover_letter", { jobId, plan: { ...plan(), fontSize: 20 } })).error).toBe(true);
    expect((await call("save_cover_letter", { jobId, plan: { paragraphs: [{ text: P1, factIds: [fact] }] } })).error).toBe(true);
  });
});

describe("the email needs its cover letter", () => {
  const draft = () => call("draft_email", { jobId, contactId, blocks: [
    { text: "Dear Jane,", factIds: [], kind: "boilerplate" },
    { text: "I built a payments API serving 50000 users; my CV and cover letter are attached.", factIds: [fact] },
    { text: "Best regards,", factIds: [], kind: "boilerplate" },
  ] });

  it("refuses a draft until the cover letter exists, then attaches it", async () => {
    const early = await draft();
    expect(early.error).toBe(true);
    expect(early.text).toMatch(/Write the cover letter first/);
    const saved = await call("save_cover_letter", { jobId, contactId, plan: plan() });
    const ok = await draft();
    expect(ok.error).toBe(false);
    const row = db.prepare("SELECT cover_document_id AS c FROM emails WHERE id = ?").get(ok.data.emailId) as { c: number };
    expect(row.c).toBe(saved.data.documentId);
  });

  it("does not need one when cover letters are off", async () => {
    await client.close();
    await connect({ coverLetters: "off" });
    expect((await call("get_cover_material", { jobId })).data.mode).toBe("off");
    expect((await draft()).error).toBe(false);
  });
});

describe("a cover letter for a form", () => {
  it("returns the text and a PDF copy, and never touches the CV copy", async () => {
    await call("save_cover_letter", { jobId, plan: plan() });
    const r = await call("get_cover_letter", { jobId });
    expect(r.error).toBe(false);
    expect(r.data.text.startsWith("Dear Hiring Team,")).toBe(true);
    expect(r.data.text.endsWith("Sincerely,\n\nAda Lovelace")).toBe(true);
    expect(r.data.file.endsWith("Ada-Lovelace-Cover-Letter.pdf")).toBe(true);
    expect(readFileSync(r.data.file).subarray(0, 5).toString()).toBe("%PDF-");
    // The CV copy is made by get_application_material; asking for the letter must leave it alone.
    const dir = join(uploadDir, `job-${jobId}`);
    expect(readdirSync(dir)).toEqual(["Ada-Lovelace-Cover-Letter.pdf"]);
    await call("get_cover_letter", { jobId });
    expect(readdirSync(dir)).toEqual(["Ada-Lovelace-Cover-Letter.pdf"]);
  });

  it("keeps the letter's copy when the CV copy is made again, and the other way round", async () => {
    mkdirSync(join(dataDir, "documents"), { recursive: true });
    writeFileSync(join(dataDir, "documents", "job-1-cv-v1.pdf"), "%PDF-1.4 the cv");
    await call("save_cover_letter", { jobId, plan: plan() });
    await call("get_cover_letter", { jobId });
    const m = await call("get_application_material", { jobId });
    expect(m.data.coverLetter).toMatchObject({ version: 1 });
    expect(m.data.coverLetters).toBe("auto");
    const dir = join(uploadDir, `job-${jobId}`);
    expect(readdirSync(dir).sort()).toEqual(["Ada-Lovelace-CV.pdf", "Ada-Lovelace-Cover-Letter.pdf"]);
    await call("get_application_material", { jobId });
    expect(readdirSync(dir).sort()).toEqual(["Ada-Lovelace-CV.pdf", "Ada-Lovelace-Cover-Letter.pdf"]);
  });

  it("says so when there is no letter yet", async () => {
    const r = await call("get_cover_letter", { jobId });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/no cover letter/);
  });
});
