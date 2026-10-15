import { describe, expect, it } from "vitest";
import { addFact, createAgentApi, createHumanApi, listOpenActions, openDb } from "../src/index.js";

const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const gapPayload = (db: ReturnType<typeof openDb>, id: number) => JSON.parse((db.prepare("SELECT payload FROM action_queue WHERE id = ?").get(id) as { payload: string }).payload);

const setup = () => {
  const db = openDb(":memory:");
  const agent = createAgentApi(db);
  const human = createHumanApi(db);
  const j1 = agent.addCandidateJob({ title: "A", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  const j2 = agent.addCandidateJob({ title: "B", url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
  const g1 = agent.reportGap(j1, { requirement: "Kubernetes in production" });
  const g2 = agent.reportGap(j1, { requirement: "Terraform" });
  const g3 = agent.reportGap(j2, { requirement: "Go services" });
  addFact(db, { kind: "experience", text: "Deployed 3 services on Kubernetes at Acme" }, "human");
  return { db, agent, human, j1, j2, g1, g2, g3 };
};

describe("drafting gaps with Claude", () => {
  it("marks one gap, one job's gaps or all, and the agent sees only the marked ones", () => {
    const { agent, human, j1, g1 } = setup();
    expect(agent.listGapDraftRequests()).toEqual([]);
    expect(human.requestGapDrafts({ actionId: g1 })).toBe(1);
    expect(human.requestGapDrafts({ actionId: g1 })).toBe(0); // already waiting
    expect(human.requestGapDrafts({ jobId: j1 })).toBe(1); // only Terraform was left
    expect(agent.listGapDraftRequests().map((r) => r.requirement).sort()).toEqual(["Kubernetes in production", "Terraform"]);
    expect(human.requestGapDrafts({})).toBe(1);
    expect(agent.listGapDraftRequests()).toHaveLength(3);
  });

  it("stores a draft for the user to confirm without saving any fact", () => {
    const { db, agent, human, g1 } = setup();
    human.requestGapDrafts({ actionId: g1 });
    agent.submitGapDraft(g1, { kind: "experience", text: "Deployed 3 services on Kubernetes at Acme" }, "From your Acme role");
    const p = gapPayload(db, g1);
    expect(p.draft).toMatchObject({ status: "ready", note: "From your Acme role" });
    expect(p.suggestedFact.text).toMatch(/Kubernetes/);
    expect(agent.listGapDraftRequests()).toEqual([]);
    expect(listOpenActions(db)).toHaveLength(3); // still open
    expect(db.prepare("SELECT count(*) AS n FROM facts").get()).toEqual({ n: 1 });
  });

  it("records 'nothing to draft from' and refuses numbers no fact has", () => {
    const { db, agent, human, g1, g2 } = setup();
    human.requestGapDrafts({});
    expect(throws(() => agent.submitGapDraft(g1, { kind: "experience", text: "Ran 40 clusters" }))).toMatch(/"40"/);
    agent.submitGapDraft(g2, null, "No Terraform in your facts");
    expect(gapPayload(db, g2).draft).toEqual({ status: "none", note: "No Terraform in your facts" });
    expect(gapPayload(db, g2).suggestedFact).toBeUndefined();
  });

  it("refuses a draft nobody asked for, and lets only the human ask or cancel", () => {
    const { agent, human, g1 } = setup();
    expect(throws(() => agent.submitGapDraft(g1, null, "x"))).toMatch(/Nobody asked/);
    human.requestGapDrafts({ actionId: g1 });
    expect(human.cancelGapDrafts({ actionId: g1 })).toBe(1);
    expect(agent.listGapDraftRequests()).toEqual([]);
    expect(throws(() => human.requestGapDrafts({ actionId: 9999 }))).toMatch(/not found/);
    expect((agent as any).requestGapDrafts).toBeUndefined();
  });

  it("keeps a waiting request when the same gap is reported again", () => {
    const { db, agent, human, j1, g1 } = setup();
    human.requestGapDrafts({ actionId: g1 });
    agent.reportGap(j1, { requirement: "kubernetes in production", detail: "newer detail" });
    expect(gapPayload(db, g1)).toMatchObject({ detail: "newer detail", draft: { status: "requested" } });
  });
});

describe("improving the user's own wording", () => {
  it("keeps the user's text with the request and stores Claude's version beside it", () => {
    const { db, agent, human, g1 } = setup();
    human.requestGapPolish(g1, "i deployed 3 services on kubernetes at acme");
    expect(agent.listGapPolishRequests()).toEqual([expect.objectContaining({ actionId: g1, original: "i deployed 3 services on kubernetes at acme" })]);
    agent.submitGapPolish(g1, "I deployed 3 services on Kubernetes at Acme.", "Fixed capitals");
    expect(gapPayload(db, g1).polish).toMatchObject({ status: "ready", original: "i deployed 3 services on kubernetes at acme", polished: "I deployed 3 services on Kubernetes at Acme." });
    expect(agent.listGapPolishRequests()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM facts").get()).toEqual({ n: 1 }); // nothing saved
    human.clearGapPolish(g1);
    expect(gapPayload(db, g1).polish).toBeUndefined();
  });

  it("refuses wording that adds a number, grows a lot, or that nobody asked for", () => {
    const { agent, human, g1 } = setup();
    expect(throws(() => agent.submitGapPolish(g1, "x"))).toMatch(/Nobody asked/);
    human.requestGapPolish(g1, "i ran some clusters");
    expect(throws(() => agent.submitGapPolish(g1, "I ran 12 clusters."))).toMatch(/"12"/);
    expect(throws(() => agent.submitGapPolish(g1, "I ran clusters. ".repeat(40)))).toMatch(/much longer/);
    expect(throws(() => human.requestGapPolish(g1, "   "))).toMatch(/Write something/);
    expect(throws(() => human.requestGapPolish(9999, "text"))).toMatch(/not found/);
  });

  it("survives the gap being reported again", () => {
    const { db, agent, human, j1, g1 } = setup();
    human.requestGapPolish(g1, "my words");
    agent.reportGap(j1, { requirement: "Kubernetes in production" });
    expect(gapPayload(db, g1).polish).toMatchObject({ status: "requested", original: "my words" });
  });
});

describe("a job that is skipped or dead", () => {
  it("takes its open cards out of the user's queue", () => {
    const { db, agent, human, j1, j2 } = setup();
    agent.queueAction("captcha", j1, {});
    expect(listOpenActions(db)).toHaveLength(4);
    human.transitionJob(j1, "skipped", "not for me");
    const left = listOpenActions(db) as { job_id: number }[];
    expect(left).toHaveLength(1);
    expect(left[0]!.job_id).toBe(j2);
  });
});

describe("the writing style setting", () => {
  it("is saved with the preferences, trimmed, and limited in length", () => {
    const { db, human } = setup();
    const base = { roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 10 };
    human.setPreferences({ ...base, writingStyle: "  Plain and warm. Short sentences.  " });
    expect(human.getPreferences()?.writingStyle).toBe("Plain and warm. Short sentences.");
    human.setPreferences({ ...base });
    expect(human.getPreferences()?.writingStyle).toBeUndefined();
    expect(throws(() => human.setPreferences({ ...base, writingStyle: "x".repeat(1501) }))).toMatch(/at most 1500/);
    expect(db.prepare("SELECT count(*) AS n FROM preferences").get()).toEqual({ n: 1 });
  });
});

describe("sending a job back to matched", () => {
  it("lets only the user send a materials_ready job back, so its materials are made again", () => {
    const { db, agent, human, j1 } = setup();
    agent.recordVerification(j1, { result: "live" });
    agent.setMatch(j1, 7, "fits");
    agent.transitionJob(j1, "materials_ready");
    expect(throws(() => agent.transitionJob(j1, "matched"))).toMatch(/not allowed|may not|cannot/i);
    human.transitionJob(j1, "matched", "redo with the new rules");
    expect((db.prepare("SELECT state FROM jobs WHERE id = ?").get(j1) as { state: string }).state).toBe("matched");
    agent.transitionJob(j1, "materials_ready"); // and the agent can build again
  });
});
