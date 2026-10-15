import { describe, expect, it } from "vitest";
import { checkProfileAnswer, experienceSummary, resolveSources, type Profile } from "../src/index.js";

const w = (startDate?: string, endDate?: string, isCurrent = false) => ({ kind: "work" as const, startDate, endDate, isCurrent });
const NOW = new Date(Date.UTC(2026, 9, 10)); // 10 October 2026

describe("experienceSummary", () => {
  it("is the months covered by dated roles, so your own roles come to 3 years 7 months", () => {
    // Fabrikam, Northwind, Contoso, Initech, Hooli, and an undated freelance entry
    const r = experienceSummary([w(undefined), w("2023-03", "2023-07"), w("2023-08", undefined, true), w("2024-08", undefined, true), w("2024-10", "2025-10"), w("2025-06", undefined, true)], NOW);
    expect(r).toEqual({ years: 3, months: 44, since: "2023-03", undatedEntries: 1 });
  });
  it("counts overlapping roles once, and leaves gaps out", () => {
    expect(experienceSummary([w("2020-01", "2021-12"), w("2021-06", "2022-12")], NOW)).toMatchObject({ months: 36, years: 3 });
    expect(experienceSummary([w("2020-01", "2020-12"), w("2022-01", "2022-12")], NOW)).toMatchObject({ months: 24, years: 2, since: "2020-01" });
  });
  it("runs a current role to this month, and reads a year-only date the cautious way", () => {
    expect(experienceSummary([w("2025-10", undefined, true)], NOW)).toMatchObject({ months: 13, years: 1 });
    expect(experienceSummary([w("2020", "2022")], NOW)).toMatchObject({ months: 14 }); // from December 2020 to January 2022
  });
  it("says nothing without dates, ignores projects and education, and never counts the future", () => {
    expect(experienceSummary([w(undefined)], NOW)).toBeUndefined();
    expect(experienceSummary([], NOW)).toBeUndefined();
    expect(experienceSummary([{ kind: "project", startDate: "2020-01", endDate: "2024-01", isCurrent: false }, { kind: "education", startDate: "2015", endDate: "2019", isCurrent: false }], NOW)).toBeUndefined();
    expect(experienceSummary([w("2030-01", "2031-01")], NOW)).toMatchObject({ months: 1 });
  });
});

describe("answering a years-of-experience question", () => {
  const profile: Profile = { fullName: "Alex", links: [], languages: [] };
  const derived = { experienceYears: 3, experienceMonths: 44 };
  const ok = (answer: string) => checkProfileAnswer("Years of experience", answer, ["experienceYears"], profile, derived);
  it("is a source only when the years can be calculated", () => {
    expect(resolveSources(["profile:experienceYears"], "profile", { profile, standard: [], derived })).toMatchObject({ ok: true, fields: ["experienceYears"] });
    expect((resolveSources(["profile:experienceYears"], "profile", { profile, standard: [], derived: {} }) as { problem: string }).problem).toMatch(/nothing saved/);
  });
  it("accepts the number, a plus, and the range that contains it", () => {
    expect(ok("3").check).toBe("verified");
    expect(ok("3 years").check).toBe("verified");
    expect(ok("3.5").check).toBe("verified");
    expect(ok("3+").check).toBe("verified");
    expect(ok("2+ years").check).toBe("verified");
    expect(ok("3-5 years").check).toBe("verified");
    expect(ok("1-3").check).toBe("verified");
  });
  it("flags a number that does not follow from the dated roles", () => {
    expect(ok("8")).toMatchObject({ check: "differs", note: expect.stringMatching(/3 years \(44 months\)/) });
    expect(ok("5+").check).toBe("differs");
    expect(ok("5-10 years").check).toBe("differs");
    expect(ok("many").check).toBe("unchecked");
  });
});
