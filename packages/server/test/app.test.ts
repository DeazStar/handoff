import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentApi, openDb, type DB } from "@jobhunt/core";
import { createApp } from "../src/app.js";

const TOKEN = "test-token";
let db: DB;
let server: ReturnType<typeof createApp>;
let base: string;
let port: number;

beforeEach(async () => {
  db = openDb(":memory:");
  server = createApp(db, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const get = (path: string) => fetch(base + path, { headers: auth });
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: json, body: JSON.stringify(body) });

const seed = () => {
  const agent = createAgentApi(db);
  const { id } = agent.addCandidateJob({ title: "Backend <b>Engineer</b>", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
  return { agent, id };
};

describe("access control", () => {
  it("refuses requests without the token", async () => {
    expect((await fetch(base + "/api/actions")).status).toBe(401);
    expect((await fetch(base + "/")).status).toBe(401);
    expect((await fetch(base + "/api/actions", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("sets a cookie from ?token= and redirects to a clean URL", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    const page = await fetch(base + "/", { headers: { cookie: `jh_token=${TOKEN}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/api/actions", headers: { ...auth, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(403);
  });

  it("refuses a foreign Origin, and non-JSON writes", async () => {
    const o = await fetch(base + "/api/facts", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" });
    expect(o.status).toBe(403);
    const t = await fetch(base + "/api/facts", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" });
    expect(t.status).toBe(415);
  });
});

describe("api", () => {
  it("lists the queue and resolves an item", async () => {
    const { agent, id } = seed();
    const qid = agent.queueAction("captcha", id, { site: "a.io" });
    const items = await (await get("/api/actions")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: qid, kind: "captcha", jobTitle: "Backend <b>Engineer</b>", payload: { site: "a.io" } });
    expect((await post(`/api/actions/${qid}/resolve`, { status: "done" })).status).toBe(200);
    expect(await (await get("/api/actions")).json()).toHaveLength(0);
  });

  it("confirms a gap into a job-only fact", async () => {
    const { agent, id } = seed();
    const qid = agent.reportGap(id, { requirement: "Kubernetes" });
    const res = await post(`/api/actions/${qid}/confirm-gap`, { scope: "job", fact: { kind: "skill", text: "Used Kubernetes" } });
    expect(res.status).toBe(200);
    const facts = await (await get("/api/facts")).json();
    expect(facts[0]).toMatchObject({ text: "Used Kubernetes", jobId: id });
  });

  it("serves job detail with only the transitions a human may make", async () => {
    const { id } = seed();
    const d = await (await get(`/api/jobs/${id}`)).json();
    expect(d.job.state).toBe("found");
    expect(d.allowedTransitions).toEqual(expect.arrayContaining(["skipped"]));
    expect(d.allowedTransitions).not.toContain("verified_live");
  });

  it("answers illegal transitions with 409 and bad input with 400, not 500", async () => {
    const { id } = seed();
    expect((await post(`/api/jobs/${id}/transition`, { to: "applied" })).status).toBe(409);
    expect((await post("/api/facts", { kind: "skill", text: "  " })).status).toBe(400);
    expect((await post("/api/facts", { kind: "bogus", text: "x" })).status).toBe(400);
    expect((await get("/api/jobs/9999")).status).toBe(404);
    expect((await post("/api/actions/1/resolve", { status: "maybe" })).status).toBe(400);
  });

  it("moves a job through the human API", async () => {
    const { id } = seed();
    expect((await post(`/api/jobs/${id}/transition`, { to: "skipped", reason: "not interested" })).status).toBe(200);
    const d = await (await get(`/api/jobs/${id}`)).json();
    expect(d.job.state).toBe("skipped");
    expect(d.events[0]).toMatchObject({ actor: "human", type: "state_changed" });
  });
});

describe("settings api", () => {
  it("saves search settings with Any as empty lists, and reads them back", async () => {
    const res = await fetch(base + "/api/preferences", {
      method: "PUT", headers: json,
      body: JSON.stringify({
        roles: [], seniority: ["mid", "senior", " "], locations: ["Addis Ababa"], remotePolicy: "any",
        industries: [], exclusions: ["BadCorp"], salaryFloor: "1000", salaryTarget: "", salaryCeiling: "2000", currency: "USD",
        dailyApplicationLimit: "5", dailyDiscoveryLimit: "8",
      }),
    });
    expect(res.status).toBe(200);
    const p = await (await get("/api/preferences")).json();
    expect(p).toMatchObject({ roles: [], seniority: ["mid", "senior"], salaryFloor: 1000, salaryCeiling: 2000, dailyDiscoveryLimit: 8 });
    expect(p.salaryTarget).toBeUndefined();
    expect(p.searchAnySite).toBe(true);
    const off = await fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify({ ...p, searchAnySite: false }) });
    expect(off.status).toBe(200);
    expect((await (await get("/api/preferences")).json()).searchAnySite).toBe(false);
  });

  it("rejects bad settings with 400", async () => {
    const put = (body: object) => fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const base_ = { roles: [], remotePolicy: "any", dailyApplicationLimit: 5, dailyDiscoveryLimit: 5 };
    expect((await put({ ...base_, salaryFloor: 5000, salaryCeiling: 1000, currency: "USD" })).status).toBe(400);
    expect((await put({ ...base_, remotePolicy: "sometimes" })).status).toBe(400);
    expect((await put({ ...base_, dailyDiscoveryLimit: -3 })).status).toBe(400);
    expect((await put({ ...base_, salaryFloor: "abc" })).status).toBe(400);
  });

  it("adds a source, toggles it, and reports the budget", async () => {
    const added = await (await post("/api/sources", { kind: "jobsite", name: "remoteok.com", url: "https://remoteok.com" })).json();
    expect((await post(`/api/sources/${added.id}/enabled`, { enabled: false })).status).toBe(200);
    const list = await (await get("/api/sources")).json();
    expect(list[0]).toMatchObject({ name: "remoteok.com", addedBy: "user", enabled: false });
    expect((await post("/api/sources", { kind: "nonsense", name: "x" })).status).toBe(400);
    expect(await (await get("/api/budget")).json()).toMatchObject({ limit: 10, addedToday: 0 });
  });

  it("saves the profile", async () => {
    const res = await fetch(base + "/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ fullName: "Ada", links: ["https://x.dev"], languages: [] }) });
    expect(res.status).toBe(200);
    expect(await (await get("/api/profile")).json()).toMatchObject({ fullName: "Ada", links: ["https://x.dev"] });
    expect((await fetch(base + "/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ fullName: " " }) })).status).toBe(400);
  });
});
