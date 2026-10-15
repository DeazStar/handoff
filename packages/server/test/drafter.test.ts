import { describe, expect, it } from "vitest";
import { createDrafter, findClaude, readGapsPrompt, DRAFT_TOOLS } from "../src/drafter.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const make = (run?: (p: string) => Promise<string | null>, claudePath: string | null = "/x/claude") => createDrafter({ mcpMain: "/x/main.js", prompt: "do it", mcpEnv: {}, claudePath, run });

describe("the gap drafter", () => {
  it("runs one pass at a time and reports when it is done", async () => {
    let calls = 0;
    let release!: () => void;
    const d = make(() => { calls++; return new Promise((r) => { release = () => r(null); }); });
    expect(d.start()).toBe(true);
    expect(d.start()).toBe(true);
    expect(calls).toBe(1);
    expect(d.status()).toMatchObject({ running: true, error: null });
    release();
    await wait(5);
    expect(d.status()).toMatchObject({ running: false, error: null });
    expect(d.status().finishedAt).not.toBeNull();
  });

  it("keeps the error when a pass fails, and clears it on the next pass", async () => {
    let fail = true;
    const d = make(async () => (fail ? "Claude is not signed in" : null));
    d.start();
    await wait(5);
    expect(d.status().error).toBe("Claude is not signed in");
    fail = false;
    d.start();
    await wait(5);
    expect(d.status().error).toBeNull();
  });

  it("says it is unavailable when Claude is not installed", () => {
    const d = make(undefined, null);
    expect(d.start()).toBe(false);
    expect(d.status().available).toBe(false);
  });

  it("only lets a drafting run read and draft: no browser, shell or sending", () => {
    expect(DRAFT_TOOLS.every((t) => t.startsWith("mcp__jobhunt__"))).toBe(true);
    expect(DRAFT_TOOLS.join(" ")).not.toMatch(/send|submit|apply|vault|resolve|confirm/);
  });

  it("finds Claude from JOBHUNT_CLAUDE and falls back to a built-in prompt", () => {
    expect(findClaude({ JOBHUNT_CLAUDE: process.execPath })).toBe(process.execPath);
    expect(readGapsPrompt("/no/such/file")).toMatch(/list_gap_draft_requests/);
  });
});
