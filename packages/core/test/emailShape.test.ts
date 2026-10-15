import { describe, expect, it } from "vitest";
import { addEntry, addFact, createAgentApi, emailShapeProblems, openDb, saveDocument, setProfile } from "../src/index.js";

const H = "human" as const;
const b = (text: string, kind: "boilerplate" | "claim" = "boilerplate", factIds: number[] = []) => ({ text, factIds, kind });
const frame = (...body: ReturnType<typeof b>[]) => [b("Dear Hiring Manager,"), ...body, b("Best regards,")];

const setup = () => {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", location: "Addis Ababa", links: [], languages: [] }, H);
  addEntry(db, { kind: "work", title: "Engineer", organization: "Globex", startDate: "2021-01", isCurrent: true }, H);
  addEntry(db, { kind: "work", title: "Engineer", organization: "Initech", startDate: "2019-01", endDate: "2020-12" }, H);
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  return { db, fact };
};

describe("the application email format", () => {
  it("accepts the model: exact greeting, opening, a pitch with years, the close and the sign-off", () => {
    const { db, fact } = setup();
    const blocks = frame(b("I'm applying for the Software Engineer role at Runway."), b("I'm a software engineer with 3+ years building backend APIs, and I lead backend work at Globex.", "claim", [fact]), b("My CV and cover letter are attached. Happy to talk if it looks like a fit."));
    expect(emailShapeProblems(db, blocks, null, true).problems).toEqual([]);
    expect(emailShapeProblems(db, blocks, null, true).allow[2]).toEqual(["3"]);
  });

  it("wants the contact's first name when the contact has one, and exactly that greeting", () => {
    const { db } = setup();
    const blocks = [b("Dear Hiring Manager,"), b("I'm applying for the Software Engineer role at Runway."), b("Best regards,")];
    expect(emailShapeProblems(db, blocks, "Jane Doe", false).problems.join(" ")).toMatch(/exactly "Dear Jane,"/);
    expect(emailShapeProblems(db, [b("Dear hiring team,"), ...blocks.slice(1)], null, false).problems.join(" ")).toMatch(/exactly "Dear Hiring Manager,"/);
  });

  it("refuses the email that retells the cover letter: three employers, too long, and a phone in the sign-off", () => {
    const { db, fact } = setup();
    const long = "At Globex I built a full-stack platform in TypeScript, Node.js and React, and at Initech I led backend work on a healthcare platform that connects patients with doctors, and I also built many more things for clients that fill this email with detail the letter already has, including the stack, the team size, the users and the reasons for each choice.";
    const blocks = [b("Dear hiring team,"), b("I'm applying for the Software Engineer role at Runway."), b(long, "claim", [fact]), b("My CV and cover letter are attached."), b("Best regards, Ada +251 9 46")];
    const p = emailShapeProblems(db, blocks, null, true).problems.join(" | ");
    expect(p).toMatch(/exactly "Dear Hiring Manager,"/);
    expect(p).toMatch(/exactly "Best regards,"/);
    expect(p).toMatch(/words; keep it under 70/);
    expect(p).toMatch(/names 2 employers \(Globex, Initech\); name at most 1/);
  });

  it("wants the opening, the word 'attached' with a letter, and no years above the server's count", () => {
    const { db, fact } = setup();
    const noOpen = frame(b("I built a payments API serving 50000 users.", "claim", [fact]), b("My CV and cover letter are attached."));
    expect(emailShapeProblems(db, noOpen, null, true).problems.join(" ")).toMatch(/must start "I'm applying for/);
    const noAttach = frame(b("I'm applying for the Software Engineer role at Runway."), b("I'm a software engineer.", "claim", [fact]));
    expect(emailShapeProblems(db, noAttach, null, true).problems.join(" ")).toMatch(/attached/);
    expect(emailShapeProblems(db, noAttach, null, false).problems.join(" ")).not.toMatch(/attached/); // no letter: not required
    const tooManyYears = frame(b("I'm applying for the Software Engineer role at Runway."), b("I'm a software engineer with 20+ years of experience.", "claim", [fact]), b("My CV and cover letter are attached."));
    expect(emailShapeProblems(db, tooManyYears, null, true).problems.join(" ")).toMatch(/"20\+ years" is more than/);
  });

  it("allows more room when no letter is attached, and still caps the numbers", () => {
    const { db, fact } = setup();
    const two = frame(b("I'm applying for the Software Engineer role at Smartcuts."), b("At Globex I found why queries were slow. At Initech I led a system that cut creation time by 40% and served 50000 users.", "claim", [fact]), b("My CV is attached. Happy to talk if it looks like a fit."));
    expect(emailShapeProblems(db, two, null, false).problems).toEqual([]);
    const three = frame(b("I'm applying for the Software Engineer role at Smartcuts."), b("It cut time by 40% and served 50000 users and 12 teams.", "claim", [fact]), b("My CV is attached."));
    expect(emailShapeProblems(db, three, null, false).problems.join(" ")).toMatch(/3 numbers; keep at most 2/);
  });
});

describe("drafting through the agent API", () => {
  it("refuses a badly shaped email with every problem listed", () => {
    const { db, fact } = setup();
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Runway", domain: "runway.example" });
    const job = agent.addCandidateJob({ title: "Software Engineer", url: "https://runway.example/j/1", canonicalUrl: "https://runway.example/j/1", companyId: co }).id;
    agent.recordVerification(job, { result: "live" });
    agent.setMatch(job, 7, "fits");
    agent.setRoute(job, "email");
    saveDocument(db, { jobId: job, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    agent.transitionJob(job, "materials_ready");
    const contact = agent.addContact({ companyId: co, email: "jobs@runway.example", sourceUrl: "https://runway.example/careers" });
    expect(() => agent.draftEmail({ jobId: job, contactId: contact, blocks: [b("Dear team,"), b("Hello there.", "claim", [fact])] })).toThrow(/does not follow the format[\s\S]*exactly "Dear Hiring Manager,"[\s\S]*exactly "Best regards,"/);
  });
});

describe("how the body reads", () => {
  it("joins the blocks between the greeting and the sign-off into one paragraph", async () => {
    const { db, fact } = setup();
    const { composeBody } = await import("../src/index.js");
    const text = composeBody(db, frame(b("I'm applying for the Software Engineer role at Runway."), b("I lead backend work at Globex.", "claim", [fact]), b("My CV and cover letter are attached.")));
    expect(text).toBe("Dear Hiring Manager,\n\nI'm applying for the Software Engineer role at Runway. I lead backend work at Globex. My CV and cover letter are attached.\n\nBest regards,\nAda Lovelace\nada@example.com");
  });
});
