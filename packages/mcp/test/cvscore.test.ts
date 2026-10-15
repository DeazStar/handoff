import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { addBullet, addEntry, createAgentApi, openDb, setProfile, setSkillGroup, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

const H = "human" as const;
let db: DB;
let client: Client;
let jobId: number;
let entry: number;
let bullet: number;
let nodeSkill: number;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  let data: any = r.content[0]!.text;
  try { data = JSON.parse(data); } catch {}
  return { error: r.isError === true, text: r.content[0]!.text, data };
}

beforeEach(async () => {
  db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "+1 555 0100", links: [], languages: [] }, H);
  entry = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Acme", startDate: "2022-03", isCurrent: true }, H);
  bullet = addBullet(db, entry, "Built a payments API serving 50000 users with Node.js", H);
  setSkillGroup(db, "Backend", ["Node.js"], H);
  nodeSkill = (db.prepare("SELECT id FROM facts WHERE text = 'Node.js'").get() as { id: number }).id;
  jobId = createAgentApi(db).addCandidateJob({ title: "Backend Engineer", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir: mkdtempSync(join(tmpdir(), "jobhunt-score-")) }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

describe("save_cv with a headline and a summary, then score_cv", () => {
  const plan = () => ({
    headline: "Backend Engineer",
    summary: [{ text: "Backend engineer with 1+ years building Node.js services.", factIds: [nodeSkill] }],
    experience: [{ entryId: entry, bullets: [bullet] }],
    skills: [{ group: "Backend", factIds: [nodeSkill] }],
  });

  it("scores the latest CV and tells the agent what is missing", async () => {
    const saved = await call("save_cv", { jobId, plan: plan() });
    expect(saved.error).toBe(false);
    const s = await call("score_cv", { jobId, pages: saved.data.pages, keywords: [{ term: "Node.js", critical: true }, { term: "GraphQL", critical: true }, { term: "AWS" }] });
    expect(s.error).toBe(false);
    expect(s.data).toMatchObject({ documentId: saved.data.documentId, missing: ["GraphQL", "AWS"], parts: { formatting: 30 } });
    expect(s.data.issues.join(" ")).toMatch(/Critical keywords missing: GraphQL/);
  });

  it("refuses a first-person summary and asks for a CV before scoring", async () => {
    expect((await call("score_cv", { jobId, keywords: [{ term: "a" }, { term: "b" }, { term: "c" }] })).text).toMatch(/no CV yet/);
    const bad = plan();
    bad.summary = [{ text: "I build Node.js services.", factIds: [nodeSkill] }];
    expect((await call("save_cv", { jobId, plan: bad })).text).toMatch(/no first person/);
  });
});

describe("get_writing_guide by kind", () => {
  it("returns the CV summary shape with its examples, the cover letter rules, and the base guide", async () => {
    const cv = await call("get_writing_guide", { kind: "cv_summary" });
    expect(cv.data.kind).toBe("cv_summary");
    expect(cv.data.guide).toMatch(/Who and stack/);
    expect(cv.data.guide).toMatch(/Known for/);
    expect(cv.data.guide).toMatch(/model message/); // the base guide follows
    const letter = await call("get_writing_guide", { kind: "cover_letter" });
    expect(letter.data.guide).toMatch(/I'm applying for the <role> at <company>/);
    expect(letter.data.guide).toMatch(/Each employer appears once/);
    const message = await call("get_writing_guide", {});
    expect(message.data.kind).toBe("message");
    expect(message.data.guide).not.toMatch(/Who and stack/);
  });
});

describe("site profile tools", () => {
  it("lets the agent check, record what it saw, and refuses to ask for a finished profile", async () => {
    expect((await call("site_profile_status", { site: "https://www.workatastartup.com/jobs/1" })).data).toMatchObject({ complete: false, unknown: true });
    expect((await call("mark_site_profile", { site: "workatastartup.com", complete: true })).text).toMatch(/Say what showed it/);
    const ok = await call("mark_site_profile", { site: "workatastartup.com", complete: true, evidence: "clicked Apply and the application message box opened" });
    expect(ok.data).toMatchObject({ site: "ycombinator.com", complete: true });
    expect((await call("request_profile_fill", { jobId: null, pageUrl: "https://www.workatastartup.com/application" })).text).toMatch(/already marked complete/);
    await call("mark_site_profile", { site: "ycombinator.com", complete: false });
    expect((await call("request_profile_fill", { jobId: null, pageUrl: "https://www.workatastartup.com/application" })).error).toBe(false);
  });
});
