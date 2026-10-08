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
