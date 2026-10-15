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
    expect((await call("get_budget")).data).toEqual({ limit: 2, addedToday: 0, remaining: 2, userLinks: { limit: 3, addedToday: 2, remaining: 1 }, applications: expect.objectContaining({ remaining: expect.any(Number) }) });
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

  it("can ask for a profile to be filled in, once, and has no way to fill it itself", async () => {
    const job = await call("add_candidate_job", { title: "E", url: "https://acme.example/jobs/2" });
    const r = await call("request_profile_fill", { jobId: job.data.id, pageUrl: "https://acme.example/profile", note: "Complete the candidate profile" });
    expect(r.error).toBe(false);
    expect(r.data).toMatchObject({ site: "acme.example", alreadyOpen: false });
    expect((await call("request_profile_fill", { jobId: job.data.id, pageUrl: "https://acme.example/profile" })).data.alreadyOpen).toBe(true);
    expect((await call("request_profile_fill", { jobId: null, pageUrl: "nope" })).error).toBe(true);
    const card = (db.prepare("SELECT payload FROM action_queue").all() as { payload: string }[]).map((x) => JSON.parse(x.payload)).find((p) => p.mode === "profile");
    expect(card).toMatchObject({ site: "acme.example", note: "Complete the candidate profile" });
  });

  it("is told never to touch a password", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/never type, read, copy or screenshot a password field/);
    expect(text).toMatch(/request_account/);
    expect(text).toMatch(/\/profile command/);
  });
});

describe("questions only the user can answer", () => {
  const OPTIONS = ["not interested in equity", "some equity at a promising company", "equity is very important"];
  it("asks once, with the page's options, and learns when the user has answered", async () => {
    const r = await call("ask_user", { jobId: null, question: "Equity preference", options: OPTIONS, site: "https://www.workatastartup.com/profile" });
    expect(r.error).toBe(false);
    expect(r.data.alreadyOpen).toBe(false);
    expect((await call("ask_user", { jobId: null, question: "Equity preference" })).data.alreadyOpen).toBe(true);
    createHumanApi(db).setStandardAnswer("Equity preference", OPTIONS[1]!);
    const again = await call("ask_user", { jobId: null, question: "Equity preference" });
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/already answered this/);
  });
  it("refuses a bad question and cannot answer for the user", async () => {
    expect((await call("ask_user", { jobId: null, question: "Q", options: ["one"] })).error).toBe(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("set_standard_answer");
    expect(names.filter((n) => /standard_answer/.test(n))).toEqual([]);
  });
  it("is told to ask instead of guess, and where a skill level comes from", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/call ask_user with the question/);
    expect(text).toMatch(/defaultSkillLevel in get_cv_material/);
  });
});

describe("keeping what the user said in chat", () => {
  it("proposes it, and the agent has no way to save it itself", async () => {
    const r = await call("remember", { jobId: null, type: "answer", label: "Equity preference", original: "some equity but not crucial", polished: "I would like some equity, but it is not crucial." });
    expect(r.error).toBe(false);
    expect(r.data.alreadyOpen).toBe(false);
    expect(createHumanApi(db).listStandardAnswers()).toEqual([]); // proposed, not saved
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /save_answer|set_standard|add_fact|save_fact/.test(n))).toEqual([]);
  });
  it("refuses polished wording with an invented number", async () => {
    const r = await call("remember", { jobId: null, type: "fact", kind: "achievement", original: "made it a lot faster", polished: "Made it 10x faster." });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/did not say/);
  });
  it("is told to polish without adding, to keep exact words when asked, and to propose saving", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/without adding anything they did not say/);
    expect(text).toMatch(/exact words/);
    expect(text).toMatch(/call remember/);
  });
});

describe("recording a job's level", () => {
  it("takes the level with the score, and refuses one that is not a level", async () => {
    const j = await call("add_candidate_job", { title: "Lead Engineer", url: "https://acme.example/jobs/77" });
    await call("record_verification", { jobId: j.data.id, result: "live" });
    expect((await call("set_match", { jobId: j.data.id, score: 6, reason: "fits", seniority: "lead" })).error).toBe(false);
    expect((await call("get_job", { jobId: j.data.id })).data.job.seniority).toBe("lead");
    expect((await call("set_match", { jobId: j.data.id, score: 6, reason: "fits", seniority: "minor" })).error).toBe(true);
  });
});

describe("the agent is told how to ask", () => {
  it("knows the four ways, batches by default and reads the user's choice", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toMatch(/questionMode and questionOverrides from get_preferences/);
    expect(text).toMatch(/batch \(the default\)/);
    expect(text).toMatch(/ONE message at the end/);
    expect(text).toMatch(/never means do not ask/);
  });
  it("reads the setting from the preferences it can see", async () => {
    createHumanApi(db).setPreferences({ roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, questionMode: "chat", questionOverrides: { skill_levels: "never" } });
    expect((await call("get_preferences")).data).toMatchObject({ questionMode: "chat", questionOverrides: { skill_levels: "never" } });
  });
});
