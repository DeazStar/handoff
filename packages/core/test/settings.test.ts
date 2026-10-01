import { describe, expect, it } from "vitest";
import { createAgentApi, createHumanApi, listOpenActions, openDb, setPreferences } from "../src/index.js";

const prefs = {
  roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [],
  dailyApplicationLimit: 5, dailyDiscoveryLimit: 3,
};

describe("discovery budget", () => {
  it("counts jobs added today against the limit", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    expect(agent.discoveryBudget()).toEqual({ limit: 10, addedToday: 0, remaining: 10 });
    setPreferences(db, prefs, "human");
    for (const n of [1, 2]) agent.addCandidateJob({ title: "t", url: `https://a.io/${n}`, canonicalUrl: `https://a.io/${n}` });
    expect(agent.discoveryBudget()).toEqual({ limit: 3, addedToday: 2, remaining: 1 });
  });

  it("refuses new jobs once the limit is used, but still recognises known ones", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    setPreferences(db, prefs, "human");
    const job = (n: number, extra = {}) => ({ title: "t", url: `https://a.io/${n}`, canonicalUrl: `https://a.io/${n}`, ...extra });
    const first = agent.addCandidateJob(job(1, { descriptionHash: "h1" }));
    agent.addCandidateJob(job(2));
    agent.addCandidateJob(job(3));
    expect(agent.discoveryBudget().remaining).toBe(0);

    expect(() => agent.addCandidateJob(job(4))).toThrow(/Daily discovery limit reached \(3 of 3/);
    expect(agent.addCandidateJob(job(1))).toEqual({ id: first.id, created: false });
    expect(agent.addCandidateJob(job(99, { descriptionHash: "h1" }))).toEqual({ id: first.id, created: false });
    expect(agent.discoveryBudget().addedToday).toBe(3);
  });

  it("a limit of 0 pauses discovery, and raising the limit resumes it", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    setPreferences(db, { ...prefs, dailyDiscoveryLimit: 0 }, "human");
    expect(() => agent.addCandidateJob({ title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" })).toThrow(/limit reached/);
    setPreferences(db, { ...prefs, dailyDiscoveryLimit: 1 }, "human");
    expect(agent.addCandidateJob({ title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).created).toBe(true);
  });

  it("validates the limits, and an empty list means any", () => {
    const db = openDb(":memory:");
    expect(() => setPreferences(db, { ...prefs, dailyDiscoveryLimit: -1 }, "human")).toThrow(/dailyDiscoveryLimit/);
    expect(() => setPreferences(db, { ...prefs, dailyApplicationLimit: 1000 }, "human")).toThrow(/dailyApplicationLimit/);
    setPreferences(db, prefs, "human");
    expect(createAgentApi(db).getPreferences()?.roles).toEqual([]);
  });
});

describe("trusted sources", () => {
  it("separates user-added from agent-added, and only the user can toggle", () => {
    const db = openDb(":memory:");
    const human = createHumanApi(db);
    const agent = createAgentApi(db);
    const a = human.addSource({ kind: "jobsite", name: "remoteok.com", url: "https://remoteok.com" });
    agent.upsertSource({ kind: "careers_page", name: "acme careers" });
    const list = agent.listSources();
    expect(list.find((s) => s.id === a)).toMatchObject({ addedBy: "user", enabled: true });
    expect(list.find((s) => s.name === "acme careers")?.addedBy).toBe("agent");
    human.setSourceEnabled(a, false);
    expect(agent.listSources().find((s) => s.id === a)?.enabled).toBe(false);
    expect("setSourceEnabled" in agent).toBe(false);
    expect(() => human.setSourceEnabled(999, true)).toThrow(/not found/);
  });
});

describe("apply route", () => {
  it("records the route, and asks the user to sign up when a login is required", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const { id } = agent.addCandidateJob({ title: "t", url: "https://jobs.acme.example/1", canonicalUrl: "https://jobs.acme.example/1" });
    agent.setRoute(id, "form", { requiresSignin: true });
    expect(agent.getJob(id)?.job.route).toBe("form");
    const open = listOpenActions(db) as any[];
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("signup_needed");
    expect(JSON.parse(open[0].payload)).toMatchObject({ site: "jobs.acme.example" });
  });

  it("queues nothing when no sign-in is needed", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const { id } = agent.addCandidateJob({ title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
    agent.setRoute(id, "email");
    expect(listOpenActions(db)).toHaveLength(0);
    expect(() => agent.setRoute(999, "form")).toThrow(/not found/);
  });
});
