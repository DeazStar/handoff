import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentApi, openDb, type DB } from "@jobhunt/core";
import { createVault } from "@jobhunt/vault";
import nodemailer from "nodemailer";
import { createApp } from "../src/app.js";
import { createMailer } from "../src/mail.js";

const TOKEN = "test-token";
let db: DB;
let server: ReturnType<typeof createApp>;
let base: string;
let port: number;
let dataDir: string;

beforeEach(async () => {
  db = openDb(":memory:");
  dataDir = mkdtempSync(join(tmpdir(), "jobhunt-srv-"));
  const vault = createVault(dataDir, { logN: 10 });
  server = createApp(db, { token: TOKEN, dataDir, vault, mailer: createMailer(vault, { dryRun: true, transportFactory: () => nodemailer.createTransport({ jsonTransport: true }) }) });
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

describe("cv api", () => {
  const put = (path: string, body: unknown) => fetch(base + path, { method: "PUT", headers: json, body: JSON.stringify(body) });
  const del = (path: string) => fetch(base + path, { method: "DELETE", headers: json, body: "{}" });

  it("adds, edits, orders and deletes entries and their bullets", async () => {
    const a = (await (await post("/api/cv/entries", { kind: "work", title: "Backend Engineer", organization: "Acme", startDate: "2022-03", endDate: "2024-01" })).json()).id;
    const b = (await (await post("/api/cv/entries", { kind: "work", title: "Engineer", organization: "Beta", startDate: "2020", isCurrent: true })).json()).id;
    expect((await post("/api/cv/entries", { kind: "work", title: "x", startDate: "March" })).status).toBe(400);

    const bullet = (await (await post(`/api/cv/entries/${a}/bullets`, { text: "Built an API serving 50000 users" })).json()).id;
    expect((await put(`/api/cv/bullets/${bullet}`, { text: "Built an API serving 60000 users" })).status).toBe(200);
    expect((await post(`/api/cv/entries/${b}/move`, { direction: "up" })).status).toBe(200);
    expect((await post(`/api/cv/entries/${b}/move`, { direction: "sideways" })).status).toBe(400);
    expect((await put("/api/cv/skills", { group: "Backend", items: ["Node.js", "Rust"] })).status).toBe(200);

    const cv = await (await get("/api/cv")).json();
    expect(cv.entries.map((e: any) => e.id)).toEqual([b, a]);
    expect(cv.entries[1].bullets).toEqual([{ id: bullet, text: "Built an API serving 60000 users" }]);
    expect(cv.entries[0]).toMatchObject({ isCurrent: true });
    expect(cv.skills[0].skills.map((s: any) => s.text)).toEqual(["Node.js", "Rust"]);

    expect((await put("/api/cv/bullets/9999", { text: "x" })).status).toBe(404);
    expect((await del(`/api/cv/entries/${a}`)).status).toBe(200);
    expect((await (await get("/api/cv")).json()).entries).toHaveLength(1);
  });

  it("renders a preview PDF of the CV as it stands, and says what is missing", async () => {
    const noProfile = await get("/api/cv/preview.pdf");
    expect(noProfile.status).toBe(400);
    expect((await noProfile.json()).error).toMatch(/no name yet/);

    await fetch(base + "/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ fullName: "Ada Lovelace", links: [], languages: [] }) });
    const e = (await (await post("/api/cv/entries", { kind: "work", title: "Engineer", organization: "Acme" })).json()).id;
    await post(`/api/cv/entries/${e}/bullets`, { text: "Maintained 12 services" });
    const pdf = await get("/api/cv/preview.pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-pages")).toBe("1");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("document files", () => {
  const save = (path: string) => {
    const agent = createAgentApi(db);
    return agent.saveDocument({ jobId: null, kind: "cv", path, blocks: [{ text: "x", factIds: [], kind: "boilerplate" }] }).id;
  };

  it("serves a saved PDF from inside the documents folder", async () => {
    mkdirSync(join(dataDir, "documents"));
    writeFileSync(join(dataDir, "documents", "cv.pdf"), "%PDF-1.4 test");
    const res = await get(`/api/documents/${save("documents/cv.pdf")}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await res.text()).toBe("%PDF-1.4 test");
  });

  it("refuses paths that leave the documents folder, other file types, and missing files", async () => {
    writeFileSync(join(dataDir, "secret.pdf"), "%PDF secret");
    expect((await get(`/api/documents/${save("../secret.pdf")}/file`)).status).toBe(404);
    expect((await get(`/api/documents/${save("documents/../secret.pdf")}/file`)).status).toBe(404);
    expect((await get(`/api/documents/${save(join(dataDir, "secret.pdf"))}/file`)).status).toBe(404);
    expect((await get(`/api/documents/${save("documents/notes.txt")}/file`)).status).toBe(404);
    expect((await get(`/api/documents/${save("documents/missing.pdf")}/file`)).status).toBe(404);
  });

  it("deletes a document's record and its file, but never a file outside the documents folder", async () => {
    const del = (path: string) => fetch(base + path, { method: "DELETE", headers: json, body: "{}" });
    mkdirSync(join(dataDir, "documents"), { recursive: true });
    writeFileSync(join(dataDir, "documents", "gone.pdf"), "%PDF gone");
    writeFileSync(join(dataDir, "outside.pdf"), "%PDF outside");
    const inside = save("documents/gone.pdf");
    const outside = save("../outside.pdf");
    expect((await del(`/api/documents/${inside}`)).status).toBe(200);
    expect(existsSync(join(dataDir, "documents", "gone.pdf"))).toBe(false);
    expect((await get(`/api/documents/${inside}`)).status).toBe(404);
    expect((await del(`/api/documents/${outside}`)).status).toBe(200);
    expect(existsSync(join(dataDir, "outside.pdf"))).toBe(true);
    expect((await del(`/api/documents/${inside}`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("weights and guidance api", () => {
  it("saves an entry's weight and the CV guidance, and rejects a bad weight", async () => {
    const id = (await (await post("/api/cv/entries", { kind: "work", title: "Backend Engineer", organization: "Rejuive", weight: "lead" })).json()).id;
    const cv = await (await get("/api/cv")).json();
    expect(cv.entries.find((e: any) => e.id === id).weight).toBe("lead");
    expect((await post("/api/cv/entries", { kind: "work", title: "x", weight: "huge" })).status).toBe(400);

    const prefs = { roles: [], remotePolicy: "any", dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, cvGuidance: "  Prefer international client work.  " };
    expect((await fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify(prefs) })).status).toBe(200);
    expect((await (await get("/api/preferences")).json()).cvGuidance).toBe("Prefer international client work.");
    expect((await fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify({ ...prefs, cvGuidance: "x".repeat(1001) }) })).status).toBe(400);
  });

  it("puts entries that lead first in the preview, as every CV must", async () => {
    await fetch(base + "/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ fullName: "Ada", links: [], languages: [] }) });
    const first = (await (await post("/api/cv/entries", { kind: "work", title: "First by position" })).json()).id;
    const lead = (await (await post("/api/cv/entries", { kind: "work", title: "Leads the CV", weight: "lead" })).json()).id;
    await post(`/api/cv/entries/${first}/bullets`, { text: "Did a thing" });
    await post(`/api/cv/entries/${lead}/bullets`, { text: "Did the main thing" });
    const res = await get("/api/cv/preview.pdf");
    expect(res.status).toBe(200);
  });
});

describe("country priority api", () => {
  it("saves the list and each entry's country, and the preview follows the priority", async () => {
    const put = (path: string, body: unknown) => fetch(base + path, { method: "PUT", headers: json, body: JSON.stringify(body) });
    await put("/api/profile", { fullName: "Ada", links: [], languages: [] });
    const eth = (await (await post("/api/cv/entries", { kind: "work", title: "Local job", country: " Ethiopia " })).json()).id;
    const us = (await (await post("/api/cv/entries", { kind: "work", title: "US job", country: "United States" })).json()).id;
    await post(`/api/cv/entries/${eth}/bullets`, { text: "Did local work" });
    await post(`/api/cv/entries/${us}/bullets`, { text: "Did US work" });
    const prefs = { roles: [], remotePolicy: "any", dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, countryPriority: ["United States", " ", "united states", "Netherlands"] };
    expect((await put("/api/preferences", prefs)).status).toBe(200);
    expect((await (await get("/api/preferences")).json()).countryPriority).toEqual(["United States", "Netherlands"]);
    expect((await (await get("/api/cv")).json()).entries.find((e: any) => e.id === eth).country).toBe("Ethiopia");
    expect((await get("/api/cv/preview.pdf")).status).toBe(200); // the order it builds would be refused if it broke the rule
  });
});


describe("pick lists", () => {
  it("offers the country and work-type choices, and refuses anything off the list", async () => {
    const lists = await (await get("/api/lists")).json();
    expect(lists.countries).toContain("United States");
    expect(lists.countries).toContain("Ethiopia");
    expect(lists.employmentTypes).toContainEqual({ value: "full_time", label: "Full-time" });
    expect(lists.employmentTypes.map((t: any) => t.value)).toEqual(["full_time", "part_time", "contract", "freelance"]);

    const entry = await post("/api/cv/entries", { kind: "work", title: "Engineer", country: "Netherland" });
    expect(entry.status).toBe(400);
    expect((await entry.json()).error).toMatch(/Did you mean "Netherlands"/);
    const prefs = { roles: [], remotePolicy: "any", dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, countryPriority: ["United State"] };
    const res = await fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify(prefs) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Did you mean "United States"/);
    const ok = await fetch(base + "/api/preferences", { method: "PUT", headers: json, body: JSON.stringify({ ...prefs, countryPriority: ["usa"] }) });
    expect(ok.status).toBe(200);
    expect((await (await get("/api/preferences")).json()).countryPriority).toEqual(["United States"]);
  });
});


describe("vault api", () => {
  const PASS = "correct horse battery";
  const put = (path: string, body: unknown) => fetch(base + path, { method: "PUT", headers: json, body: JSON.stringify(body) });
  const del = (path: string) => fetch(base + path, { method: "DELETE", headers: json, body: "{}" });
  const APP_PASSWORD = "abcdwxyzabcdwxyz";

  it("creates, locks and unlocks, and refuses what it should", async () => {
    expect(await (await get("/api/vault/status")).json()).toEqual({ exists: false, unlocked: false, secrets: null });
    expect((await post("/api/vault/create", { passphrase: "short" })).status).toBe(400);
    expect((await post("/api/vault/create", { passphrase: PASS })).status).toBe(200);
    expect((await post("/api/vault/create", { passphrase: PASS })).status).toBe(409);
    expect((await post("/api/vault/lock", {})).status).toBe(200);
    expect((await put("/api/vault/mail", { password: APP_PASSWORD, user: "me@example.com" })).status).toBe(423);
    expect((await post("/api/vault/unlock", { passphrase: "wrong passphrase!" })).status).toBe(403);
    const ok = await post("/api/vault/unlock", { passphrase: PASS });
    expect(ok.status).toBe(200);
    expect((await ok.json()).unlocked).toBe(true);
  });

  it("stores the mail login but never sends a secret back", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    expect((await put("/api/vault/mail", { password: "nope!" })).status).toBe(400);
    expect((await put("/api/vault/mail", { password: APP_PASSWORD })).status).toBe(400); // no profile email yet
    await fetch(base + "/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ fullName: "Ada", email: "ada@example.com", links: [], languages: [] }) });

    const saved = await put("/api/vault/mail", { password: "abcd wxyz abcd wxyz" }); // Google shows it with spaces
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(JSON.parse(body).secrets).toEqual([expect.objectContaining({ name: "mail.smtp" })]);
    for (const text of [body, await (await get("/api/vault/status")).text()]) {
      expect(text).not.toContain(APP_PASSWORD);
      expect(text).not.toContain("wxyz");
    }
    expect((await del("/api/vault/secrets/mail.smtp")).status).toBe(200);
    expect((await del("/api/vault/secrets/mail.smtp")).status).toBe(404);
  });

  it("changes the passphrase", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    expect((await post("/api/vault/change-passphrase", { old: "not it, sorry!", next: "another long passphrase" })).status).toBe(403);
    expect((await post("/api/vault/change-passphrase", { old: PASS, next: "another long passphrase" })).status).toBe(200);
    await post("/api/vault/lock", {});
    expect((await post("/api/vault/unlock", { passphrase: PASS })).status).toBe(403);
    expect((await post("/api/vault/unlock", { passphrase: "another long passphrase" })).status).toBe(200);
  });

  it("needs the token like everything else", async () => {
    expect((await fetch(base + "/api/vault/status")).status).toBe(401);
    expect((await fetch(base + "/api/vault/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) })).status).toBe(401);
  });
});


describe("mail test api", () => {
  const put = (path: string, body: unknown) => fetch(base + path, { method: "PUT", headers: json, body: JSON.stringify(body) });
  const profile = () => put("/api/profile", { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] });

  it("explains what is missing, step by step", async () => {
    expect((await post("/api/vault/mail/test", {})).status).toBe(400); // no profile email
    await profile();
    expect((await post("/api/vault/mail/test", {})).status).toBe(423); // no vault yet, so locked
    await post("/api/vault/create", { passphrase: "correct horse battery" });
    const res = await post("/api/vault/mail/test", {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Save your mail app password in the Vault first/);
  });

  it("sends the test message to the user's own address", async () => {
    await profile();
    await post("/api/vault/create", { passphrase: "correct horse battery" });
    await put("/api/vault/mail", { password: "abcd wxyz abcd wxyz" });
    const res = await post("/api/vault/mail/test", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentTo: "ada@example.com", dryRun: true });
    await post("/api/vault/lock", {});
    expect((await post("/api/vault/mail/test", {})).status).toBe(423);
  });

  it("needs the token", async () => {
    expect((await fetch(base + "/api/vault/mail/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});
