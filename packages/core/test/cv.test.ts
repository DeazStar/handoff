import { describe, expect, it } from "vitest";
import {
  canonicalCountry, requireCountry,
  ProvenanceError, addBullet, addEntry, addFact, createAgentApi, createHumanApi, deleteEntry, getCvMaterial,
  getDocument, getPreferences, importCv, listEntries, moveEntry, openDb, orderForCv, prepareCv, saveDocument, setPreferences, setProfile, setSkillGroup, updateEntry,
} from "../src/index.js";

const H = "human" as const;
const setup = () => {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: ["https://ada.dev"], languages: [] }, H);
  const acme = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Acme", startDate: "2022-03", endDate: "2024-01" }, H);
  const beta = addEntry(db, { kind: "work", title: "Engineer", organization: "Beta", startDate: "2020", isCurrent: true }, H);
  const proj = addEntry(db, { kind: "project", title: "Web server in C" }, H);
  const edu = addEntry(db, { kind: "education", title: "BSc Software Engineering", organization: "AASTU", startDate: "2020", endDate: "2025", note: "GPA: 3.82" }, H);
  const a1 = addBullet(db, acme, "Built a payments API serving 50000 users", H);
  const a2 = addBullet(db, acme, "Cut query time by 40%", H);
  const b1 = addBullet(db, beta, "Maintained 12 services", H);
  const p1 = addBullet(db, proj, "HTTP 1.1 server with boundary checks", H);
  setSkillGroup(db, "Backend", ["Node.js", "Rust"], H);
  setSkillGroup(db, "Databases", ["MySQL"], H);
  const skill = (t: string) => (db.prepare("SELECT id FROM facts WHERE text = ?").get(t) as { id: number }).id;
  return { db, acme, beta, proj, edu, a1, a2, b1, p1, skill };
};

describe("entries", () => {
  it("validates dates and keeps kinds apart", () => {
    const { db } = setup();
    expect(() => addEntry(db, { kind: "work", title: "x", startDate: "March 2022" }, H)).toThrow(/Dates look like/);
    expect(() => addEntry(db, { kind: "work", title: "x", startDate: "2024", endDate: "2022" }, H)).toThrow(/end date is before/);
    expect(() => addEntry(db, { kind: "work", title: " " }, H)).toThrow(/needs a title/);
    expect(() => addEntry(db, { kind: "work", title: "x" }, "agent")).toThrow(/Only the user/);
    const e = listEntries(db, "work")[1]!;
    expect(e).toMatchObject({ isCurrent: true, endDate: undefined });
    expect(() => updateEntry(db, e.id, { kind: "project", title: "x" }, H)).toThrow(/kind cannot change/);
  });

  it("orders and moves entries within a kind", () => {
    const { db, acme, beta } = setup();
    expect(listEntries(db, "work").map((e) => e.id)).toEqual([acme, beta]);
    moveEntry(db, beta, "up", H);
    expect(listEntries(db, "work").map((e) => e.id)).toEqual([beta, acme]);
    moveEntry(db, beta, "up", H); // already first: nothing happens
    expect(listEntries(db, "work").map((e) => e.id)).toEqual([beta, acme]);
  });

  it("deletes an entry with its bullets, unless a saved document cites one", () => {
    const { db, beta, acme, a1 } = setup();
    deleteEntry(db, beta, H);
    expect(listEntries(db, "work")).toHaveLength(1);
    const { cv, blocks, factIds } = prepareCv(db, { experience: [{ entryId: acme, bullets: [a1] }] }, null);
    saveDocument(db, { jobId: null, kind: "cv", path: "cv.pdf", blocks, extraFactIds: factIds }, "agent");
    expect(cv.experience).toHaveLength(1);
    expect(() => deleteEntry(db, acme, H)).toThrow(/cited by/);
    expect(listEntries(db, "work")).toHaveLength(1);
  });
});

describe("skills", () => {
  it("keeps a group in step with the list, and groups can share a skill name", () => {
    const { db } = setup();
    setSkillGroup(db, "Backend", ["Node.js", "Python", "node.js"], H);
    const m = getCvMaterial(db, null);
    expect(m.skills.find((g) => g.group === "Backend")!.skills.map((s) => s.text)).toEqual(["Node.js", "Python"]);
    setSkillGroup(db, "Blockchain", ["Rust"], H);
    expect(m.skills.length).toBe(2);
    expect(getCvMaterial(db, null).skills.map((g) => g.group)).toEqual(["Backend", "Databases", "Blockchain"]);
  });
});

describe("importing a CV", () => {
  it("loads entries, bullets and skills into an empty CV, once", () => {
    const db = openDb(":memory:");
    const data = {
      entries: [
        { kind: "work" as const, title: "Dev", organization: "X", bullets: ["Did a thing", "Did another"] },
        { kind: "education" as const, title: "BSc", organization: "Y", startDate: "2020", endDate: "2025", note: "GPA: 3.82" },
      ],
      skills: [{ group: "Backend", items: ["Node.js", "Rust"] }],
    };
    expect(importCv(db, data, H)).toEqual({ entries: 2, bullets: 2, skills: 2 });
    expect(getCvMaterial(db, null).entries[0]!.bullets).toHaveLength(2);
    expect(() => importCv(db, data, H)).toThrow(/already has entries/);
    expect(() => importCv(openDb(":memory:"), data, "agent")).toThrow(/Only the user/);
  });
});

describe("what the agent can see", () => {
  it("offers entries with their bullets and leaves out facts reserved for other jobs", () => {
    const { db, acme } = setup();
    const agent = createAgentApi(db);
    const j1 = agent.addCandidateJob({ title: "A", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    const j2 = agent.addCandidateJob({ title: "B", url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
    const only = addFact(db, { kind: "experience", text: "Used Kubernetes", entryId: acme, jobId: j1 }, H);
    const bulletsFor = (job: number) => agent.getCvMaterial(job).entries.find((e) => e.id === acme)!.bullets.map((b) => b.id);
    expect(bulletsFor(j1)).toContain(only);
    expect(bulletsFor(j2)).not.toContain(only);
    expect(agent.getCvMaterial(j1).profile?.fullName).toBe("Ada Lovelace");
    expect("addEntry" in agent).toBe(false);
  });
});

describe("prepareCv", () => {
  it("resolves a plan into what the renderer needs, in the order given", () => {
    const { db, acme, beta, proj, edu, a1, a2, b1, p1, skill } = setup();
    const { cv, blocks, factIds } = prepareCv(db, {
      summary: [{ text: "Backend engineer who built a payments API serving 50000 users.", factIds: [a1] }],
      experience: [
        { entryId: beta, bullets: [b1] },
        { entryId: acme, bullets: [a2, { text: "Built a payments API for 50000 users", factIds: [a1] }] },
      ],
      projects: [{ entryId: proj, bullets: [p1] }],
      education: [{ entryId: edu }],
      skills: [{ group: "Backend", factIds: [skill("Rust"), skill("Node.js")] }],
    }, null);
    expect(cv.header).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(cv.experience.map((e) => e.entry.id)).toEqual([beta, acme]);
    expect(cv.experience[1]!.bullets).toEqual(["Cut query time by 40%", "Built a payments API for 50000 users"]);
    expect(cv.skills).toEqual([{ group: "Backend", items: ["Rust", "Node.js"] }]);
    expect(cv.education[0]!.entry.note).toBe("GPA: 3.82");
    expect(blocks).toHaveLength(5);
    expect(factIds).toEqual(expect.arrayContaining([a1, a2, b1, p1, skill("Rust")]));
  });

  const problems = (plan: any) => {
    const s = setup();
    try { prepareCv(s.db, typeof plan === "function" ? plan(s) : plan, null); } catch (e) { return (e as ProvenanceError).problems; }
    return [];
  };

  it("refuses a bullet placed under the wrong job", () => {
    const out = problems((s: any) => ({ experience: [{ entryId: s.beta, bullets: [s.a1] }] }));
    expect(out.join("\n")).toMatch(/belong to a different entry/);
  });

  it("refuses reworded text with an invented number, or no facts", () => {
    const out = problems((s: any) => ({ experience: [{ entryId: s.acme, bullets: [{ text: "Built an API serving 90000 users", factIds: [s.a1] }, { text: "Led a team", factIds: [] }] }] }));
    expect(out.join("\n")).toMatch(/90000/);
    expect(out.join("\n")).toMatch(/cites no fact/);
  });

  it("refuses wrong kinds, duplicates, empty entries and skills from another group", () => {
    const out = problems((s: any) => ({
      experience: [{ entryId: s.proj, bullets: [s.p1] }, { entryId: s.acme, bullets: [s.a1] }, { entryId: s.acme, bullets: [s.a2] }, { entryId: s.beta, bullets: [] }],
      education: [{ entryId: s.acme }, { entryId: 999 }],
      skills: [{ group: "Databases", factIds: [s.skill("Rust")] }],
    })).join("\n");
    expect(out).toMatch(/is a project entry, not work/);
    expect(out).toMatch(/listed twice/);
    expect(out).toMatch(/no bullets/);
    expect(out).toMatch(/is a work entry/);
    expect(out).toMatch(/no such entry/);
    expect(out).toMatch(/not in that group/);
  });

  it("refuses an empty plan, a missing profile, and a long summary", () => {
    expect(problems({}).join("\n")).toMatch(/no content/);
    const db = openDb(":memory:");
    expect(() => prepareCv(db, { summary: [{ text: "x", factIds: [] }] }, null)).toThrow(/no name yet/);
    const s = setup();
    const four = Array.from({ length: 4 }, () => ({ text: "Maintained 12 services", factIds: [s.b1] }));
    expect(() => prepareCv(s.db, { summary: four }, null)).toThrow(/more than 3 sentences/);
  });

  it("will not use a fact reserved for another job", () => {
    const { db, acme } = setup();
    const agent = createAgentApi(db);
    const j1 = agent.addCandidateJob({ title: "A", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    const j2 = agent.addCandidateJob({ title: "B", url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
    const only = addFact(db, { kind: "experience", text: "Used Kubernetes", entryId: acme, jobId: j1 }, H);
    const plan = { experience: [{ entryId: acme, bullets: [only] }] };
    expect(agent.prepareCv(plan, j1).cv.experience).toHaveLength(1);
    expect(() => agent.prepareCv(plan, j2)).toThrow(/reserved for a different job/);
  });

  it("keeps the plan with the saved document", () => {
    const { db, acme, a1 } = setup();
    const plan = { experience: [{ entryId: acme, bullets: [a1] }] };
    const { blocks, factIds } = prepareCv(db, plan, null);
    const { id } = saveDocument(db, { jobId: null, kind: "cv", path: "documents/cv.pdf", blocks, plan, extraFactIds: factIds }, "agent");
    expect(getDocument(db, id)?.plan).toEqual(plan);
  });
});

describe("entry weights are rules", () => {
  const plan = (s: ReturnType<typeof setup>, order: number[]) => ({
    experience: order.map((entryId) => ({ entryId, bullets: [entryId === s.acme ? s.a1 : s.b1] })),
  });
  const weigh = (s: ReturnType<typeof setup>, id: number, weight: "normal" | "always" | "lead") => {
    const e = listEntries(s.db).find((x) => x.id === id)!;
    updateEntry(s.db, id, { ...e, weight }, H);
  };

  it("defaults to normal and rejects unknown weights", () => {
    const s = setup();
    expect(listEntries(s.db).every((e) => e.weight === "normal")).toBe(true);
    expect(() => addEntry(s.db, { kind: "work", title: "x", weight: "huge" as never }, H)).toThrow(/Weight must be/);
  });

  it("refuses a plan that leaves out an always or lead entry", () => {
    const s = setup();
    weigh(s, s.beta, "always");
    expect(() => prepareCv(s.db, plan(s, [s.acme]), null)).toThrow(/"Engineer at Beta" is marked always include and must be in the CV/);
    expect(prepareCv(s.db, plan(s, [s.acme, s.beta]), null).cv.experience).toHaveLength(2);
  });

  it("refuses a plan that lists a lead entry after others, and accepts it first", () => {
    const s = setup();
    weigh(s, s.beta, "lead");
    expect(() => prepareCv(s.db, plan(s, [s.acme, s.beta]), null)).toThrow(/"Engineer at Beta" is marked lead with this and must come before "Backend Engineer at Acme"/);
    expect(prepareCv(s.db, plan(s, [s.beta, s.acme]), null).cv.experience.map((e) => e.entry.id)).toEqual([s.beta, s.acme]);
  });

  it("applies to projects and education too, and several leads may be ordered by the agent", () => {
    const s = setup();
    weigh(s, s.proj, "always");
    weigh(s, s.acme, "lead");
    weigh(s, s.beta, "lead");
    expect(() => prepareCv(s.db, { experience: plan(s, [s.acme, s.beta]).experience }, null)).toThrow(/projects: "Web server in C" is marked always include/);
    const ok = prepareCv(s.db, { experience: plan(s, [s.beta, s.acme]).experience, projects: [{ entryId: s.proj, bullets: [s.p1] }] }, null);
    expect(ok.cv.projects).toHaveLength(1);
    weigh(s, s.edu, "always");
    expect(() => prepareCv(s.db, { experience: plan(s, [s.beta, s.acme]).experience, projects: [{ entryId: s.proj, bullets: [s.p1] }] }, null)).toThrow(/education: "BSc Software Engineering at AASTU" is marked always include/);
  });

  it("shows the agent each entry's weight and the user's guidance", () => {
    const s = setup();
    weigh(s, s.acme, "lead");
    setPreferences(s.db, { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, cvGuidance: "Prefer international client work." }, H);
    const m = getCvMaterial(s.db, null);
    expect(m.entries.find((e) => e.id === s.acme)!.weight).toBe("lead");
    expect(m.guidance).toBe("Prefer international client work.");
    expect(() => setPreferences(s.db, { ...getPreferences(s.db)!, cvGuidance: "x".repeat(1001) }, H)).toThrow(/at most 1000/);
  });
});

describe("country priority", () => {
  const prefs = (countryPriority: string[]) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, countryPriority });
  const withCountries = () => {
    const s = setup();
    const set = (id: number, country: string) => updateEntry(s.db, id, { ...listEntries(s.db).find((e) => e.id === id)!, country }, H);
    set(s.acme, "Ethiopia");
    set(s.beta, "United States");
    setPreferences(s.db, prefs([" United States ", "Netherlands", "united states"]), H);
    return s;
  };
  const plan = (s: ReturnType<typeof setup>, order: number[]) => ({ experience: order.map((entryId) => ({ entryId, bullets: [entryId === s.acme ? s.a1 : s.b1] })) });

  it("saves the list trimmed and without repeats", () => {
    const s = withCountries();
    expect(getPreferences(s.db)!.countryPriority).toEqual(["United States", "Netherlands"]);
  });

  it("refuses a plan that lists a lower-priority country first, and says which", () => {
    const s = withCountries();
    expect(() => prepareCv(s.db, plan(s, [s.acme, s.beta]), null)).toThrow(/"Backend Engineer at Acme" \(Ethiopia\) is listed before "Engineer at Beta" \(United States\)/);
    expect(prepareCv(s.db, plan(s, [s.beta, s.acme]), null).cv.experience.map((e) => e.entry.id)).toEqual([s.beta, s.acme]);
  });

  it("ignores the rule when the list is empty, and matches countries ignoring case", () => {
    const s = withCountries();
    setPreferences(s.db, prefs([]), H);
    expect(prepareCv(s.db, plan(s, [s.acme, s.beta]), null).cv.experience).toHaveLength(2);
    setPreferences(s.db, prefs(["united states"]), H);
    expect(() => prepareCv(s.db, plan(s, [s.acme, s.beta]), null)).toThrow(/country priority/);
  });

  it("lead still beats country, and entries without a country come after listed ones", () => {
    const s = withCountries();
    updateEntry(s.db, s.acme, { ...listEntries(s.db).find((e) => e.id === s.acme)!, weight: "lead" }, H);
    expect(prepareCv(s.db, plan(s, [s.acme, s.beta]), null).cv.experience[0]!.entry.id).toBe(s.acme);
    const entries = listEntries(s.db);
    const ordered = orderForCv(s.db, [...entries.filter((e) => e.kind === "work")]).map((e) => e.id);
    expect(ordered).toEqual([s.acme, s.beta, ...listEntries(s.db, "work").map((e) => e.id).filter((id) => id !== s.acme && id !== s.beta)]);
  });
});

describe("repeated gaps", () => {
  it("refreshes an open gap for the same requirement instead of adding a card", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const j = agent.addCandidateJob({ title: "A", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    const j2 = agent.addCandidateJob({ title: "B", url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
    const first = agent.reportGap(j, { requirement: "Understanding of Peer-to-Peer technologies", detail: "first" });
    const again = agent.reportGap(j, { requirement: "  understanding of peer-to-peer TECHNOLOGIES ", detail: "second" });
    expect(again).toBe(first);
    expect(agent.listOpenActions()).toHaveLength(1);
    expect(JSON.parse((agent.listOpenActions()[0] as any).payload).detail).toBe("second");
    expect(agent.reportGap(j2, { requirement: "Understanding of Peer-to-Peer technologies" })).not.toBe(first);
    expect(agent.reportGap(j, { requirement: "Kubernetes" })).not.toBe(first);
    expect(agent.listOpenActions()).toHaveLength(3);
    createHumanApi(db).resolveAction(first, "dismissed");
    expect(agent.reportGap(j, { requirement: "Understanding of Peer-to-Peer technologies" })).not.toBe(first);
  });
});

describe("employment type priority", () => {
  const prefs = (employmentPriority: string[]) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, countryPriority: [], employmentPriority });
  const withTypes = () => {
    const s = setup();
    const set = (id: number, employmentType: any) => updateEntry(s.db, id, { ...listEntries(s.db).find((e) => e.id === id)!, employmentType }, H);
    set(s.acme, "freelance");
    set(s.beta, "full_time");
    setPreferences(s.db, prefs([" Full_Time ", "part_time", "freelance", "full_time"]), H);
    return s;
  };
  const plan = (s: ReturnType<typeof setup>, order: number[]) => ({ experience: order.map((entryId) => ({ entryId, bullets: [entryId === s.acme ? s.a1 : s.b1] })) });

  it("saves the list lower-cased and without repeats, and refuses unknown types", () => {
    const s = withTypes();
    expect(getPreferences(s.db)!.employmentPriority).toEqual(["full_time", "part_time", "freelance"]);
    expect(() => setPreferences(s.db, prefs(["intern"]), H)).toThrow(/Employment priority/);
  });

  it("refuses a plan that lists freelance above full-time, and says which", () => {
    const s = withTypes();
    expect(() => prepareCv(s.db, plan(s, [s.acme, s.beta]), null)).toThrow(/freelance\) is listed before .*full-time\)/);
    expect(prepareCv(s.db, plan(s, [s.beta, s.acme]), null).cv.experience.map((e) => e.entry.id)).toEqual([s.beta, s.acme]);
  });

  it("country still comes first", () => {
    const s = withTypes();
    const set = (id: number, country: string) => updateEntry(s.db, id, { ...listEntries(s.db).find((e) => e.id === id)!, country }, H);
    set(s.acme, "United States");
    set(s.beta, "Ethiopia");
    setPreferences(s.db, { ...prefs(["full_time", "freelance"]), countryPriority: ["United States", "Ethiopia"] }, H);
    expect(prepareCv(s.db, plan(s, [s.acme, s.beta]), null).cv.experience.map((e) => e.entry.id)).toEqual([s.acme, s.beta]);
  });
});

describe("country list", () => {
  it("accepts the listed spelling, ignoring case, accents and common aliases", () => {
    expect(canonicalCountry("united states")).toBe("United States");
    expect(canonicalCountry("  USA ")).toBe("United States");
    expect(canonicalCountry("The Netherlands")).toBe("Netherlands");
    expect(canonicalCountry("Holland")).toBe("Netherlands");
    expect(canonicalCountry("Côte d'Ivoire")).toBe("Cote d'Ivoire");
    expect(canonicalCountry("Atlantis")).toBeUndefined();
  });

  it("refuses a misspelled country and suggests the likely one", () => {
    expect(() => requireCountry("United State")).toThrow(/"United State" is not in the country list. Did you mean "United States"\?/);
    expect(() => requireCountry("Netherland")).toThrow(/Did you mean "Netherlands"/);
    expect(() => requireCountry("Atlantis")).toThrow(/"Atlantis" is not in the country list$/);
  });

  it("applies to an entry's country and to the priority list, and stores the listed spelling", () => {
    const s = setup();
    expect(() => updateEntry(s.db, s.acme, { ...listEntries(s.db).find((e) => e.id === s.acme)!, country: "Netherland" }, H)).toThrow(/Did you mean "Netherlands"/);
    updateEntry(s.db, s.acme, { ...listEntries(s.db).find((e) => e.id === s.acme)!, country: "holland" }, H);
    expect(listEntries(s.db).find((e) => e.id === s.acme)!.country).toBe("Netherlands");
    const base = { roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true };
    expect(() => setPreferences(s.db, { ...base, countryPriority: ["United State", "Netherland"] }, H)).toThrow(/Did you mean "United States"/);
    setPreferences(s.db, { ...base, countryPriority: ["usa", "United States", "holland"] }, H);
    expect(getPreferences(s.db)!.countryPriority).toEqual(["United States", "Netherlands"]);
  });
});
