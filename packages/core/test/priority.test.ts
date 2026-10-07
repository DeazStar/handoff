import { describe, expect, it } from "vitest";
import { createAgentApi, openDb, priorityScore, setPreferences } from "../src/index.js";

const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

const prefs = (over: object = {}) => ({
  roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [],
  dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over,
});

function jobWith(agent: ReturnType<typeof createAgentApi>, n: number, score: number, signals: Parameters<typeof agent.setMatch>[3]) {
  const url = `https://acme.example/j/${n}`;
  const id = agent.addCandidateJob({ title: `Engineer ${n}`, url, canonicalUrl: url }).id;
  agent.recordVerification(id, { result: "live" });
  agent.setMatch(id, score, "fits", signals);
  return id;
}

describe("priority", () => {
  it("weights remote and sponsorship by mode", () => {
    expect(priorityScore(6, "worldwide", "unknown", "remote_first")).toBe(9);
    expect(priorityScore(6, "worldwide", "unknown", "sponsored_first")).toBe(7);
    expect(priorityScore(6, undefined, "confirmed", "sponsored_first")).toBe(9);
    expect(priorityScore(6, "open_to_me", "likely", "balanced")).toBe(6 + 1.5 * 0.75 + 1.5 * 0.5);
    expect(priorityScore(6, "closed", "unknown", "balanced")).toBe(6);
    expect(priorityScore(undefined, undefined, "unknown", "balanced")).toBe(0);
  });

  it("orders jobs by the user's chosen mode", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const remote = jobWith(agent, 1, 6, { remoteScope: "worldwide" });
    const sponsored = jobWith(agent, 2, 6, { sponsorship: "confirmed", sponsorshipEvidence: "We offer visa sponsorship" });
    setPreferences(db, prefs({ priorityMode: "remote_first" }), "human");
    expect(agent.listJobs(undefined, "priority").map((j) => j.id)).toEqual([remote, sponsored]);
    setPreferences(db, prefs({ priorityMode: "sponsored_first" }), "human");
    expect(agent.listJobs(undefined, "priority").map((j) => j.id)).toEqual([sponsored, remote]);
  });

  it("defaults to remote first and keeps the signals on the job", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const id = jobWith(agent, 1, 5, { sponsorship: "likely", sponsorshipEvidence: "UK register of licensed sponsors" });
    const j = agent.listJobs()[0];
    expect(j.id).toBe(id);
    expect(j.sponsorship).toBe("likely");
    expect(j.sponsorshipEvidence).toBe("UK register of licensed sponsors");
    expect(j.remoteScope).toBeUndefined();
    expect(j.priority).toBe(5.5);
  });

  it("refuses a sponsorship claim with no evidence, and unknown values", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const url = "https://acme.example/j/9";
    const id = agent.addCandidateJob({ title: "E", url, canonicalUrl: url }).id;
    agent.recordVerification(id, { result: "live" });
    expect(throws(() => agent.setMatch(id, 5, "x", { sponsorship: "confirmed" }))).toMatch(/where the sponsorship signal/);
    expect(throws(() => agent.setMatch(id, 5, "x", { remoteScope: "everywhere" as never }))).toMatch(/remoteScope/);
    expect(throws(() => setPreferences(db, prefs({ priorityMode: "random" as never }), "human"))).toMatch(/priorityMode/);
  });

  it("clears the evidence when sponsorship goes back to unknown", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const id = jobWith(agent, 1, 5, { sponsorship: "confirmed", sponsorshipEvidence: "We sponsor visas" });
    agent.setMatch(id, 5, "re-read", { sponsorship: "unknown" });
    const j = agent.listJobs()[0];
    expect(j.sponsorship).toBe("unknown");
    expect(j.sponsorshipEvidence).toBeUndefined();
  });
});
