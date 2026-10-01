import { describe, expect, it } from "vitest";
import { addFact, confirmGap, createAgentApi, createHumanApi, listFacts, listOpenActions, openDb, saveDocument } from "../src/index.js";

const setup = () => {
  const db = openDb(":memory:");
  const agent = createAgentApi(db);
  const human = createHumanApi(db);
  const j1 = agent.addCandidateJob({ title: "A", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  const j2 = agent.addCandidateJob({ title: "B", url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
  const gap = agent.reportGap(j1, {
    requirement: "Kubernetes in production",
    importance: "required",
    suggestedFact: { kind: "skill", text: "Used Kubernetes in production" },
  });
  return { db, agent, human, j1, j2, gap };
};

describe("confirming a gap", () => {
  it("saves a job-only fact and resolves the gap together", () => {
    const { db, agent, human, j1, j2, gap } = setup();
    const factId = human.confirmGap(gap, { kind: "skill", text: "Used Kubernetes in production" }, "job");
    expect(listOpenActions(db)).toHaveLength(0);
    expect(agent.listFacts(j1).map((f) => f.id)).toContain(factId);
    expect(agent.listFacts(j2).map((f) => f.id)).not.toContain(factId);
    expect(agent.listFacts(null)).toHaveLength(0);
    expect(listFacts(db)[0]?.sourceNote).toMatch(/Confirmed by the user/);
  });

  it("a job-only fact cannot be cited for another job", () => {
    const { agent, human, j1, j2, gap } = setup();
    const factId = human.confirmGap(gap, { kind: "skill", text: "Used Kubernetes in production" }, "job");
    const doc = (jobId: number) => ({ jobId, kind: "cv" as const, path: "cv.md", blocks: [{ text: "Used Kubernetes in production", factIds: [factId] }] });
    expect(agent.saveDocument(doc(j1)).version).toBe(1);
    expect(() => agent.saveDocument(doc(j2))).toThrow(/reserved for a different job/);
  });

  it("a general fact is usable everywhere, and a job-only one can be promoted later", () => {
    const { agent, human, j1, j2, gap } = setup();
    const factId = human.confirmGap(gap, { kind: "skill", text: "Used Kubernetes in production" }, "job");
    human.makeFactGeneral(factId);
    expect(agent.listFacts(j2).map((f) => f.id)).toContain(factId);
  });

  it("only a human can confirm, and a gap can only be confirmed once", () => {
    const { db, human, gap } = setup();
    expect(() => confirmGap(db, gap, { kind: "skill", text: "x" }, "general", "agent")).toThrow(/Only the user/);
    human.confirmGap(gap, { kind: "skill", text: "x" }, "general");
    expect(() => human.confirmGap(gap, { kind: "skill", text: "y" }, "general")).toThrow(/already resolved/);
    expect("confirmGap" in createAgentApi(db)).toBe(false);
  });

  it("leaves nothing behind when it fails", () => {
    const { db, human, gap } = setup();
    expect(() => human.confirmGap(gap, { kind: "skill", text: "   " }, "general")).toThrow();
    expect(listFacts(db)).toHaveLength(0);
    expect(listOpenActions(db)).toHaveLength(1);
  });

  it("rejects confirming something that is not a gap", () => {
    const { db, human, agent, j1 } = setup();
    const other = agent.queueAction("captcha", j1);
    expect(() => human.confirmGap(other, { kind: "skill", text: "x" }, "general")).toThrow(/not a gap/);
  });
});
