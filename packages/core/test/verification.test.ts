import { describe, expect, it } from "vitest";
import {
  confirmAccount, createAccount, createAgentApi, getSyncTargets, ignoreVerification, ingestVerifications, listVerifications, looksLikeVerification, openDb,
  pendingAccounts, pickVerificationLink, purgeVerifications, relatedToSite, setVerificationUsed, siteLabel, verificationTargets, getAccount, type DB, type InboundMessage,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: `<v${Math.random().toString(36).slice(2)}@mail.example>`, fromAddr: "noreply@careers.acme.com", subject: "Please verify your email address",
  receivedAt: new Date().toISOString(), snippet: "Click the button to verify your email and finish creating your account.",
  links: ["https://careers.acme.com/verify?token=abc123", "https://careers.acme.com/privacy"], ...over,
});

function setup() {
  const db = openDb(":memory:");
  const agent = createAgentApi(db);
  const jobId = agent.addCandidateJob({ title: "E", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  agent.requestAccount(jobId, { mode: "signup", pageUrl: "https://careers.acme.com/signup" });
  const id = createAccount(db, { site: "careers.acme.com", username: "ada@example.com", jobId }, H);
  return { db, agent, jobId, id };
}
const cards = (db: DB) => (db.prepare("SELECT payload FROM action_queue WHERE kind = 'signup_needed' AND status = 'open'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload));

describe("recognising the mail", () => {
  it("knows the part of a site's name people recognise", () => {
    expect(siteLabel("careers.acme.com")).toBe("acme");
    expect(siteLabel("jobs.ashbyhq.com")).toBe("ashbyhq");
    expect(siteLabel("acme.co.uk")).toBe("acme");
    expect(siteLabel("acme.com")).toBe("acme");
  });
  it("tells a verification mail from other mail", () => {
    expect(looksLikeVerification({ subject: "Verify your email", snippet: "" })).toBe(true);
    expect(looksLikeVerification({ subject: "Confirm your account", snippet: "" })).toBe(true);
    expect(looksLikeVerification({ subject: "Welcome to Acme", snippet: "" })).toBe(true);
    expect(looksLikeVerification({ subject: "Confirm your other.org account", snippet: "" })).toBe(true); // the site's name in the middle
    expect(looksLikeVerification({ subject: "Please confirm your Workday email address", snippet: "" })).toBe(true);
    expect(looksLikeVerification({ subject: "Confirm your interview time", snippet: "" })).toBe(false);
    expect(looksLikeVerification({ subject: "Hello", snippet: "Please click to confirm your email address" })).toBe(true);
    expect(looksLikeVerification({ subject: "Your order has shipped", snippet: "Track it here" })).toBe(false);
    expect(looksLikeVerification({ subject: "Interview next week", snippet: "Are you free on Tuesday?" })).toBe(false);
  });
  it("ties a message to a site by sender, by link, or by name", () => {
    expect(relatedToSite(msg(), "careers.acme.com")).toBe(true);
    expect(relatedToSite(msg({ fromAddr: "noreply@mailer.net", links: ["https://acme.com/v?x=1"] }), "careers.acme.com")).toBe(true);
    expect(relatedToSite(msg({ fromAddr: "noreply@mailer.net", links: ["https://click.mailer.net/x"], subject: "Verify your Acme account" }), "careers.acme.com")).toBe(true);
    expect(relatedToSite(msg({ fromAddr: "noreply@mailer.net", links: ["https://click.mailer.net/x"], subject: "Verify your email" }), "careers.acme.com")).toBe(false);
    expect(relatedToSite(msg({ fromAddr: "noreply@other.com", links: [], subject: "Verify your Acmecorp account" }), "careers.acme.com")).toBe(false);
  });
  it("picks the link that confirms, and says whether it goes to the site", () => {
    expect(pickVerificationLink(msg().links, "careers.acme.com")).toEqual({ url: "https://careers.acme.com/verify?token=abc123", host: "careers.acme.com", related: true });
    expect(pickVerificationLink(["https://click.mailer.net/c/verify/xyz", "https://careers.acme.com/privacy"], "careers.acme.com")).toMatchObject({ host: "click.mailer.net", related: false });
    expect(pickVerificationLink(["https://careers.acme.com/start"], "careers.acme.com")).toMatchObject({ related: true }); // the only link on the site
    expect(pickVerificationLink(["https://a.acme.com/x", "https://b.acme.com/y"], "careers.acme.com")).toBeUndefined(); // ambiguous
    expect(pickVerificationLink(["http://careers.acme.com/verify"], "careers.acme.com")).toBeUndefined(); // not https
    expect(pickVerificationLink(undefined, "careers.acme.com")).toBeUndefined();
    expect(pickVerificationLink([`https://careers.acme.com/verify?${"a".repeat(1100)}`], "careers.acme.com")).toBeUndefined();
  });
});

describe("accounts waiting to be verified", () => {
  it("are the ones started in the last week and not yet verified", () => {
    const { db, id } = setup();
    expect(pendingAccounts(db).map((a) => a.id)).toEqual([id]);
    db.prepare("UPDATE accounts SET created_at = datetime('now', '-10 days') WHERE id = ?").run(id);
    expect(pendingAccounts(db)).toEqual([]);
    expect(verificationTargets(db)).toBeUndefined();
    db.prepare("UPDATE accounts SET created_at = datetime('now', '-1 day') WHERE id = ?").run(id);
    expect(verificationTargets(db)).toMatchObject({ labels: ["acme"] });
    expect(getSyncTargets(db).verification).toMatchObject({ labels: ["acme"] });
  });
  it("stop waiting once verified", () => {
    const { db, id } = setup();
    db.prepare("UPDATE accounts SET status = 'verified', verified_at = datetime('now') WHERE id = ?").run(id);
    expect(pendingAccounts(db)).toEqual([]);
  });
});

describe("ingestVerifications", () => {
  it("keeps the mail for the account and puts a card with the link in the queue", () => {
    const { db, id, jobId } = setup();
    expect(ingestVerifications(db, [msg()], "system")).toEqual({ found: 1 });
    const [v] = listVerifications(db);
    expect(v).toMatchObject({ accountId: id, site: "careers.acme.com", status: "new", link: "https://careers.acme.com/verify?token=abc123", linkHost: "careers.acme.com", linkRelated: true });
    const card = cards(db).find((c) => c.mode === "verify");
    expect(card).toMatchObject({ site: "careers.acme.com", accountId: id, verificationId: v!.id, link: "https://careers.acme.com/verify?token=abc123", linkRelated: true });
    expect((db.prepare("SELECT job_id FROM action_queue WHERE json_extract(payload, '$.mode') = 'verify'").get() as { job_id: number }).job_id).toBe(jobId);
  });

  it("flags a link that goes somewhere else, and still shows the card", () => {
    const { db } = setup();
    ingestVerifications(db, [msg({ links: ["https://click.mailer.net/c/verify/xyz"] })], "system");
    expect(listVerifications(db)[0]).toMatchObject({ linkHost: "click.mailer.net", linkRelated: false });
    expect(cards(db).find((c) => c.mode === "verify")).toMatchObject({ linkRelated: false });
  });

  it("works without a usable link, and ignores other mail, old mail, a repeat and mail for no waiting account", () => {
    const { db } = setup();
    expect(ingestVerifications(db, [msg({ links: [] })], "system").found).toBe(1);
    expect(listVerifications(db)[0]!.link).toBeUndefined();
    const m = msg();
    expect(ingestVerifications(db, [m, m], "system").found).toBe(1);
    expect(ingestVerifications(db, [m], "system").found).toBe(0);
    expect(ingestVerifications(db, [msg({ subject: "Your order has shipped", snippet: "Track it" })], "system").found).toBe(0);
    expect(ingestVerifications(db, [msg({ fromAddr: "noreply@other.com", links: ["https://other.com/verify"], subject: "Verify your email" })], "system").found).toBe(0);
    expect(ingestVerifications(db, [msg({ receivedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })], "system").found).toBe(0);
    const none = openDb(":memory:");
    expect(ingestVerifications(none, [msg()], "system")).toEqual({ found: 0 });
  });
});

describe("using and ignoring a verification mail", () => {
  it("marks the account verified, closes the card and drops the link", () => {
    const { db, id } = setup();
    confirmAccount(db, id, H);
    ingestVerifications(db, [msg()], "system");
    const v = listVerifications(db)[0]!;
    setVerificationUsed(db, v.id, H);
    expect(getAccount(db, id)).toMatchObject({ status: "verified" });
    expect(listVerifications(db)[0]).toMatchObject({ status: "used", link: undefined });
    expect(cards(db).filter((c) => c.mode === "verify")).toHaveLength(0);
    expect(pendingAccounts(db)).toEqual([]);
  });
  it("can dismiss the wrong mail without verifying anything", () => {
    const { db, id } = setup();
    ingestVerifications(db, [msg()], "system");
    const v = listVerifications(db)[0]!;
    ignoreVerification(db, v.id, H);
    expect(listVerifications(db)[0]).toMatchObject({ status: "ignored", link: undefined });
    expect(getAccount(db, id)!.status).toBe("created");
    expect(cards(db).filter((c) => c.mode === "verify")).toHaveLength(0);
  });
  it("is for a person only, and refuses an unknown mail", () => {
    const { db } = setup();
    ingestVerifications(db, [msg()], "system");
    const v = listVerifications(db)[0]!;
    expect(throws(() => setVerificationUsed(db, v.id, "agent"))).toMatch(/Only the user/);
    expect(throws(() => ignoreVerification(db, v.id, "agent"))).toMatch(/Only the user/);
    expect(throws(() => setVerificationUsed(db, 999, H))).toMatch(/not found/);
  });
  it("loses the link after a week and the row after a month", () => {
    const { db } = setup();
    ingestVerifications(db, [msg()], "system");
    db.prepare("UPDATE verification_mails SET created_at = datetime('now', '-8 days')").run();
    purgeVerifications(db);
    expect(listVerifications(db)[0]!.link).toBeUndefined();
    db.prepare("UPDATE verification_mails SET created_at = datetime('now', '-40 days')").run();
    purgeVerifications(db);
    expect(listVerifications(db)).toEqual([]);
  });
});
