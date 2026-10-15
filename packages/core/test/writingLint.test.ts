import { describe, expect, it } from "vitest";
import { assertWellWritten, lintWriting } from "../src/index.js";

const rules = (t: string) => lintWriting(t).map((i) => i.rule);

describe("the writing checks", () => {
  it("refuses the exact message that opened with the user, listed tools and commented on sponsorship", () => {
    const bad = "Hi Carlos, I'm Naod. I built a platform in TypeScript. I would need visa sponsorship, and I see you offer it.";
    expect(rules(bad)).toEqual(expect.arrayContaining(["opens with the user", "narrates the application"]));
  });

  it("catches a form-letter opener, filler words, volunteered gaps, chatbot leftovers and many dashes", () => {
    expect(rules("I am writing to apply for the role.")).toContain("form-letter opening");
    expect(rules("Your product is a good fit. I am writing to apply.")).toContain("form-letter opening");
    expect(rules("I am passionate about building seamless systems.")).toContain("filler word");
    expect(rules("Your stack is Go. I have not used Go yet, but I learn fast.")).toContain("volunteers a gap");
    expect(rules("I hope this email finds you well.")).toContain("chatbot leftover");
    expect(rules("It was fast — and cheap — and simple.")).toContain("too many dashes");
  });

  it("accepts the model message and the plain opener 'I'm applying for', and refuses the stiff and stock versions", () => {
    const model = "Hi Brian, I'm applying for the Software Engineer role at Smartcuts. At Rejuive I found why our slowest Neo4j queries were slow: a generator was producing Cypher that joined unrelated matches. I rebuilt them to stop that. At Metamat I led an AI-assisted code generation system for 3D models that cut model creation time by 40%, and I also build full-stack products in TypeScript, Next.js and React. Happy to talk if it looks like a fit.";
    expect(lintWriting(model)).toEqual([]);
    expect(rules("Hi Carlos, I'm Naod. I built a platform.")).toContain("opens with the user");
    expect(rules("Hi Carlos, I'm a full-stack engineer who builds platforms.")).toContain("opens with the user");
    expect(rules("Finding page elements is a hard problem, and it is the part that caught my attention.")).toContain("stock line");
    expect(rules("A small team building a platform is the kind of role I'm looking for.")).toContain("stock line");
    expect(rules("I would be glad to talk through any of it.")).toContain("stock line");
    expect(rules("I built a platform and " + "then ".repeat(40) + "finished it.")).toContain("long sentence");
  });

  it("accepts a message that opens with them and says things plainly", () => {
    const good = "Hi Carlos, I'm applying for the Product Engineer role at Fractional. I lead backend at Medukul and own its REST APIs, authentication and database design. At Rejuive I fixed the slowest queries on a Neo4j platform. I'd need visa sponsorship. Happy to talk if it looks like a fit.";
    expect(lintWriting(good)).toEqual([]);
  });

  it("only checks the opening of the first part, so a later paragraph may begin with I'm a...", () => {
    expect(() => assertWellWritten(["I'm applying for the Backend Engineer role at Acme. Fine.", "I'm a freelancer who built a mobile app."], "The letter")).not.toThrow();
    expect(() => assertWellWritten(["I'm a developer who builds things.", "Fine."], "The letter")).toThrow(/opens with the user/);
  });

  it("lists every problem of every part in one error", () => {
    expect(() => assertWellWritten(["I'm Naod, a developer.", "I hope this email finds you well."], "The email")).toThrow(/part 1[\s\S]*part 2/);
    expect(() => assertWellWritten(["Fine, plain text."], "The email")).not.toThrow();
  });
});
