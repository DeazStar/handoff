import { describe, expect, it } from "vitest";
import { checkObserved, checkProfileAnswer, checkStandardAnswer, resolveSources, openDb, setProfile, setPreferences, createAgentApi, createHumanApi, addFact, saveDocument, type Profile } from "../src/index.js";

const profile: Profile = {
  fullName: "Naod Ararsa Ulu", email: "naod@example.com", phone: "+251 911 234 567", location: "Addis Ababa, Ethiopia",
  links: ["https://www.linkedin.com/in/naod/", "https://github.com/naod"], languages: ["English", "Amharic"],
  workAuthorization: "Needs visa sponsorship", noticePeriod: "2 weeks", requiresSponsorship: true,
};
const saved = (label: string, answer: string) => ({ id: 1, label, answer });
const ctx = { profile, standard: [saved("Gender", "Male"), saved("Willing to relocate", "Yes, anywhere"), saved("How did you hear about us?", "The company website")] };

describe("sources", () => {
  it("accepts existing profile fields and saved answers", () => {
    expect(resolveSources(["profile:email"], "profile", ctx)).toMatchObject({ ok: true, fields: ["email"] });
    expect(resolveSources(["standard:gender"], "standard", ctx)).toMatchObject({ ok: true }); // label case does not matter
  });
  it("refuses an answer with no source, a made-up field, an empty field or a label that is not saved", () => {
    expect((resolveSources(undefined, "profile", ctx) as any).problem).toMatch(/must name where it comes from/);
    expect((resolveSources(["profile:shoeSize"], "profile", ctx) as any).problem).toMatch(/not a profile field/);
    expect((resolveSources(["profile:email"], "profile", { ...ctx, profile: { ...profile, email: undefined } }) as any).problem).toMatch(/nothing saved for email/);
    expect((resolveSources(["standard:Salary"], "standard", ctx) as any).problem).toMatch(/no saved standard answer called "Salary"/);
    expect((resolveSources(["profile:email"], "standard", ctx) as any).problem).toMatch(/must name the saved answer/);
  });
});

describe("profile answers", () => {
  const ok = (q: string, a: string, f: any[]) => checkProfileAnswer(q, a, f, profile).check;
  it("verifies exact values and parts of them", () => {
    expect(ok("Full name", "Naod Ararsa Ulu", ["fullName"])).toBe("verified");
    expect(ok("First name", "Naod", ["fullName"])).toBe("verified");
    expect(ok("Last name", "Ulu", ["fullName"])).toBe("verified");
    expect(ok("Email", "NAOD@example.com", ["email"])).toBe("verified");
    expect(ok("City", "Addis Ababa", ["location"])).toBe("verified");
    expect(ok("Country", "Ethiopia", ["location"])).toBe("verified");
    expect(ok("Phone", "0911234567", ["phone"])).toBe("verified");
    expect(ok("Phone", "251911234567", ["phone"])).toBe("verified");
    expect(ok("LinkedIn", "linkedin.com/in/naod", ["links"])).toBe("verified");
    expect(ok("Languages", "Amharic", ["languages"])).toBe("verified");
    expect(ok("Notice period", "2 weeks", ["noticePeriod"])).toBe("verified");
  });
  it("flags, and does not refuse, an answer that differs from its source", () => {
    const r = checkProfileAnswer("Email", "someone@else.com", ["email"], profile);
    expect(r.check).toBe("differs");
    expect(r.note).toMatch(/naod@example.com/);
    expect(ok("Phone", "12345678", ["phone"])).toBe("differs");
  });
  it("answers a sponsorship question from the sponsorship setting", () => {
    expect(ok("Will you require visa sponsorship?", "Yes", ["requiresSponsorship"])).toBe("verified");
    expect(ok("Will you require visa sponsorship?", "No", ["requiresSponsorship"])).toBe("differs");
    expect(checkProfileAnswer("Will you require visa sponsorship?", "Maybe", ["requiresSponsorship"], profile).check).toBe("unchecked");
    expect(checkProfileAnswer("Are you legally authorized to work in the US?", "No", ["requiresSponsorship"], profile).check).toBe("unchecked");
    const no = { ...profile, requiresSponsorship: false };
    expect(checkProfileAnswer("Do you need sponsorship?", "No", ["requiresSponsorship"], no).check).toBe("verified");
  });
});

describe("standard answers", () => {
  const std = (a: string, label: string, options?: string[]) => checkStandardAnswer(a, ctx.standard.filter((s) => s.label === label), options);
  it("verifies the same words, a sentence around them, and known synonyms", () => {
    expect(std("The company website", "How did you hear about us?").check).toBe("verified");
    expect(std("I found you through The company website", "How did you hear about us?").check).toBe("verified");
    expect(std("Man", "Gender").check).toBe("verified");
    expect(std("Yes", "Willing to relocate").check).toBe("verified");
  });
  it("flags an answer that contradicts the saved one", () => {
    expect(std("Female", "Gender").check).toBe("differs");
    expect(std("No", "Willing to relocate").check).toBe("differs");
  });
  it("does not call different wording wrong when it cannot tell", () => {
    expect(std("A friend told me", "How did you hear about us?").check).toBe("unchecked");
  });
  it("flags a choice that is not one of the form's options", () => {
    expect(std("Man", "Gender", ["Male", "Female"]).check).toBe("differs");
    expect(std("Male", "Gender", ["Male", "Female"]).check).toBe("verified");
  });
});

describe("observed value", () => {
  it("says nothing when the form shows the answer, and flags it when it does not", () => {
    expect(checkObserved("Ada", undefined)).toBeUndefined();
    expect(checkObserved("Ada Lovelace", "Ada Lovelace")).toBeUndefined();
    expect(checkObserved("Ada Lovelace", "Ada Lovelace Jr")).toBeUndefined();
    expect(checkObserved("Ada Lovelace", "")?.check).toBe("differs");
    expect(checkObserved("Ada Lovelace", "Bob")?.note).toMatch(/Bob/);
  });
});

describe("through prepare_application", () => {
  function setup() {
    const db = openDb(":memory:");
    setProfile(db, profile, "human");
    setPreferences(db, { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true }, "human");
    createHumanApi(db).setStandardAnswer("Gender", "Male");
    const agent = createAgentApi(db);
    const jobId = agent.addCandidateJob({ title: "E", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "form");
    const fact = addFact(db, { kind: "experience", text: "Built a payments API" }, "human");
    saveDocument(db, { jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API", factIds: [fact] }] }, "agent");
    agent.transitionJob(jobId, "materials_ready");
    const prepare = (answers: any[]) => agent.prepareApplication({ jobId, formUrl: "https://a.io/apply", answers, leftBlank: [] });
    return { agent, jobId, prepare };
  }
  it("saves each answer with its check, and a differing answer is saved, not refused", () => {
    const { agent, jobId, prepare } = setup();
    prepare([
      { question: "Email", answer: "naod@example.com", kind: "profile", from: ["profile:email"] },
      { question: "Phone", answer: "999 000 1111", kind: "profile", from: ["profile:phone"] },
      { question: "Gender", answer: "Female", kind: "standard", from: ["standard:Gender"] },
      { question: "Name", answer: "Naod Ararsa Ulu", kind: "profile", from: ["profile:fullName"], observed: "Naod" },
      { question: "Why us?", answer: "I built a payments API.", kind: "free_text", factIds: [1] },
    ]);
    const a = agent.getApplication(jobId)!.answers;
    expect(a.map((x) => x.check)).toEqual(["verified", "differs", "differs", "differs", "verified"]);
    expect(a[1]!.checkNote).toMatch(/profile says/);
    expect(a[2]!.from).toEqual(["standard:Gender"]);
  });
  it("refuses only an answer that names no real source", () => {
    const { prepare } = setup();
    expect(() => prepare([{ question: "Email", answer: "naod@example.com", kind: "profile" }])).toThrow(/must name where it comes from/);
    expect(() => prepare([{ question: "Pronouns", answer: "he/him", kind: "standard", from: ["standard:Pronouns"] }])).toThrow(/no saved standard answer called "Pronouns"/);
  });
  it("tells the user in the queue how many answers differ", () => {
    const { agent, prepare } = setup();
    prepare([{ question: "Phone", answer: "999 000 1111", kind: "profile", from: ["profile:phone"] }]);
    const q = (agent.listOpenActions() as any[]).find((x) => x.kind === "confirm_submit");
    expect(JSON.parse(q.payload).differ).toBe(1);
  });
});
