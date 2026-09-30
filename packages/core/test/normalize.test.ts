import { describe, expect, it } from "vitest";
import { canonicalizeUrl, hashDescription } from "../src/index.js";

describe("canonicalizeUrl", () => {
  it("maps variants of one link to one string", () => {
    const want = "https://acme.com/careers/backend-engineer-123";
    for (const u of [
      "https://acme.com/careers/backend-engineer-123",
      "https://acme.com/careers/backend-engineer-123?utm_source=google",
      "https://acme.com/careers/backend-engineer-123?ref=linkedin&utm_campaign=x",
      "https://ACME.com/careers/backend-engineer-123/",
      "http://www.acme.com/careers/backend-engineer-123#apply",
    ]) {
      expect(canonicalizeUrl(u)).toBe(want);
    }
  });

  it("keeps parameters that identify the job, in stable order", () => {
    expect(canonicalizeUrl("https://jobs.example/view?b=2&id=123&utm_medium=x")).toBe(
      "https://jobs.example/view?b=2&id=123",
    );
    expect(canonicalizeUrl("https://jobs.example/view?id=123&b=2")).toBe(
      canonicalizeUrl("https://jobs.example/view?b=2&id=123"),
    );
  });

  it("keeps different jobs distinct", () => {
    expect(canonicalizeUrl("https://jobs.example/view?id=1")).not.toBe(
      canonicalizeUrl("https://jobs.example/view?id=2"),
    );
  });

  it("rejects non-web and invalid urls", () => {
    expect(() => canonicalizeUrl("mailto:hr@acme.com")).toThrow();
    expect(() => canonicalizeUrl("not a url")).toThrow();
  });
});

describe("hashDescription", () => {
  it("ignores case, markup and punctuation", () => {
    expect(hashDescription("<p>We are hiring a Backend Engineer!</p>")).toBe(
      hashDescription("we are hiring   a backend engineer"),
    );
  });

  it("differs for different text and is null for empty text", () => {
    expect(hashDescription("Backend Engineer")).not.toBe(hashDescription("Frontend Engineer"));
    expect(hashDescription("  <br/> !!! ")).toBeNull();
  });
});
