import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addFact, createAgentApi, createHumanApi, getEmail, listOpenActions, openDb, saveDocument, setProfile, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

let db: DB;
let client: Client;
let facts: number;
let companyId: number;
let jobId: number;
let verifierCalls: { email: string; sourceUrl: string }[];

const verifier = async (i: { email: string; sourceUrl: string }) => {
  verifierCalls.push(i);
  // The fake "page" shows only jobs@acme.example.
  return i.email.toLowerCase() === "jobs@acme.example"
    ? ({ ok: true, email: i.email.toLowerCase() } as const)
    : ({ ok: false, reason: `${i.email} does not appear on ${i.sourceUrl}. Search again: never guess an address.` } as const);
};

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
  verifierCalls = [];
  const H = "human" as const;
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] }, H);
  const agent = createAgentApi(db);
  companyId = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
  jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId }).id;
  facts = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  agent.recordVerification(jobId, { result: "live" });
  agent.setMatch(jobId, 8, "fits");
  agent.setRoute(jobId, "email");
  saveDocument(db, { jobId, kind: "cv", path: "documents/job-1-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [facts] }] }, "agent");
  saveDocument(db, { jobId, kind: "cover", path: "documents/job-1-cover-v1.pdf", blocks: [{ text: "Dear Hiring Team,", factIds: [], kind: "boilerplate" }, { text: "I built a payments API serving 50000 users.", factIds: [facts] }] }, "agent");
  agent.transitionJob(jobId, "materials_ready");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir: mkdtempSync(join(tmpdir(), "jobhunt-email-")), verifier }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return () => client.close();
});

describe("finding a contact", () => {
  it("refuses a guessed address with a message that tells the agent to search again", async () => {
    const r = await call("add_contact", { companyId, email: "careers@acme.example", sourceUrl: "https://acme.example/careers" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Not added.*does not appear on https:\/\/acme.example\/careers. Search again/);
    expect((await call("list_contacts", { companyId })).data).toEqual([]);
  });

  it("stores a verified address, once, with the page it came from", async () => {
    const a = await call("add_contact", { companyId, email: "Jobs@Acme.example", name: "Hiring", sourceUrl: "https://acme.example/careers" });
    expect(a.error).toBe(false);
    expect(a.data.email).toBe("jobs@acme.example");
    const again = await call("add_contact", { companyId, email: "jobs@acme.example", sourceUrl: "https://acme.example/contact" });
    expect(again.data.contactId).toBe(a.data.contactId);
    const list = (await call("list_contacts", { companyId })).data;
    expect(list).toEqual([expect.objectContaining({ email: "jobs@acme.example", sourceUrl: "https://acme.example/careers", status: "ok", addedBy: "agent" })]);
    expect(verifierCalls).toHaveLength(2);
  });

  it("rejects bad input before verifying anything", async () => {
    expect((await call("add_contact", { companyId, email: "jobs@acme.example" })).error).toBe(true); // no source page
    expect((await call("add_contact", { companyId: 999, email: "jobs@acme.example", sourceUrl: "https://a.io" })).error).toBe(true);
  });

  it("records that none was found", async () => {
    expect((await call("no_contact_found", { jobId, detail: "Only a contact form" })).data).toEqual({ recorded: true });
    expect((await call("get_job", { jobId })).data.events[0]).toMatchObject({ type: "no_contact_found" });
    expect((await call("no_contact_found", { jobId: 999 })).error).toBe(true);
  });
});

describe("drafting", () => {
  const blocks = () => [
    { text: "Dear hiring team,", factIds: [], kind: "boilerplate" },
    { text: "I built a payments API serving 50000 users and would like to apply.", factIds: [facts] },
    { text: "Best regards,", factIds: [], kind: "boilerplate" },
  ];

  it("saves a draft for the user, and the agent has no way to send it", async () => {
    const contactId = (await call("add_contact", { companyId, email: "jobs@acme.example", sourceUrl: "https://acme.example/careers" })).data.contactId;
    const d = await call("draft_email", { jobId, contactId, blocks: blocks() });
    expect(d.error).toBe(false);
    const email = getEmail(db, d.data.emailId)!;
    expect(email).toMatchObject({ status: "draft", subject: "Application: Backend Engineer, Ada Lovelace" });
    expect(email.bodyText.endsWith("Best regards,\nAda Lovelace\nada@example.com")).toBe(true);
    expect((listOpenActions(db) as any[]).map((a) => a.kind)).toEqual(["approve_email"]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_contact", "draft_email", "no_contact_found", "list_contacts"]));
    expect(names.filter((n) => /send|smtp|vault|password/i.test(n))).toEqual([]);
  });

  it("refuses an invented number, a bounced address, and a second draft", async () => {
    const contactId = (await call("add_contact", { companyId, email: "jobs@acme.example", sourceUrl: "https://acme.example/careers" })).data.contactId;
    const invented = await call("draft_email", { jobId, contactId, blocks: [{ text: "I served 90000 users", factIds: [facts] }] });
    expect(invented.error).toBe(true);
    expect(invented.text).toMatch(/90000/);
    expect((await call("draft_email", { jobId, contactId, blocks: blocks(), subject: "Two\nlines" })).error).toBe(true);
    expect((await call("draft_email", { jobId, contactId, blocks: blocks() })).error).toBe(false);
    expect((await call("draft_email", { jobId, contactId, blocks: blocks() })).error).toBe(true); // job is now awaiting_approval
    createHumanApi(db).markContactBounced(contactId);
    createHumanApi(db).discardEmail(1);
    expect((await call("draft_email", { jobId, contactId, blocks: blocks() })).text).toMatch(/bounced/);
  });
});
