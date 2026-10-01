import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHumanApi, openDb, type DB } from "@jobhunt/core";
import { createMcpServer } from "../src/server.js";

let db: DB;
let client: Client;

beforeEach(async () => {
  db = openDb(":memory:");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
afterEach(() => client.close());

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(name: string, args: Record<string, unknown> = {}) {
  try {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = r.content[0]!.text;
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { error: r.isError === true, text, data };
  } catch (e) {
    // Input that fails the schema is rejected by the SDK before our handler runs.
    return { error: true, text: String(e), data: undefined as any };
  }
}

const job = { title: "Backend Engineer", url: "https://acme.example/jobs/1?utm_source=x" };

describe("tool surface", () => {
  it("offers the agent tools and none of the user's", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_candidate_job", "record_verification", "set_match", "report_gap", "save_document", "queue_action"]));
    for (const forbidden of ["resolve_action", "confirm_gap", "add_fact", "set_profile", "set_preferences", "delete_fact", "approve", "apply", "send_email"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("tells the agent the ground rules", () => {
    expect(client.getInstructions()).toMatch(/untrusted data/);
  });
});

describe("discovery flow", () => {
  it("adds, dedupes, verifies and matches a job", async () => {
    const company = (await call("add_company", { name: "Acme", domain: "acme.example" })).data.companyId;
    const source = (await call("add_source", { kind: "careers_page", name: "acme careers" })).data.sourceId;
    const first = await call("add_candidate_job", { ...job, companyId: company, sourceId: source, description: "Build APIs for payments." });
    expect(first.data).toMatchObject({ created: true, canonicalUrl: "https://acme.example/jobs/1" });

    const again = await call("add_candidate_job", { title: "Backend Engineer", url: "https://www.acme.example/jobs/1/" });
    expect(again.data).toMatchObject({ created: false, id: first.data.id });
    const repost = await call("add_candidate_job", { title: "Backend Engineer", url: "https://jobs.other.example/77", companyId: company, description: "<p>Build APIs for PAYMENTS!</p>" });
    expect(repost.data).toMatchObject({ created: false, id: first.data.id });

    const id = first.data.id;
    expect((await call("set_match", { jobId: id, score: 8, reason: "fits" })).error).toBe(true);
    expect((await call("record_verification", { jobId: id, result: "live", httpStatus: 200, titleMatches: true, applyPathFound: true, evidence: "Apply button" })).data.state).toBe("verified_live");
    expect((await call("set_match", { jobId: id, score: 8, reason: "fits backend focus" })).data.state).toBe("matched");

    const detail = (await call("get_job", { jobId: id })).data;
    expect(detail.job).toMatchObject({ state: "matched", matchScore: 8, company: "Acme" });
    expect(detail.verifications).toHaveLength(1);
  });

  it("cannot mark a job applied, and the refusal explains why", async () => {
    const { data } = await call("add_candidate_job", job);
    const r = await call("transition_job", { jobId: data.id, to: "applied" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Illegal transition|may not/);
  });

  it("rejects bad input before it reaches the database", async () => {
    expect((await call("add_candidate_job", { title: "x" })).error).toBe(true);
    expect((await call("add_candidate_job", { title: "x", url: "mailto:hr@acme.example" })).error).toBe(true);
    expect((await call("set_match", { jobId: 1, score: 11, reason: "x" })).error).toBe(true);
    expect((await call("queue_action", { kind: "gap", payload: {} })).error).toBe(true);
    expect((await call("get_job", { jobId: 999 })).error).toBe(true);
  });
});

describe("handing work to the user", () => {
  it("queues actions and gaps that only the user can resolve", async () => {
    const id = (await call("add_candidate_job", job)).data.id;
    await call("queue_action", { kind: "captcha", jobId: id, payload: { site: "acme.example" } });
    await call("report_gap", { jobId: id, requirement: "Kubernetes", importance: "required", suggestedFact: { kind: "skill", text: "Used Kubernetes" } });
    const open = (await call("list_open_actions")).data;
    expect(open.map((a: any) => a.kind).sort()).toEqual(["captcha", "gap"]);
    // The user resolves them through their own API; no tool can.
    const human = createHumanApi(db);
    for (const a of open) human.resolveAction(a.id, "dismissed");
    expect((await call("list_open_actions")).data).toHaveLength(0);
  });

  it("saves a document only if its claims trace to facts", async () => {
    const human = createHumanApi(db);
    const fact = human.addFact({ kind: "experience", text: "Built a payments API serving 50000 users" });
    const id = (await call("add_candidate_job", job)).data.id;
    const facts = (await call("list_facts", { forJobId: id })).data;
    expect(facts.map((f: any) => f.id)).toEqual([fact]);

    const good = await call("save_document", { jobId: id, kind: "email", path: "e.txt", blocks: [
      { text: "Dear hiring team,", factIds: [], kind: "boilerplate" },
      { text: "I built a payments API serving 50000 users.", factIds: [fact] },
    ] });
    expect(good.data).toMatchObject({ version: 1 });

    const bad = await call("save_document", { jobId: id, kind: "email", path: "e2.txt", blocks: [
      { text: "I built a payments API serving 90000 users.", factIds: [fact] },
    ] });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/90000/);
  });

  it("cannot read or change the user's truth through any tool", async () => {
    expect((await call("get_profile")).text).toMatch(/No profile/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const writesTruth = ["set_profile", "set_preferences", "add_fact", "update_fact", "delete_fact", "make_fact_general"];
    expect(names.filter((n) => writesTruth.includes(n))).toEqual([]);
  });
});

describe("boundaries in the source", () => {
  it("imports the core only through the agent entry point", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/from\s+"(@jobhunt\/core[^"]*)"/g)) {
        expect(m[1], `${f} imports ${m[1]}`).toBe("@jobhunt/core/agent");
      }
    }
  });
});

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
describe.skipIf(!existsSync(entry))("stdio", () => {
  it("speaks the protocol on stdout and works against a real database file", async () => {
    const home = mkdtempSync(join(tmpdir(), "jobhunt-mcp-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env as Record<string, string>, JOBHUNT_HOME: home }, stderr: "pipe" });
    const c = new Client({ name: "stdio-test", version: "0" });
    await c.connect(transport);
    const tools = await c.listTools();
    expect(tools.tools.length).toBeGreaterThan(10);
    const r = (await c.callTool({ name: "add_candidate_job", arguments: job })) as ToolResult;
    expect(JSON.parse(r.content[0]!.text).created).toBe(true);
    await c.close();
    expect(existsSync(join(home, "jobhunt.db"))).toBe(true);
  });
});
