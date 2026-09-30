import { describe, expect, it } from "vitest";
import {
  addCandidateJob,
  listOpenActions,
  openDb,
  queueAction,
  resolveAction,
  transitionJob,
} from "../src/index.js";

const fresh = () => openDb(":memory:");
const job = { title: "Backend Engineer", url: "https://acme.example/jobs/1", canonicalUrl: "https://acme.example/jobs/1" };

describe("jobs", () => {
  it("dedupes by canonical url", () => {
    const db = fresh();
    const a = addCandidateJob(db, job);
    const b = addCandidateJob(db, job);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("lets the agent verify but never mark a job applied", () => {
    const db = fresh();
    const { id } = addCandidateJob(db, job);
    transitionJob(db, id, "verified_live", "agent");
    transitionJob(db, id, "matched", "agent");
    transitionJob(db, id, "materials_ready", "agent");
    transitionJob(db, id, "awaiting_approval", "agent");
    expect(() => transitionJob(db, id, "applied", "agent")).toThrow();
    transitionJob(db, id, "applied", "human");
  });

  it("rejects skipping states", () => {
    const db = fresh();
    const { id } = addCandidateJob(db, job);
    expect(() => transitionJob(db, id, "applied", "human")).toThrow();
  });
});

describe("action queue", () => {
  it("only a human resolves items", () => {
    const db = fresh();
    const id = queueAction(db, "signup_needed", null, { site: "acme.example" });
    expect(listOpenActions(db)).toHaveLength(1);
    expect(() => resolveAction(db, id, "done", "agent")).toThrow();
    resolveAction(db, id, "done", "human");
    expect(listOpenActions(db)).toHaveLength(0);
  });
});

describe("audit log", () => {
  it("is append-only", () => {
    const db = fresh();
    addCandidateJob(db, job);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE events SET type = 'x'").run()).toThrow(/append-only/);
  });
});
