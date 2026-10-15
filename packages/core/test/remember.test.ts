import { describe, expect, it } from "vitest";
import { acceptProposal, addEntry, createAgentApi, createHumanApi, listFacts, openDb, proposeRemember, setStandardAnswer, type DB } from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const cards = (db: DB) => (db.prepare("SELECT id, payload FROM action_queue WHERE kind = 'sensitive_question' AND status = 'open'").all() as { id: number; payload: string }[]).map((r) => ({ id: r.id, ...JSON.parse(r.payload) }));
const answer = (over: object = {}) => ({ type: "answer" as const, label: "Equity preference", original: "i want some equity but not a big deal", polished: "I would like some equity, but it is not the deciding factor.", ...over });

describe("proposing to keep something the user said", () => {
  it("queues one card showing what they said and how it is worded", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const r = agent.proposeRemember(null, answer());
    expect(r.alreadyOpen).toBe(false);
    expect(agent.proposeRemember(null, answer({ label: "equity PREFERENCE" })).alreadyOpen).toBe(true);
    expect(cards(db)[0]!.proposal).toMatchObject({ type: "answer", label: "Equity preference", original: "i want some equity but not a big deal" });
    expect(createHumanApi(db).listStandardAnswers()).toEqual([]); // nothing is saved yet
  });

  it("never lets the polished wording add a number the user did not say", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const msg = throws(() => agent.proposeRemember(null, { type: "fact", kind: "experience", original: "I made the reporting service faster", polished: "Made the annotation service 40% faster." }));
    expect(msg).toMatch(/"40%".*did not say/);
    // a number they did say is fine, in any formatting
    expect(() => agent.proposeRemember(null, { type: "fact", kind: "achievement", original: "cut query time from 10 seconds to 2", polished: "Cut query time from 10 seconds to 2 seconds." })).not.toThrow();
  });

  it("refuses wording that is much longer than what was said, and empty or oversized text", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    expect(throws(() => agent.proposeRemember(null, answer({ original: "yes", polished: "x ".repeat(200) })))).toMatch(/much longer/);
    expect(throws(() => agent.proposeRemember(null, answer({ original: " " })))).toMatch(/both what the user said/);
    expect(throws(() => agent.proposeRemember(null, answer({ label: " " })))).toMatch(/needs the question/);
    expect(throws(() => agent.proposeRemember(null, { type: "fact", kind: "experience", original: "a".repeat(601), polished: "a".repeat(601) }))).toMatch(/600/);
    expect(throws(() => agent.proposeRemember(null, { type: "fact", kind: "hobby" as never, original: "x", polished: "x" }))).toMatch(/kind must be/);
  });

  it("will not propose what is already saved, and checks the role of a fact", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    setStandardAnswer(db, "Equity preference", "I would like some equity, but it is not the deciding factor.", H);
    expect(throws(() => agent.proposeRemember(null, answer()))).toMatch(/already saved/);
    expect(throws(() => agent.proposeRemember(null, { type: "fact", kind: "experience", entryId: 99, original: "x y", polished: "x y" }))).toMatch(/entry 99 not found/);
  });
});

describe("the user's click", () => {
  it("saves the answer as worded, as they said it, or as they edited it, and closes the card", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const labelled = (label: string) => createHumanApi(db).listStandardAnswers().find((s) => s.label === label)?.answer;
    agent.proposeRemember(null, answer());
    acceptProposal(db, cards(db)[0]!.id, { use: "polished" }, H);
    expect(labelled("Equity preference")).toBe("I would like some equity, but it is not the deciding factor.");
    expect(cards(db)).toHaveLength(0);
    agent.proposeRemember(null, answer({ label: "Company size", original: "small teams please", polished: "I prefer small teams." }));
    acceptProposal(db, cards(db)[0]!.id, { use: "original" }, H);
    expect(labelled("Company size")).toBe("small teams please");
    agent.proposeRemember(null, answer({ label: "Notice", original: "one week", polished: "One week." }));
    acceptProposal(db, cards(db)[0]!.id, { use: "text", text: "One week, negotiable." }, H);
    expect(labelled("Notice")).toBe("One week, negotiable.");
  });

  it("saves a fact under its role, with a note that the user confirmed it", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const entryId = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Contoso" }, H);
    agent.proposeRemember(null, { type: "fact", kind: "experience", entryId, original: "i used claude code to investigate the slow queries", polished: "Used Claude Code to investigate the slow queries." });
    expect(acceptProposal(db, cards(db)[0]!.id, {}, H)).toEqual({ saved: "fact" });
    const f = listFacts(db, { forJob: null }).find((x) => x.text.startsWith("Used Claude Code"))!;
    expect(f).toMatchObject({ kind: "experience", entryId });
    expect(f.sourceNote).toMatch(/confirmed by the user/);
  });

  it("also closes a question card that was waiting for the same answer", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    agent.askUser(null, { question: "Equity preference", options: ["a", "b"] });
    agent.proposeRemember(null, answer());
    expect(cards(db)).toHaveLength(2);
    acceptProposal(db, cards(db).find((c) => c.proposal)!.id, {}, H);
    expect(cards(db)).toHaveLength(0);
  });

  it("is for a person only, and refuses an unknown or finished proposal and empty text", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    agent.proposeRemember(null, answer());
    const id = cards(db)[0]!.id;
    expect(throws(() => acceptProposal(db, id, {}, "agent"))).toMatch(/Only the user/);
    expect(throws(() => acceptProposal(db, 999, {}, H))).toMatch(/no open proposal/);
    expect(throws(() => acceptProposal(db, id, { use: "text", text: " " }, H))).toMatch(/must have words/);
    acceptProposal(db, id, {}, H);
    expect(throws(() => acceptProposal(db, id, {}, H))).toMatch(/no open proposal/);
  });
});
