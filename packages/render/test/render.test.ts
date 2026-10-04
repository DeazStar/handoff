import { describe, expect, it } from "vitest";
import type { CvEntry, ResolvedCv } from "@jobhunt/core/agent";
import { drawable, formatDateRange, renderCvPdf } from "../src/index.js";

const entry = (over: Partial<CvEntry> = {}): CvEntry => ({ id: 1, kind: "work", title: "Backend Engineer", organization: "Acme", location: "Remote", isCurrent: false, sortOrder: 1, ...over });
const base = (): ResolvedCv => ({
  header: { name: "Ada Lovelace", email: "ada@example.com", phone: "0900", location: "Addis Ababa, Ethiopia", links: ["https://www.ada.dev/"] },
  summary: ["Backend engineer."],
  experience: [{ entry: entry({ startDate: "2022-03", endDate: "2024-01" }), bullets: ["Built a payments API serving 50000 users"] }],
  projects: [{ entry: entry({ kind: "project", title: "Web server in C", organization: undefined }), bullets: ["HTTP 1.1 server"] }],
  education: [{ entry: entry({ kind: "education", title: "BSc Software Engineering", organization: "AASTU", location: undefined, startDate: "2020", endDate: "2025", note: "GPA: 3.82" }) }],
  skills: [{ group: "Backend", items: ["Node.js", "Rust"] }],
});

describe("dates", () => {
  it("formats ranges the way a CV shows them", () => {
    expect(formatDateRange({ startDate: "2022-03", endDate: "2024-01", isCurrent: false })).toBe("Mar 2022 – Jan 2024");
    expect(formatDateRange({ startDate: "2020", isCurrent: true })).toBe("2020 – Present");
    expect(formatDateRange({ startDate: "2020", isCurrent: false })).toBe("2020");
    expect(formatDateRange({ endDate: "2024", isCurrent: false })).toBe("– 2024");
    expect(formatDateRange({ isCurrent: false })).toBe("");
  });
});

describe("text the fonts cannot draw", () => {
  it("keeps Latin text and punctuation, replaces the rest", () => {
    expect(drawable("Zürich – “quoted” • café")).toBe("Zürich – “quoted” • café");
    expect(drawable("ሰላም")).toBe("???");
  });
});

describe("renderCvPdf", () => {
  it("produces a one page PDF for a normal CV", async () => {
    const { pdf, pages } = await renderCvPdf(base());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
    expect(pages).toBe(1);
  });

  it("reports more pages when there is too much content, and still renders", async () => {
    const cv = base();
    cv.experience = Array.from({ length: 8 }, (_, i) => ({
      entry: entry({ id: i + 10, title: `Role ${i}`, startDate: "2020", endDate: "2021" }),
      bullets: Array.from({ length: 6 }, (_, j) => `Bullet ${j} `.repeat(30)),
    }));
    const { pages } = await renderCvPdf(cv);
    expect(pages).toBeGreaterThan(1);
  });

  it("renders a CV with only some sections", async () => {
    const { pages } = await renderCvPdf({ ...base(), summary: [], projects: [], education: [], skills: [] });
    expect(pages).toBe(1);
  });
});
