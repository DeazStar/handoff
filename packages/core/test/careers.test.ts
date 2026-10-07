import { describe, expect, it } from "vitest";
import {
  createAgentApi, createHumanApi, directoryStats, findCareersLink, findCareersPage, importDirectory, listDirectory, listScoutCompanies,
  looksScripted, openDb, runCareerFinder, setCareersPage, setCompanyVerdict, type DB,
} from "../src/index.js";

const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const manyLinks = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
const page = (links: string) => `<html><body>${manyLinks}${links}</body></html>`;

describe("findCareersLink", () => {
  it("finds a careers link on the company's own site", () => {
    expect(findCareersLink(page('<a href="/careers">Careers</a>'), "https://acme.io")).toBe("https://acme.io/careers");
    expect(findCareersLink(page('<a href="https://www.acme.io/join-us/">Join us</a>'), "https://acme.io/")).toBe("https://www.acme.io/join-us/");
  });
  it("follows a link to a job platform", () => {
    expect(findCareersLink(page('<a href="https://jobs.lever.co/acme">We\'re hiring</a>'), "https://acme.io")).toBe("https://jobs.lever.co/acme");
  });
  it("ignores other sites, mail links and plain text matches", () => {
    expect(findCareersLink(page('<a href="https://other.com/careers">Careers</a>'), "https://acme.io")).toBeUndefined();
    expect(findCareersLink(page('<a href="mailto:jobs@acme.io">Jobs</a><a href="javascript:x()">Careers</a>'), "https://acme.io")).toBeUndefined();
    expect(findCareersLink(page('<a href="/about">About us</a>'), "https://acme.io")).toBeUndefined();
    expect(findCareersLink(page('<a href="https://jobs.lever.co/other">Our partners</a>'), "https://acme.io")).toBeUndefined();
  });
  it("prefers the stronger link", () => {
    const html = page('<a href="/blog/jobs-report">Jobs report</a><a href="/careers">Careers</a>');
    expect(findCareersLink(html, "https://acme.io")).toBe("https://acme.io/careers");
  });
});

describe("findCareersPage", () => {
  const site = (pages: Record<string, string>) => ({ fetchPage: async (u: string) => { if (u in pages) return pages[u]!; throw new Error("the page returned 404"); } });
  it("uses the link on the home page", async () => {
    const r = await findCareersPage("acme.io", site({ "https://acme.io": page('<a href="/careers">Careers</a>') }));
    expect(r).toEqual({ kind: "found", url: "https://acme.io/careers" });
  });
  it("probes /careers when the home page has no link", async () => {
    const r = await findCareersPage("https://acme.io", site({ "https://acme.io": page(""), "https://acme.io/careers": "<h1>Careers at Acme</h1>" }));
    expect(r).toEqual({ kind: "found", url: "https://acme.io/careers" });
  });
  it("does not count a probe page that says nothing about jobs", async () => {
    const r = await findCareersPage("acme.io", site({ "https://acme.io": page(""), "https://acme.io/jobs": "<h1>Welcome</h1>" }));
    expect(r).toEqual({ kind: "none" });
  });
  it("says a page with few links needs a browser", async () => {
    const r = await findCareersPage("acme.io", site({ "https://acme.io": '<div id="root"></div><script src="app.js"></script>' }));
    expect(r).toEqual({ kind: "needs_browser" });
  });
  it("reports an unreachable site, and upgrades http to https", async () => {
    expect((await findCareersPage("acme.io", site({}))).kind).toBe("unreachable");
    const seen: string[] = [];
    await findCareersPage("http://acme.io", { fetchPage: async (u) => { seen.push(u); throw new Error("x"); } });
    expect(seen).toEqual(["https://acme.io"]);
  });
  it("detects script-drawn pages", () => {
    expect(looksScripted(manyLinks)).toBe(false);
    expect(looksScripted("<p>hi</p>")).toBe(true);
  });
});

const co = (n: string, extra: object = {}) => ({ name: n, website: `https://${n.toLowerCase()}.io`, source: "yc", sourceRef: n.toLowerCase(), ...extra });
const plain = (n: string) => ({ name: n, website: `https://${n.toLowerCase()}.io`, source: "other", sourceRef: n.toLowerCase() });

describe("runCareerFinder", () => {
  it("records each outcome and does not look at a company twice", async () => {
    const db = openDb(":memory:");
    importDirectory(db, [plain("Aaa"), plain("Bbb"), plain("Ccc"), plain("Ddd")], "system");
    const pages: Record<string, string> = {
      "https://aaa.io": page('<a href="/careers">Careers</a>'),
      "https://bbb.io": page(""),
      "https://ccc.io": "<div id=\"root\"></div>",
    };
    const deps = { fetchPage: async (u: string) => { if (u in pages) return pages[u]!; throw new Error("the page returned 404"); } };
    const r = await runCareerFinder(db, deps, { limit: 10 });
    expect(r).toEqual({ checked: 4, found: 1, none: 1, needsBrowser: 1, unreachable: 1, remaining: 0 });
    const rows = Object.fromEntries(listDirectory(db).map((c) => [c.name, c]));
    expect(rows.Aaa).toMatchObject({ careersStatus: "found", careersUrl: "https://aaa.io/careers" });
    expect(rows.Bbb.careersStatus).toBe("none");
    expect(rows.Ccc).toMatchObject({ careersStatus: "unknown", careersNote: expect.stringMatching(/^needs browser/) });
    expect(rows.Ddd.careersNote).toMatch(/not reachable/);
    expect((await runCareerFinder(db, deps, { limit: 10 })).checked).toBe(0);
  });
  it("respects the limit and reports what is left", async () => {
    const db = openDb(":memory:");
    importDirectory(db, [co("Aaa"), co("Bbb"), co("Ccc")], "system");
    const r = await runCareerFinder(db, { fetchPage: async () => page("") }, { limit: 2 });
    expect(r.checked).toBe(2);
    expect(r.remaining).toBe(1);
    expect(directoryStats(db).notSearched).toBe(1);
  });
});

describe("YC jobs page fallback", () => {
  it("uses YC's jobs page when a YC company's own site shows no career link, but not for other lists", async () => {
    const db = openDb(":memory:");
    importDirectory(db, [co("Aaa"), co("Bbb"), plain("Ccc")], "system");
    const pages: Record<string, string> = { "https://aaa.io": page(""), "https://bbb.io": '<div id="root"></div>', "https://ccc.io": page("") };
    const deps = { fetchPage: async (u: string) => { if (u in pages) return pages[u]!; throw new Error("404"); } };
    const r = await runCareerFinder(db, deps, { limit: 10 });
    expect(r).toMatchObject({ checked: 3, found: 2, none: 1, needsBrowser: 0, unreachable: 0 });
    const rows = Object.fromEntries(listDirectory(db).map((c) => [c.name, c]));
    expect(rows.Aaa).toMatchObject({ careersStatus: "found", careersUrl: "https://www.ycombinator.com/companies/aaa/jobs", careersNote: expect.stringMatching(/YC jobs page/) });
    expect(rows.Bbb.careersUrl).toBe("https://www.ycombinator.com/companies/bbb/jobs");
    expect(rows.Ccc.careersStatus).toBe("none");
  });
});

describe("scout queue and verdicts", () => {
  function setup() {
    const db = openDb(":memory:");
    importDirectory(db, [co("Aaa", { remoteHint: "partly" }), co("Bbb", { remoteHint: "fully" }), co("Ccc"), co("Ddd")], "system");
    const id = (n: string) => (db.prepare("SELECT id FROM companies WHERE name = ?").get(n) as { id: number }).id;
    for (const n of ["Aaa", "Bbb", "Ccc"]) setCareersPage(db, id(n), { url: `https://${n.toLowerCase()}.io/careers` }, "system");
    db.prepare("UPDATE companies SET careers_note = 'needs browser: x' WHERE name = 'Ddd'").run();
    return { db, id, agent: createAgentApi(db), human: createHumanApi(db) };
  }
  const addJob = (db: DB, agent: ReturnType<typeof createAgentApi>, companyId: number) =>
    agent.addCandidateJob({ title: "Engineer", url: `https://x.io/${companyId}`, canonicalUrl: `https://x.io/${companyId}`, companyId });

  it("queues companies with a career page or a browser need, fully remote first", () => {
    const { db } = setup();
    expect(listScoutCompanies(db, 10).map((c) => c.name)).toEqual(["Bbb", "Aaa", "Ccc", "Ddd"]);
    expect(listScoutCompanies(db, 2).map((c) => c.name)).toEqual(["Bbb", "Aaa"]);
    expect(directoryStats(db).readyToScout).toBe(4);
  });

  it("marks a company none and takes it out of the queue", () => {
    const { db, id } = setup();
    setCareersPage(db, id("Ddd"), { none: true }, "agent");
    expect(listScoutCompanies(db, 10).map((c) => c.name)).not.toContain("Ddd");
    expect(throws(() => setCareersPage(db, id("Ddd"), { url: "javascript:x" }, "agent"))).toMatch(/web link/);
    expect(throws(() => setCareersPage(db, 9999, { none: true }, "agent"))).toMatch(/not found/);
  });

  it("lets the agent discard with a reason, and take it out of the queue", () => {
    const { db, id, agent } = setup();
    agent.setCompanyVerdict(id("Aaa"), "discarded", "6 openings, all on-site in the US, none for backend roles");
    expect(listScoutCompanies(db, 10).map((c) => c.name)).not.toContain("Aaa");
    expect(listDirectory(db, { verdict: "discarded" })[0]).toMatchObject({ name: "Aaa", verdictBy: "agent", verdictReason: expect.stringMatching(/on-site/) });
    expect(directoryStats(db).verdicts).toEqual({ unreviewed: 3, potential: 0, discarded: 1 });
  });

  it("refuses a verdict with no reason, or potential with no job", () => {
    const { db, id, agent } = setup();
    expect(throws(() => agent.setCompanyVerdict(id("Aaa"), "discarded", "no"))).toMatch(/reason/);
    expect(throws(() => agent.setCompanyVerdict(id("Aaa"), "potential", "Backend Engineer fits the stack well"))).toMatch(/at least one of its jobs/);
    addJob(db, agent, id("Aaa"));
    agent.setCompanyVerdict(id("Aaa"), "potential", "Backend Engineer fits the stack well");
    expect(listDirectory(db, { verdict: "potential" }).map((c) => c.name)).toEqual(["Aaa"]);
  });

  it("does not count a dead job as a reason for potential", () => {
    const { db, id, agent } = setup();
    const { id: jobId } = addJob(db, agent, id("Aaa"));
    agent.recordVerification(jobId, { result: "dead" });
    expect(throws(() => agent.setCompanyVerdict(id("Aaa"), "potential", "Backend Engineer fits the stack well"))).toMatch(/at least one of its jobs/);
  });

  it("lets the user reverse any verdict and keeps the agent from overruling them", () => {
    const { db, id, agent, human } = setup();
    agent.setCompanyVerdict(id("Aaa"), "discarded", "6 openings, all on-site in the US, none for backend roles");
    human.setCompanyVerdict(id("Aaa"), "potential");
    expect(listDirectory(db, { verdict: "potential" })[0]).toMatchObject({ name: "Aaa", verdictBy: "user" });
    expect(throws(() => agent.setCompanyVerdict(id("Aaa"), "discarded", "Changed my mind about this company now"))).toMatch(/user already judged/);
    human.setCompanyVerdict(id("Aaa"), "unreviewed");
    expect(listScoutCompanies(db, 10).map((c) => c.name)).toContain("Aaa");
    expect(listDirectory(db).find((c) => c.name === "Aaa")).toMatchObject({ verdict: "unreviewed", verdictReason: undefined, verdictBy: undefined });
  });

  it("does not let the agent reset a verdict, or judge a company that is not in the list", () => {
    const { db, id, agent } = setup();
    expect(throws(() => setCompanyVerdict(db, id("Aaa"), "unreviewed", undefined, "agent"))).toMatch(/Only the user/);
    expect(throws(() => agent.setCompanyVerdict(9999, "discarded", "No such company in the list at all"))).toMatch(/not in the company list/);
    expect(throws(() => setCompanyVerdict(db, id("Aaa"), "maybe" as never, "x", "human"))).toMatch(/verdict must be/);
  });
});

describe("scout does not keep retrying the same company", () => {
  function queue() {
    const db = openDb(":memory:");
    importDirectory(db, [co("Aaa", { remoteHint: "fully" }), co("Bbb"), co("Ccc"), co("Ddd")], "system");
    for (const r of db.prepare("SELECT id FROM companies").all() as { id: number }[]) setCareersPage(db, r.id, { url: "https://x.io/careers" }, "system");
    return db;
  }
  it("puts a company that was handed out without a verdict behind the fresh ones", () => {
    const db = queue();
    expect(listScoutCompanies(db, 2, true).map((c) => c.name)).toEqual(["Aaa", "Bbb"]);
    // Neither got a verdict. The next run takes the two it has not seen.
    expect(listScoutCompanies(db, 2, true).map((c) => c.name)).toEqual(["Ccc", "Ddd"]);
    // Now everyone has been tried once: the least recently tried come first again, fully remote first.
    expect(listScoutCompanies(db, 4).map((c) => c.name)).toHaveLength(4);
  });
  it("does not stamp when only looking", () => {
    const db = queue();
    listScoutCompanies(db, 2);
    expect(listScoutCompanies(db, 2).map((c) => c.name)).toEqual(["Aaa", "Bbb"]);
  });
  it("takes a judged company out, and sending it back to review gives it a fresh turn", () => {
    const db = queue();
    const agent = createAgentApi(db);
    const human = createHumanApi(db);
    const [first] = listScoutCompanies(db, 1, true);
    agent.setCompanyVerdict(first!.id, "discarded", "6 openings, all on-site in the US, none for backend");
    expect(listScoutCompanies(db, 10).map((c) => c.name)).not.toContain("Aaa");
    human.setCompanyVerdict(first!.id, "unreviewed");
    expect(listDirectory(db).find((c) => c.name === "Aaa")!.scoutTriedAt).toBeUndefined();
    expect(listScoutCompanies(db, 1)[0]!.name).toBe("Aaa");
  });
  it("shows on the company that it was tried", () => {
    const db = queue();
    listScoutCompanies(db, 1, true);
    expect(listDirectory(db).find((c) => c.name === "Aaa")!.scoutTriedAt).toBeTruthy();
  });
});
