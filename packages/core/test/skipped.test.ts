import { describe, expect, it } from "vitest";
import { createAgentApi, openDb } from "../src/index.js";

const setup = () => {
  const db = openDb(":memory:");
  return { db, agent: createAgentApi(db) };
};

describe("remembering rejected links", () => {
  it("knows a link is new, then skipped, whatever tracking is on it", () => {
    const { agent } = setup();
    expect(agent.checkCandidate("https://old.example/jobs/9?utm_source=x")).toMatchObject({ known: null, canonicalUrl: "https://old.example/jobs/9" });
    agent.logSkippedCandidate({ url: "https://www.old.example/jobs/9/", reason: "dead", detail: "HTTP 410" });
    expect(agent.checkCandidate("https://old.example/jobs/9?ref=abc")).toMatchObject({ known: "skipped", reason: "dead", detail: "HTTP 410" });
  });

  it("recognises links that are already jobs", () => {
    const { agent } = setup();
    const { id } = agent.addCandidateJob({ title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
    expect(agent.checkCandidate("https://a.io/1?utm_medium=x")).toMatchObject({ known: "job", jobId: id, state: "found" });
  });

  it("does not use the discovery budget, and logging twice just updates it", () => {
    const { db, agent } = setup();
    agent.logSkippedCandidate({ url: "https://a.io/x", reason: "blocked" });
    agent.logSkippedCandidate({ url: "https://a.io/x", reason: "closed", detail: "filled" });
    expect(agent.discoveryBudget().addedToday).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM skipped_candidates").get()).toEqual({ n: 1 });
    expect(agent.checkCandidate("https://a.io/x")).toMatchObject({ reason: "closed" });
  });

  it("counts skipped links per source", () => {
    const { db, agent } = setup();
    const src = agent.upsertSource({ kind: "jobsite", name: "board.example" });
    agent.logSkippedCandidate({ url: "https://board.example/a", reason: "dead", sourceId: src });
    agent.logSkippedCandidate({ url: "https://board.example/b", reason: "repost", sourceId: src });
    const row = db.prepare("SELECT skipped, found FROM source_stats WHERE source_id = ?").get(src);
    expect(row).toEqual({ skipped: 2, found: 0 });
  });

  it("rejects bad input", () => {
    const { agent } = setup();
    expect(() => agent.checkCandidate("not a url")).toThrow();
    expect(() => agent.logSkippedCandidate({ url: "mailto:a@b.c", reason: "dead" })).toThrow();
    expect(() => agent.logSkippedCandidate({ url: "https://a.io/x", reason: "bogus" as never })).toThrow();
  });
});
