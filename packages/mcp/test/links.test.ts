import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkLinks, createAgentApi, createHumanApi, openDb, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

let db: DB;
let client: Client;

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
const job = (n: number, over: object = {}) => ({ title: `Engineer ${n}`, url: `https://acme.example/jobs/${n}`, ...over });

beforeEach(async () => {
  db = openDb(":memory:");
  createHumanApi(db).setPreferences({ roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 2, searchAnySite: true, batchSize: 3 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, { dataDir: mkdtempSync(join(tmpdir(), "jobhunt-links-")) }).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return () => client.close();
});

describe("links the user gave", () => {
  it("do not use the discovery limit, and have their own allowance", async () => {
    await call("add_candidate_job", job(1, { userProvided: true }));
    await call("add_candidate_job", job(2, { userProvided: true }));
    expect((await call("get_budget")).data).toEqual({ limit: 2, addedToday: 0, remaining: 2, userLinks: { limit: 3, addedToday: 2, remaining: 1 } });
    // the discovery limit of 2 is still all there for the agent's own finds
    expect((await call("add_candidate_job", job(3))).error).toBe(false);
    expect((await call("add_candidate_job", job(4))).error).toBe(false);
    const refused = await call("add_candidate_job", job(5));
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Daily discovery limit reached/);
  });

  it("are capped at the batch size a day, and a job already stored still comes back", async () => {
    for (const n of [1, 2, 3]) expect((await call("add_candidate_job", job(n, { userProvided: true }))).error).toBe(false);
    const over = await call("add_candidate_job", job(4, { userProvided: true }));
    expect(over.error).toBe(true);
    expect(over.text).toMatch(/capped at 3 a day/);
    const again = await call("add_candidate_job", job(1, { userProvided: true }));
    expect(again.error).toBe(false);
    expect(again.data.created).toBe(false);
  });

  it("are marked on the job, and the flag is not something the agent gets for its own finds", async () => {
    const r = await call("add_candidate_job", job(1, { userProvided: true }));
    const mine = await call("add_candidate_job", job(2));
    const row = (id: number) => (db.prepare("SELECT user_provided AS u FROM jobs WHERE id = ?").get(id) as { u: number }).u;
    expect(row(r.data.id)).toBe(1);
    expect(row(mine.data.id)).toBe(0);
    expect((await call("get_budget")).data.addedToday).toBe(1);
  });
});

describe("checking a pasted list", () => {
  it("says which links are new, known, rejected before, repeated or not links", () => {
    const agent = createAgentApi(db);
    const known = agent.addCandidateJob({ title: "Known", url: "https://acme.example/jobs/9?utm_source=x", canonicalUrl: "https://acme.example/jobs/9" });
    agent.logSkippedCandidate({ url: "https://acme.example/jobs/8", reason: "dead" });
    const r = checkLinks(db, ["https://acme.example/jobs/1", "https://acme.example/jobs/9", "https://acme.example/jobs/8", "https://acme.example/jobs/1?utm_source=y", "not a link", "ftp://x.y/z"]);
    expect(r.map((x) => x.known ?? "bad")).toEqual(["new", "job", "skipped", "job", "bad", "bad"]);
    expect(r[1]).toMatchObject({ jobId: known.id });
    expect(r[4]!.ok).toBe(false);
  });
});

describe("what the agent is told", () => {
  it("knows how to deal with a cookie banner and that a form's CAPTCHA does not stop it filling", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/Cookie banners are in the way/);
    expect(text).toMatch(/cookieBanners/);
    expect(text).toMatch(/Accept all/);
    expect(text).toMatch(/only about cookies|concerns cookies only/);
    expect(text).toMatch(/CAPTCHA that is part of a form is not a reason to leave the form unfilled/);
    expect(text).toMatch(/personal story the user.s facts do not contain is never invented/);
    expect(text).toMatch(/report_gap so the user can write the true story/);
  });
});

describe("accounts: what the agent can and cannot do", () => {
  it("asks for an account and learns only whether one exists", async () => {
    const job = await call("add_candidate_job", { title: "E", url: "https://acme.example/jobs/1" });
    const req = await call("request_account", { jobId: job.data.id, pageUrl: "https://acme.example/signup", mode: "signup", passwordRules: { minLength: 12, symbols: false }, fields: ["email", "password", "confirm password"] });
    expect(req.error).toBe(false);
    expect(req.data).toMatchObject({ site: "acme.example", alreadyOpen: false });
    expect((await call("request_account", { jobId: job.data.id, pageUrl: "https://acme.example/signup", mode: "signup" })).data.alreadyOpen).toBe(true);
    createHumanApi(db).createAccount({ site: "acme.example", username: "secret-person@example.com" });
    const st = await call("account_status", { pageUrl: "https://www.acme.example/login" });
    expect(st.data).toEqual({ site: "acme.example", exists: true, confirmed: false, verified: false });
    expect(st.text).not.toContain("secret-person");
  });

  it("has no tool that returns a username or a password", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of names) expect(n).not.toMatch(/password|credential|secret|vault|copy/i);
    expect(names).toEqual(expect.arrayContaining(["request_account", "account_status"]));
  });

  it("refuses a request with a bad mode or a layout key", async () => {
    expect((await call("request_account", { jobId: null, pageUrl: "https://acme.example/s", mode: "register" })).error).toBe(true);
    // an extra top-level key is ignored, never stored
    const extra = await call("request_account", { jobId: null, pageUrl: "https://extra.example/s", mode: "signup", password: "hunter2" });
    expect(extra.error).toBe(false);
    expect(JSON.stringify(db.prepare("SELECT payload FROM action_queue").all())).not.toContain("hunter2");
    expect((await call("request_account", { jobId: null, pageUrl: "https://acme.example/s", mode: "signup", passwordRules: { minLength: 12, password: "x" } })).error).toBe(true);
  });

  it("is told never to touch a password", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/never type, read, copy or screenshot a password field/);
    expect(text).toMatch(/request_account/);
  });
});
