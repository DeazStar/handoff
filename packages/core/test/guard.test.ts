import { describe, expect, it } from "vitest";
import { createAgentApi, createHumanApi, openDb, addCandidateJob, transitionJob } from "../src/index.js";

const job = { title: "Backend Engineer", url: "https://acme.example/jobs/1", canonicalUrl: "https://acme.example/jobs/1" };

describe("state guard trigger", () => {
  it("blocks direct state updates", () => {
    const db = openDb(":memory:");
    const { id } = addCandidateJob(db, job);
    expect(() => db.prepare("UPDATE jobs SET state = 'applied' WHERE id = ?").run(id)).toThrow(
      /only change through transitionJob/,
    );
  });

  it("blocks creating a job in any state but found", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO jobs (title, url, canonical_url, state) VALUES ('x','u','u','applied')").run(),
    ).toThrow(/state found/);
  });

  it("allows transitionJob, and closes the guard afterwards", () => {
    const db = openDb(":memory:");
    const { id } = addCandidateJob(db, job);
    transitionJob(db, id, "verified_live", "agent");
    expect(() => db.prepare("UPDATE jobs SET state = 'matched' WHERE id = ?").run(id)).toThrow();
  });

  it("closes the guard when a transition fails", () => {
    const db = openDb(":memory:");
    const { id } = addCandidateJob(db, job);
    expect(() => transitionJob(db, id, "applied", "agent")).toThrow();
    expect(() => db.prepare("UPDATE jobs SET state = 'verified_live' WHERE id = ?").run(id)).toThrow();
  });

  it("still allows updating other columns", () => {
    const db = openDb(":memory:");
    const { id } = addCandidateJob(db, job);
    db.prepare("UPDATE jobs SET match_score = 0.9 WHERE id = ?").run(id);
  });
});

describe("agent api", () => {
  it("cannot apply or resolve queue items", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const human = createHumanApi(db);
    const { id } = agent.addCandidateJob(job);
    for (const s of ["verified_live", "matched", "materials_ready", "awaiting_approval"] as const) {
      agent.transitionJob(id, s);
    }
    expect(() => agent.transitionJob(id, "applied")).toThrow();
    expect("resolveAction" in agent).toBe(false);
    const qid = agent.queueAction("confirm_submit", id);
    human.resolveAction(qid, "done");
    human.transitionJob(id, "applied");
  });
});
