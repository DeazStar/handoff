import { describe, expect, it } from "vitest";
import {
  addCandidateJob, addFact, checkProvenance, createAgentApi, createHumanApi, getDocument,
  listDocuments, listOpenActions, migrate, numberTokens, queueAction, saveDocument,
} from "../src/index.js";
import { openDb } from "../src/index.js";
import Database from "better-sqlite3";

describe("whole-number matching", () => {
  it("tokenizes numbers, treating thousands separators as equal", () => {
    expect(numberTokens("50,000 users, 50000 again, 3.5 years, 40%.")).toEqual(["50000", "50000", "3.5", "40%"]);
  });

  it("does not find 5 inside 50000", () => {
    const db = openDb(":memory:");
    const a = addFact(db, { kind: "experience", text: "Served 50000 users" }, "human");
    expect(checkProvenance(db, [{ text: "5 years serving users", factIds: [a] }])).toHaveLength(1);
    expect(checkProvenance(db, [{ text: "Served 50,000 users", factIds: [a] }])).toHaveLength(0);
  });

  it("treats a percentage as different from a count", () => {
    const db = openDb(":memory:");
    const a = addFact(db, { kind: "achievement", text: "Cut costs by 40 dollars" }, "human");
    expect(checkProvenance(db, [{ text: "Cut costs by 40%", factIds: [a] }])).toHaveLength(1);
  });

  it("still checks dates from the date range", () => {
    const db = openDb(":memory:");
    const a = addFact(db, { kind: "experience", text: "Backend developer", dateRange: "2022-2024" }, "human");
    expect(checkProvenance(db, [{ text: "Backend developer 2022-2024", factIds: [a] }])).toHaveLength(0);
    expect(checkProvenance(db, [{ text: "Backend developer since 2020", factIds: [a] }])).toHaveLength(1);
  });
});

describe("stored document content", () => {
  it("keeps the exact blocks and returns them", () => {
    const db = openDb(":memory:");
    const a = addFact(db, { kind: "skill", text: "TypeScript" }, "human");
    const { id: jobId } = addCandidateJob(db, { title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
    const blocks = [
      { text: "Dear hiring team,", factIds: [], kind: "boilerplate" as const },
      { text: "I write TypeScript.", factIds: [a] },
    ];
    const { id } = saveDocument(db, { jobId, kind: "email", path: "e.txt", blocks }, "agent");
    expect(getDocument(db, id)?.blocks).toEqual(blocks);
    expect(listDocuments(db, jobId)).toHaveLength(1);
    expect(getDocument(db, 999)).toBeNull();
  });
});

describe("gap action", () => {
  it("lets the agent report a gap, and a human resolve it", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const human = createHumanApi(db);
    const { id: jobId } = agent.addCandidateJob({ title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
    const qid = agent.reportGap(jobId, { requirement: "5 years of Kubernetes", detail: "No fact mentions Kubernetes" });
    const open = listOpenActions(db) as any[];
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("gap");
    expect(JSON.parse(open[0].payload).requirement).toBe("5 years of Kubernetes");
    human.resolveAction(qid, "dismissed");
    expect(listOpenActions(db)).toHaveLength(0);
  });

  it("upgrading from schema 2 keeps existing queue items", () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    migrate(raw, 2);
    queueAction(raw as any, "captcha", null, { site: "x" });
    migrate(raw);
    const rows = raw.prepare("SELECT kind, payload FROM action_queue").all() as any[];
    expect(rows).toEqual([{ kind: "captcha", payload: '{"site":"x"}' }]);
    queueAction(raw as any, "gap", null, {});
  });
});
