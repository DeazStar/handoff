import { describe, expect, it } from "vitest";
import { createAgentApi, createHumanApi, getSiteProfile, listOpenActions, openDb } from "../src/index.js";

const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

describe("remembering that a site's profile is finished", () => {
  it("is unknown at first, and one name covers every address of a site", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    expect(agent.siteProfileStatus("https://www.workatastartup.com/application")).toMatchObject({ complete: false, unknown: true });
    createHumanApi(db).setSiteProfile("account.ycombinator.com", true);
    expect(getSiteProfile(db, "https://www.workatastartup.com/jobs/1")).toMatchObject({ complete: true, site: "ycombinator.com", source: "user" });
  });

  it("lets the agent record 'complete' only with evidence, and 'incomplete' freely", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    expect(throws(() => agent.markSiteProfile("workatastartup.com", true))).toMatch(/Say what showed it/);
    expect(throws(() => agent.markSiteProfile("workatastartup.com", true, "ok"))).toMatch(/Say what showed it/);
    expect(agent.markSiteProfile("workatastartup.com", true, "clicked Apply and the application message box opened")).toMatchObject({ complete: true, source: "agent" });
    expect(agent.markSiteProfile("workatastartup.com", false)).toMatchObject({ complete: false });
  });

  it("stops asking for a profile that is complete, and asks again after it is marked not finished", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const human = createHumanApi(db);
    const first = agent.requestProfileFill(null, { pageUrl: "https://www.workatastartup.com/application" });
    expect(first.alreadyOpen).toBe(false);
    human.setSiteProfile("workatastartup.com", true); // the user pressed "It is filled in"
    expect((listOpenActions(db) as { kind: string }[]).filter((a) => a.kind === "signup_needed")).toHaveLength(0); // its card closed
    expect(throws(() => agent.requestProfileFill(null, { pageUrl: "https://www.workatastartup.com/application" }))).toMatch(/already marked complete[\s\S]*mark_site_profile/);
    agent.markSiteProfile("workatastartup.com", false); // clicking Apply sent it back to the profile
    expect(agent.requestProfileFill(null, { pageUrl: "https://www.workatastartup.com/application" }).alreadyOpen).toBe(false);
  });

  it("is listed for the user, and only the user can say 'marked by you'", () => {
    const db = openDb(":memory:");
    const human = createHumanApi(db);
    human.setSiteProfile("acme.example", true);
    expect(human.listSiteProfiles()).toEqual([expect.objectContaining({ site: "acme.example", complete: true, source: "user", evidence: "marked by you" })]);
    expect((createAgentApi(db) as any).setSiteProfile).toBeUndefined();
  });
});
