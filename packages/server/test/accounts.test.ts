import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentApi, openDb, setProfile, type DB } from "@jobhunt/core";
import { createVault, type Vault } from "@jobhunt/vault";
import { createApp } from "../src/app.js";
import { createMailer } from "../src/mail.js";
import type { Clipboard } from "../src/clipboard.js";

const TOKEN = "test-token";
const PASS = "correct horse battery";
const H = "human" as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("accounts and the copy helper", () => {
  let db: DB;
  let server: ReturnType<typeof createApp>;
  let base: string;
  let vault: Vault;
  let clip: string;
  let clipboard: Clipboard;

  const auth = { authorization: `Bearer ${TOKEN}` };
  const json = { ...auth, "content-type": "application/json" };
  const get = (p: string) => fetch(base + p, { headers: auth });
  const post = (p: string, b: unknown = {}) => fetch(base + p, { method: "POST", headers: json, body: JSON.stringify(b) });
  const del = (p: string) => fetch(base + p, { method: "DELETE", headers: json, body: "{}" });

  beforeEach(async () => {
    db = openDb(":memory:");
    setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] }, H);
    const dir = mkdtempSync(join(tmpdir(), "jobhunt-acct-"));
    vault = createVault(dir, { logN: 10 });
    clip = "something I copied earlier";
    clipboard = { write: async (t) => { clip = t; }, read: async () => clip };
    server = createApp(db, { token: TOKEN, dataDir: dir, vault, mailer: createMailer(vault, { dryRun: true }), clipboard, clipboardClearMs: 60 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const secret = (name = "site:acme.com") => vault.use(name, (raw) => JSON.parse(raw) as { username: string; password: string });
  const everywhere = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all())).join("\n");
  };

  it("needs the token and an unlocked vault", async () => {
    expect((await fetch(base + "/api/accounts")).status).toBe(401);
    expect((await fetch(base + "/api/accounts/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    await post("/api/vault/create", { passphrase: PASS });
    vault.lock();
    expect((await post("/api/accounts/start", { site: "acme.com" })).status).toBeGreaterThanOrEqual(400);
    expect(await (await get("/api/accounts")).json()).toEqual([]);
  });

  it("makes a password, saves it in the vault, and never sends it anywhere", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const res = await post("/api/accounts/start", { site: "https://www.acme.com/signup", pageUrl: "https://www.acme.com/signup", passwordRules: { minLength: 24, symbols: false } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["id", "site", "username"]);
    expect(body).toMatchObject({ site: "acme.com", username: "ada@example.com" });
    const s = await secret();
    expect(s.username).toBe("ada@example.com");
    expect(s.password).toHaveLength(24);
    expect(s.password).toMatch(/^[a-zA-Z0-9]+$/);
    // The password is in no response and in no table of the database.
    expect(JSON.stringify(body)).not.toContain(s.password);
    expect(JSON.stringify(await (await get("/api/accounts")).json())).not.toContain(s.password);
    expect(everywhere()).not.toContain(s.password);
  });

  it("copies the password from the server and takes it off the clipboard afterwards", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const { id } = await (await post("/api/accounts/start", { site: "acme.com" })).json();
    const { password } = await secret();
    const r = await post(`/api/accounts/${id}/copy`, { what: "password" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(password);
    expect(JSON.parse(text)).toMatchObject({ ok: true, copied: "password" });
    expect(clip).toBe(password);
    await sleep(150);
    expect(clip).toBe("");
  });

  it("leaves the clipboard alone if the user copied something else meanwhile", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const { id } = await (await post("/api/accounts/start", { site: "acme.com" })).json();
    await post(`/api/accounts/${id}/copy`, { what: "password" });
    clip = "my own text";
    await sleep(150);
    expect(clip).toBe("my own text");
  });

  it("uses the username the agent typed on the sign-up page, and copies that", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const { id, username } = await (await post("/api/accounts/start", { site: "ycombinator.com", username: "alex-morgan" })).json();
    expect(username).toBe("alex-morgan");
    expect((await secret("site:ycombinator.com")).username).toBe("alex-morgan");
    await post(`/api/accounts/${id}/copy`, { what: "username" });
    expect(clip).toBe("alex-morgan");
  });

  it("copies the email without clearing it, and refuses for an unknown account or a locked vault", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const { id } = await (await post("/api/accounts/start", { site: "acme.com", username: "other@example.com" })).json();
    expect((await post(`/api/accounts/${id}/copy`, { what: "username" })).status).toBe(200);
    expect(clip).toBe("other@example.com");
    await sleep(120);
    expect(clip).toBe("other@example.com");
    expect((await post("/api/accounts/999/copy", { what: "password" })).status).toBe(404);
    vault.lock();
    expect((await post(`/api/accounts/${id}/copy`, { what: "password" })).status).toBeGreaterThanOrEqual(400);
  });

  it("closes the sign-up card when the user confirms, and the account then shows as created", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const agent = createAgentApi(db);
    const jobId = agent.addCandidateJob({ title: "E", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://acme.com/signup" });
    expect((await (await get("/api/actions")).json()).filter((a: any) => a.kind === "signup_needed")).toHaveLength(1);
    const { id } = await (await post("/api/accounts/start", { site: "acme.com", jobId })).json();
    expect((await post(`/api/accounts/${id}/confirm`)).status).toBe(200);
    expect((await (await get("/api/actions")).json()).filter((a: any) => a.kind === "signup_needed")).toHaveLength(0);
    expect((await (await get("/api/accounts")).json())[0]).toMatchObject({ site: "acme.com", confirmedAt: expect.any(String) });
    expect((await post(`/api/accounts/${id}/verified`)).status).toBe(200);
    expect(agent.accountStatus("acme.com")).toMatchObject({ exists: true, confirmed: true, verified: true });
  });

  it("deletes the account and its saved password together, and refuses while the vault is locked", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    const { id } = await (await post("/api/accounts/start", { site: "acme.com" })).json();
    vault.lock();
    expect((await del(`/api/accounts/${id}`)).status).toBeGreaterThanOrEqual(400);
    expect((await (await get("/api/accounts")).json())).toHaveLength(1);
    await post("/api/vault/unlock", { passphrase: PASS });
    expect((await del(`/api/accounts/${id}`)).status).toBe(200);
    expect(await (await get("/api/accounts")).json()).toEqual([]);
    await expect(secret()).rejects.toThrow();
  });

  it("refuses a bad address and an impossible password rule", async () => {
    await post("/api/vault/create", { passphrase: PASS });
    expect((await post("/api/accounts/start", { site: "nope" })).status).toBe(400);
    expect((await post("/api/accounts/start", { site: "acme.com", passwordRules: { minLength: 40, maxLength: 20 } })).status).toBe(400);
    setProfile(db, { fullName: "Ada", links: [], languages: [] }, H);
    expect((await post("/api/accounts/start", { site: "acme.com" })).status).toBe(400); // no email to use
  });
});
