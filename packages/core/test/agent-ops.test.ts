import { describe, expect, it } from "vitest";
import { createAgentApi, listOpenActions, openDb } from "../src/index.js";

const setup = () => {
  const db = openDb(":memory:");
  const agent = createAgentApi(db);
  const { id } = agent.addCandidateJob({ title: "Backend", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
  return { db, agent, id };
};
const stateOf = (agent: ReturnType<typeof createAgentApi>, id: number) => agent.getJob(id)!.job.state;

describe("recordVerification", () => {
  it("live moves a found job to verified_live and keeps the evidence", () => {
    const { agent, id } = setup();
    const r = agent.recordVerification(id, { result: "live", httpStatus: 200, titleMatches: true, applyPathFound: true, evidence: "Apply button present" });
    expect(r.state).toBe("verified_live");
    expect(agent.getJob(id)!.verifications).toHaveLength(1);
  });

  it("dead marks the job dead, and a dead job stays dead", () => {
    const { agent, id } = setup();
    agent.recordVerification(id, { result: "dead", httpStatus: 404 });
    expect(stateOf(agent, id)).toBe("dead");
    expect(agent.recordVerification(id, { result: "live" }).state).toBe("dead");
  });

  it("unclear changes nothing, and only queues when asked", () => {
    const { db, agent, id } = setup();
    agent.recordVerification(id, { result: "unclear", evidence: "login wall" });
    expect(listOpenActions(db)).toHaveLength(0);
    agent.recordVerification(id, { result: "unclear", evidence: "login wall", queueIfUnclear: true });
    expect(listOpenActions(db)).toHaveLength(1);
    expect(stateOf(agent, id)).toBe("found");
  });

  it("re-checking a job that is already matched does not move it backwards", () => {
    const { agent, id } = setup();
    agent.recordVerification(id, { result: "live" });
    agent.setMatch(id, 8, "fits");
    expect(agent.recordVerification(id, { result: "live" }).state).toBe("matched");
  });

  it("rejects unknown jobs", () => {
    const { agent } = setup();
    expect(() => agent.recordVerification(999, { result: "live" })).toThrow(/not found/);
  });
});

describe("setMatch", () => {
  it("needs a verified job, a sane score and a reason", () => {
    const { agent, id } = setup();
    expect(() => agent.setMatch(id, 7, "good")).toThrow(/verified live/);
    agent.recordVerification(id, { result: "live" });
    expect(() => agent.setMatch(id, 11, "x")).toThrow(/between 0 and 10/);
    expect(() => agent.setMatch(id, 5, "  ")).toThrow(/reason/);
    agent.setMatch(id, 7, "Matches backend focus");
    const j = agent.getJob(id)!.job;
    expect(j).toMatchObject({ state: "matched", matchScore: 7, matchReason: "Matches backend focus" });
  });
});

describe("companies and sources", () => {
  it("upserts without duplicating", () => {
    const { agent } = setup();
    const a = agent.upsertCompany({ name: "Acme", domain: "www.Acme.com" });
    const b = agent.upsertCompany({ name: "Acme Inc", domain: "acme.com", careersUrl: "https://acme.com/careers" });
    expect(b).toBe(a);
    expect(agent.upsertSource({ kind: "google", name: "google" })).toBe(agent.upsertSource({ kind: "google", name: "google" }));
  });
});
