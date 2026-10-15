import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addFact, createAgentApi, createHumanApi, listOpenActions, openDb, saveDocument, setPreferences, setProfile, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

const H = "human" as const;
let db: DB;
let client: Client;
let dataDir: string;
let uploadDir: string;
let jobId: number;
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

beforeEach(async () => {
  db = openDb(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "jobhunt-form-"));
  uploadDir = mkdtempSync(join(tmpdir(), "jobhunt-upload-"));
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "0911", location: "Addis Ababa, Ethiopia", links: ["https://ada.dev"], languages: [], workAuthorization: "needs sponsorship", requiresSponsorship: true, noticePeriod: "1 week" }, H);
  setPreferences(db, { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, salaryFloor: 900, salaryTarget: 1400, salaryCeiling: 2000, currency: "USD", salaryPeriod: "month" }, H);
  createHumanApi(db).setStandardAnswer("How did you hear about us?", "The company website");
  const agent = createAgentApi(db);
  jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", applyUrl: "https://acme.example/apply" }).id;
  fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "form");
  mkdirSync(join(dataDir, "documents"), { recursive: true });
  writeFileSync(join(dataDir, "documents", "job-1-cv-v1.pdf"), "%PDF-1.4 the cv");
  saveDocument(db, { jobId, kind: "cv", path: "documents/job-1-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
  agent.transitionJob(jobId, "materials_ready");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir, uploadDir }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return () => client.close();
});

const answers = () => [
  { question: "Full name", answer: "Ada Lovelace", kind: "profile", from: ["profile:fullName"] },
  { question: "Do you need sponsorship?", answer: "Yes", kind: "profile", from: ["profile:requiresSponsorship"], sensitive: true },
  { question: "How did you hear about us?", answer: "The company website", kind: "standard", from: ["standard:How did you hear about us?"] },
  { question: "Why this role?", answer: "I built a payments API serving 50000 users.", kind: "free_text", factIds: [fact] },
];

describe("get_application_material", () => {
  it("gathers the profile, salary, standard answers and a properly named CV copy to upload", async () => {
    const r = await call("get_application_material", { jobId });
    expect(r.error).toBe(false);
    expect(r.data.job).toMatchObject({ title: "Backend Engineer", route: "form", applyUrl: "https://acme.example/apply" });
    expect(r.data.profile).toMatchObject({ fullName: "Ada Lovelace", workAuthorization: "needs sponsorship", noticePeriod: "1 week", phone: "0911" });
    expect(r.data.salary).toEqual({ floor: 900, target: 1400, ceiling: 2000, currency: "USD", period: "month" });
    expect(r.data.standardAnswers).toEqual([expect.objectContaining({ label: "How did you hear about us?", answer: "The company website" })]);
    expect(r.data.application).toBeNull();
    expect(r.data.cvUpload.file).toBe(join(uploadDir, "job-1", "Ada-Lovelace-CV.pdf"));
    expect(existsSync(r.data.cvUpload.file)).toBe(true);
    expect(readFileSync(r.data.cvUpload.file).toString()).toBe("%PDF-1.4 the cv");
  });

  it("keeps only the latest copy for a job, and never writes into the data folder", async () => {
    await call("get_application_material", { jobId });
    writeFileSync(join(uploadDir, "job-1", "stale-old-copy.pdf"), "old");
    const again = await call("get_application_material", { jobId });
    expect(readdirSync(join(uploadDir, "job-1"))).toEqual(["Ada-Lovelace-CV.pdf"]);
    expect(existsSync(join(dataDir, "documents", "upload"))).toBe(false);
    expect(again.data.cvUpload.file.startsWith(uploadDir)).toBe(true);
  });

  it("says what is missing", async () => {
    expect((await call("get_application_material", { jobId: 999 })).error).toBe(true);
    db.prepare("DELETE FROM documents WHERE kind = 'cv'").run();
    expect((await call("get_application_material", { jobId })).data.cvUpload).toMatch(/No CV yet/);
    const other = createAgentApi(db).addCandidateJob({ title: "x", url: "https://b.io/1", canonicalUrl: "https://b.io/1" }).id;
    saveDocument(db, { jobId: other, kind: "cv", path: "documents/missing.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    expect((await call("get_application_material", { jobId: other })).text).toMatch(/CV file is missing/);
  });
});

describe("prepare_application", () => {
  it("records the filled form for the user and sends nothing", async () => {
    const r = await call("prepare_application", {
      jobId, formUrl: "https://acme.example/apply/1", answers: answers(),
      leftBlank: [{ question: "Gender", why: "Optional demographic question" }, { question: "I agree to the terms", why: "Consent is the user's to give" }],
      salaryQuoted: 1400, salaryReason: "The target of the user's range for this seniority.",
    });
    expect(r.error).toBe(false);
    const app = createHumanApi(db).getApplication(jobId)!;
    expect(app).toMatchObject({ status: "prepared", salaryQuoted: 1400, salaryPeriod: "month" });
    expect(app.answers.map((a) => a.kind)).toEqual(["profile", "profile", "standard", "free_text"]);
    expect(app.leftBlank).toHaveLength(2);
    expect((listOpenActions(db) as any[]).map((a) => a.kind)).toEqual(["confirm_submit"]);
    expect((await call("get_job", { jobId })).data.job.state).toBe("awaiting_approval");
  });

  it("refuses an invented claim, a salary outside the range, and unknown fields", async () => {
    const bad = (over: object) => call("prepare_application", { jobId, formUrl: "https://acme.example/apply/1", answers: answers(), leftBlank: [], ...over });
    expect((await bad({ answers: [{ question: "Why?", answer: "I served 90000 users.", kind: "free_text", factIds: [fact] }] })).text).toMatch(/90000/);
    expect((await bad({ salaryQuoted: 300, salaryReason: "I thought it was fair." })).text).toMatch(/outside your range/);
    expect((await bad({ salaryQuoted: 1400 })).error).toBe(true); // no reason
    expect((await bad({ answers: [{ question: "Q", answer: "A", kind: "guess" }] })).error).toBe(true);
    expect((await bad({ answers: [{ question: "Q", answer: "A", kind: "profile", password: "hunter2" }] })).error).toBe(true); // no extra fields
    expect((await bad({ answers: [] })).error).toBe(true);
    expect(createHumanApi(db).getApplication(jobId)).toBeNull();
    expect(listOpenActions(db)).toHaveLength(0);
  });

  it("accepts a consent box as an answer kind, with the box's own wording", async () => {
    const r = await call("prepare_application", {
      jobId, formUrl: "https://acme.example/apply/1", leftBlank: [],
      answers: [...answers(), { question: "I consent to the processing of my data for this application", answer: "ticked", kind: "consent", sensitive: true }],
    });
    expect(r.error).toBe(false);
    expect(createHumanApi(db).getApplication(jobId)!.answers.at(-1)).toMatchObject({ kind: "consent", answer: "ticked" });
    const tool = (await client.listTools()).tools.find((t) => t.name === "prepare_application")!;
    expect(tool.description).toMatch(/ONLY when the user's command said `consent`/);
  });

  it("cannot submit: there is no tool for it, and nothing marks the form as sent", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_application_material", "prepare_application"]));
    expect(names.filter((n) => /submit|send|apply$|vault|password/i.test(n))).toEqual([]);
    await call("prepare_application", { jobId, formUrl: "https://acme.example/apply/1", answers: answers(), leftBlank: [] });
    expect(createHumanApi(db).getApplication(jobId)!.sentAt).toBeUndefined();
  });

  it("refuses an answer whose source does not exist, and flags one that differs from it", async () => {
    const bad = (answers: object[]) => call("prepare_application", { jobId, formUrl: "https://acme.example/apply/1", answers, leftBlank: [] });
    const noSource = await bad([{ question: "Email", answer: "ada@example.com", kind: "profile" }]);
    expect(noSource.error).toBe(true);
    expect(noSource.text).toMatch(/must name where it comes from/);
    expect((await bad([{ question: "Pronouns", answer: "she/her", kind: "standard", from: ["standard:Pronouns"] }])).text).toMatch(/no saved standard answer/);
    expect((await bad([{ question: "Phone", answer: "5550000", kind: "profile", from: ["profile:phone"], options: [] }])).error).toBe(false);
    const saved = (await call("get_job", { jobId })).data;
    expect(saved).toBeTruthy();
    expect(db.prepare("SELECT answers FROM applications WHERE job_id = ?").get(jobId)).toMatchObject({ answers: expect.stringContaining('"check":"differs"') });
  });
});

describe("refilling a lost form through the tools", () => {
  it("reads the stored answers, and records them again", async () => {
    const first = await call("prepare_application", { jobId, formUrl: "https://acme.example/apply/1", answers: answers(), leftBlank: [] });
    expect(first.error).toBe(false);
    const stored = await call("get_prepared_application", { jobId });
    expect(stored.error).toBe(false);
    expect(stored.data.formUrl).toBe("https://acme.example/apply/1");
    expect(stored.data.answers.map((a: any) => a.question)).toEqual(answers().map((a: any) => a.question));
    const again = await call("prepare_application", { jobId, formUrl: stored.data.formUrl, answers: stored.data.answers.map(({ check, checkNote, ...a }: any) => a), leftBlank: stored.data.leftBlank });
    expect(again.error).toBe(false);
    expect((await call("list_open_actions")).data.filter((a: any) => a.kind === "confirm_submit")).toHaveLength(1);
  });
  it("says so when nothing is waiting, and the agent has no way to discard a prepared form", async () => {
    expect((await call("get_prepared_application", { jobId })).text).toMatch(/no prepared form waiting/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /discard|submitted/.test(n))).toEqual([]);
    expect(client.getInstructions() ?? "").toMatch(/Never discard a prepared form yourself/);
  });
});
