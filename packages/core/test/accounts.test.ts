import { describe, expect, it } from "vitest";
import {
  accountStatus, confirmAccount, createAccount, createAgentApi, deleteAccount, generatePassword, getAccount, listAccounts, markAccountVerified,
  openDb, requestAccount, siteOf, vaultNameFor, type DB,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const AMBIGUOUS = /[lIO01]/;

describe("generatePassword", () => {
  it("makes 20 characters with every kind, and none that look alike", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[!@#$%&*\-_?]/);
      expect(p).not.toMatch(AMBIGUOUS);
    }
  });
  it("is different every time", () => {
    expect(new Set(Array.from({ length: 100 }, () => generatePassword())).size).toBe(100);
  });
  it("follows a page's rules", () => {
    expect(generatePassword({ minLength: 30 })).toHaveLength(30);
    expect(generatePassword({ maxLength: 16 })).toHaveLength(16);
    expect(generatePassword({ minLength: 8 })).toHaveLength(20); // never shorter than 12, and the default is 20
    expect(generatePassword({ symbols: false })).toMatch(/^[a-zA-Z0-9]+$/);
    expect(throws(() => generatePassword({ minLength: 100 }))).toMatch(/cannot be satisfied/); // longer than we allow
    expect(throws(() => generatePassword({ minLength: 40, maxLength: 20 }))).toMatch(/cannot be satisfied/);
  });
});

describe("siteOf", () => {
  it("is the host, lowercase, without www", () => {
    expect(siteOf("https://WWW.Acme.com/careers?x=1")).toBe("acme.com");
    expect(siteOf("jobs.ashbyhq.com")).toBe("jobs.ashbyhq.com");
    expect(vaultNameFor("acme.com")).toBe("site:acme.com");
    expect(throws(() => siteOf("not a site"))).toMatch(/not a web address/);
    expect(throws(() => siteOf("localhost"))).toMatch(/not a web address/);
  });
});

function setup() {
  const db = openDb(":memory:");
  const agent = createAgentApi(db);
  const jobId = agent.addCandidateJob({ title: "E", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  return { db, agent, jobId };
}

describe("accounts", () => {
  it("records an account, confirms it, closes the sign-up reminder, and forgets it", () => {
    const { db, agent, jobId } = setup();
    const r = agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://www.acme.com/signup", passwordRules: { minLength: 12 }, fields: ["email", "password"] });
    expect(r).toMatchObject({ site: "acme.com", alreadyOpen: false });
    const id = createAccount(db, { site: "https://acme.com/signup", username: "ada@example.com", jobId }, H);
    expect(getAccount(db, id)).toMatchObject({ site: "acme.com", username: "ada@example.com", vaultName: "site:acme.com", confirmedAt: undefined });
    confirmAccount(db, id, H);
    expect(getAccount(db, id)!.confirmedAt).toBeTruthy();
    expect((agent.listOpenActions() as any[]).filter((a) => a.kind === "signup_needed")).toHaveLength(0);
    markAccountVerified(db, id, H);
    expect(getAccount(db, id)!.status).toBe("verified");
    expect(deleteAccount(db, id, H)).toBe("site:acme.com");
    expect(listAccounts(db)).toEqual([]);
  });

  it("starting again for the same email resets it instead of adding a second", () => {
    const { db } = setup();
    const a = createAccount(db, { site: "acme.com", username: "ada@example.com" }, H);
    confirmAccount(db, a, H);
    expect(createAccount(db, { site: "acme.com", username: "ada@example.com" }, H)).toBe(a);
    expect(getAccount(db, a)!.confirmedAt).toBeUndefined();
    expect(listAccounts(db)).toHaveLength(1);
  });

  it("only a person can create, confirm or delete one", () => {
    const { db } = setup();
    expect(throws(() => createAccount(db, { site: "acme.com", username: "a@b.co" }, "agent"))).toMatch(/Only the user/);
    const id = createAccount(db, { site: "acme.com", username: "a@b.co" }, H);
    expect(throws(() => confirmAccount(db, id, "agent"))).toMatch(/Only the user/);
    expect(throws(() => deleteAccount(db, id, "agent"))).toMatch(/Only the user/);
    expect(throws(() => createAccount(db, { site: "acme.com", username: " " }, H))).toMatch(/needs the email/);
  });

  it("tells the agent only whether an account exists, never who or what", () => {
    const { db, agent } = setup();
    expect(accountStatus(db, "https://acme.com/x")).toEqual({ site: "acme.com", exists: false, confirmed: false, verified: false });
    const id = createAccount(db, { site: "acme.com", username: "ada@example.com" }, H);
    confirmAccount(db, id, H);
    const s = agent.accountStatus("https://www.acme.com/login");
    expect(s).toEqual({ site: "acme.com", exists: true, confirmed: true, verified: false });
    expect(JSON.stringify(s)).not.toContain("ada@example.com");
  });
});

describe("profile cards", () => {
  it("are asked for by the agent, once per site and job, and do not clash with a sign-up card", () => {
    const { agent, jobId } = setup();
    agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://careers.acme.com/signup" });
    const signup = (agent.listOpenActions() as any[]).find((a) => JSON.parse(a.payload).mode === "signup");
    const p = agent.requestProfileFill(jobId, { pageUrl: "https://www.careers.acme.com/profile", note: "The site wants the profile completed before applying" });
    expect(p).toMatchObject({ site: "careers.acme.com", alreadyOpen: false });
    expect(p.actionId).not.toBe(signup.id);
    expect(agent.requestProfileFill(jobId, { pageUrl: "https://careers.acme.com/other" })).toMatchObject({ actionId: p.actionId, alreadyOpen: true });
    const card = (agent.listOpenActions() as any[]).map((a) => JSON.parse(a.payload)).find((x) => x.mode === "profile");
    expect(card).toMatchObject({ site: "careers.acme.com", note: "The site wants the profile completed before applying" });
    expect(throws(() => agent.requestProfileFill(jobId, { pageUrl: "nope" }))).toMatch(/not a web address/);
  });

  it("stay when the account is confirmed, together with a verification card; only sign-up and login cards close", () => {
    const { db, agent, jobId } = setup();
    const id = createAccount(db, { site: "careers.acme.com", username: "ada@example.com", jobId }, H);
    agent.requestProfileFill(jobId, { pageUrl: "https://careers.acme.com/profile" });
    agent.requestAccount(jobId, { mode: "login", pageUrl: "https://careers.acme.com/login" });
    db.prepare("INSERT INTO action_queue (kind, job_id, payload) VALUES ('signup_needed', ?, ?)").run(jobId, JSON.stringify({ site: "careers.acme.com", mode: "verify", accountId: id }));
    confirmAccount(db, id, H);
    const modes = (agent.listOpenActions() as any[]).map((a) => JSON.parse(a.payload).mode).sort();
    expect(modes).toEqual(["profile", "verify"]);
  });

  it("know which job led to each account", () => {
    const { db, jobId } = setup();
    const id = createAccount(db, { site: "careers.acme.com", username: "ada@example.com", jobId }, H);
    expect(getAccount(db, id)!.jobId).toBe(jobId);
  });
});

describe("requestAccount", () => {
  it("queues one card per site and job, and checks what it is given", () => {
    const { agent, jobId } = setup();
    const a = agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://acme.com/signup" });
    expect(agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://www.acme.com/other" })).toMatchObject({ actionId: a.actionId, alreadyOpen: true });
    expect(agent.requestAccount(jobId, { mode: "login", pageUrl: "https://other.com/login" }).alreadyOpen).toBe(false);
    expect(throws(() => agent.requestAccount(jobId, { mode: "register" as never, pageUrl: "https://x.com" }))).toMatch(/mode must be/);
    expect(throws(() => agent.requestAccount(jobId, { mode: "signup", pageUrl: "nope" }))).toMatch(/not a web address/);
    expect(throws(() => agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://z.com/s", username: "two words" }))).toMatch(/no spaces/);
    agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://named.com/s", username: "alex-morgan" });
    const named = (agent.listOpenActions() as any[]).map((x) => JSON.parse(x.payload)).find((p) => p.site === "named.com");
    expect(named).toMatchObject({ username: "alex-morgan", mode: "signup" });
    expect(throws(() => agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://x.com", passwordRules: { minLength: 0 } }))).toMatch(/whole number/);
    const q = (agent.listOpenActions() as any[]).find((x) => x.kind === "signup_needed");
    expect(JSON.parse(q.payload)).toMatchObject({ site: "acme.com", mode: "signup", applyUrl: "https://acme.com/signup" });
  });
});

describe("sites that share one login", () => {
  it("treats every Y Combinator address as one site, with or without www", async () => {
    const { canonicalSite, siteOf } = await import("../src/index.js");
    for (const u of ["https://www.ycombinator.com/companies/x/jobs/1", "https://account.ycombinator.com/?continue=y", "https://www.workatastartup.com/application?signup_job_id=1", "ycombinator.com"]) {
      expect(siteOf(u)).toBe("ycombinator.com");
    }
    expect(canonicalSite("www.acme.com")).toBe("acme.com");
    expect(siteOf("https://jobs.lever.co/acme")).toBe("jobs.lever.co");
  });

  it("knows an account exists whichever address of the site asks, and one confirmation closes every card for it", async () => {
    const m = await import("../src/index.js");
    const db = m.openDb(":memory:");
    const human = m.createHumanApi(db);
    const agent = m.createAgentApi(db);
    const id = human.createAccount({ site: "account.ycombinator.com", username: "me@example.com" });
    expect(agent.accountStatus("https://www.workatastartup.com/application?x=1")).toMatchObject({ exists: true, confirmed: false });
    // a card from before sites were grouped, and a new one for another job
    db.prepare("INSERT INTO action_queue (kind, payload) VALUES ('signup_needed', ?)").run(JSON.stringify({ site: "www.ycombinator.com", mode: "signup", applyUrl: "https://www.ycombinator.com/x" }));
    agent.requestAccount(null, { mode: "signup", pageUrl: "https://www.workatastartup.com/application?y=2" });
    expect((human.listActionsDetailed() as { payload: { site: string } }[]).map((a) => a.payload.site)).toEqual(["ycombinator.com", "ycombinator.com"]);
    human.confirmAccount(id);
    expect(human.listActionsDetailed()).toHaveLength(0);
    expect(agent.accountStatus("ycombinator.com")).toMatchObject({ exists: true, confirmed: true });
  });
});
