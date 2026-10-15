import { describe, expect, it } from "vitest";
import { addBullet, addEntry, addFact, countBulletsWithoutNumber, createAgentApi, createHumanApi, listFacts, listOpenActions, openDb } from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

const setup = () => {
  const db = openDb(":memory:");
  const work = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Acme", startDate: "2022-03", isCurrent: true }, H);
  const proj = addEntry(db, { kind: "project", title: "Booking site" }, H);
  const withNumber = addBullet(db, work, "Built a payments API serving 50000 users", H);
  const noNumber1 = addBullet(db, work, "Designed the authentication layer", H);
  const noNumber2 = addBullet(db, proj, "Booking platform with injection protection", H);
  const general = addFact(db, { kind: "skill", text: "Node.js" }, H); // not a bullet
  return { db, human: createHumanApi(db), agent: createAgentApi(db), withNumber, noNumber1, noNumber2, general };
};

describe("bullets that need a number", () => {
  it("finds only role and project bullets without a digit", () => {
    const { human } = setup();
    expect(human.countBulletsWithoutNumber()).toBe(2);
  });

  it("makes a few cards, never twice for the same bullet, and never again after 'I have no number'", () => {
    const { db, human } = setup();
    expect(human.requestMetricCards(1)).toBe(1);
    expect(human.requestMetricCards(5)).toBe(1); // only the other one is left, not a duplicate
    expect(human.requestMetricCards(5)).toBe(0);
    const cards = listOpenActions(db) as { id: number; payload: string }[];
    expect(cards).toHaveLength(2);
    human.resolveAction(cards[0]!.id, "dismissed");
    expect(human.requestMetricCards(5)).toBe(0); // dismissed means "stop asking"
  });

  it("updates the bullet for every job when the user adds a number, and refuses an answer with none", () => {
    const { db, human, noNumber1 } = setup();
    human.requestMetricCards(5);
    const card = (listOpenActions(db) as { id: number; payload: string }[]).find((c) => JSON.parse(c.payload).metricFactId === noNumber1)!;
    expect(throws(() => human.confirmMetric(card.id, "Designed the authentication layer"))).toMatch(/Add the number/);
    human.confirmMetric(card.id, "Designed the authentication layer used by 12000 patients");
    expect(listFacts(db).find((f) => f.id === noNumber1)).toMatchObject({ text: "Designed the authentication layer used by 12000 patients", jobId: undefined });
    expect((listOpenActions(db) as { id: number }[]).some((c) => c.id === card.id)).toBe(false);
    expect(countBulletsWithoutNumber(db)).toBe(0); // the other one already has its own card
    expect(throws(() => human.confirmMetric(card.id, "again 5"))).toMatch(/already resolved|not a number request/);
  });

  it("is never offered to Claude to draft, and only the user can create the cards", () => {
    const { human, agent } = setup();
    human.requestMetricCards(5);
    expect(human.requestGapDrafts({})).toBe(0);
    expect(agent.listGapDraftRequests()).toEqual([]);
    expect((agent as any).requestMetricCards).toBeUndefined();
  });
});

describe("typing the number and letting Claude word the bullet", () => {
  const card = (db: any, factId: number) => (listOpenActions(db) as { id: number; payload: string }[]).find((c) => JSON.parse(c.payload).metricFactId === factId)!;

  it("keeps the bullet and the typed number with the request, and shows both to Claude", () => {
    const { db, human, agent, noNumber1 } = setup();
    human.requestMetricCards(5);
    const c = card(db, noNumber1);
    expect(throws(() => human.requestMetricPolish(c.id, "a lot of users"))).toMatch(/Give the number/);
    human.requestMetricPolish(c.id, "about 12,000 patients");
    expect(agent.listGapPolishRequests()).toEqual([expect.objectContaining({ actionId: c.id, original: "Designed the authentication layer", numbers: "about 12,000 patients" })]);
  });

  it("accepts a bullet that carries exactly the typed number, and refuses one that drops it or adds another", () => {
    const { db, human, agent, noNumber1 } = setup();
    human.requestMetricCards(5);
    const c = card(db, noNumber1);
    human.requestMetricPolish(c.id, "about 12000 patients");
    expect(throws(() => agent.submitGapPolish(c.id, "Designed the authentication layer for patients."))).toMatch(/must carry the number/);
    expect(throws(() => agent.submitGapPolish(c.id, "Designed the authentication layer for 12000 patients in 3 countries."))).toMatch(/"3"/);
    agent.submitGapPolish(c.id, "Designed the authentication layer used by 12000 patients.");
    expect(JSON.parse((db.prepare("SELECT payload FROM action_queue WHERE id = ?").get(c.id) as { payload: string }).payload).polish).toMatchObject({ status: "ready", polished: "Designed the authentication layer used by 12000 patients." });
    human.confirmMetric(c.id, "Designed the authentication layer used by 12000 patients.");
    expect(listFacts(db).find((f) => f.id === noNumber1)?.text).toMatch(/12000 patients/);
  });

  it("is only for number cards", () => {
    const { human, general } = setup();
    expect(throws(() => human.requestMetricPolish(general, "5 users"))).toMatch(/not found|not a number request/);
  });
});
