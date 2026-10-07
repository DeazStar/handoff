import { describe, expect, it } from "vitest";
import { collectYc, directoryStats, domainOf, importDirectory, listDirectory, mapYcCompany, openDb, upsertCompany } from "../src/index.js";

const yc = (over: Record<string, unknown> = {}) => ({
  name: "CircuitHub", slug: "circuithub", website: "https://www.circuithub.com/about", all_locations: "London, England, United Kingdom",
  one_liner: "On-Demand Electronics", long_description: "Makes   boards.", team_size: 58, industry: "Industrials", status: "Active",
  regions: ["United Kingdom", "Remote"], ...over,
});

describe("YC mapping", () => {
  it("maps the fields and the remote hint", () => {
    const c = mapYcCompany(yc())!;
    expect(c).toMatchObject({ name: "CircuitHub", source: "yc", sourceRef: "circuithub", teamSize: 58, remoteHint: "partly", industry: "Industrials" });
    expect(mapYcCompany(yc({ regions: ["Fully Remote", "Remote"] }))!.remoteHint).toBe("fully");
    expect(mapYcCompany(yc({ regions: ["Europe"] }))!.remoteHint).toBeUndefined();
  });
  it("rejects inactive or malformed entries", () => {
    expect(mapYcCompany(yc({ status: "Inactive" }))).toBeNull();
    expect(mapYcCompany(yc({ slug: undefined }))).toBeNull();
    expect(mapYcCompany("nope")).toBeNull();
    expect(mapYcCompany(null)).toBeNull();
  });
  it("finds the website's host", () => {
    expect(domainOf("https://www.Example.com/a?b=1")).toBe("example.com");
    expect(domainOf("example.com")).toBe("example.com");
    expect(domainOf("javascript:alert(1)")).toBeUndefined();
    expect(domainOf("https://localhost")).toBeUndefined();
    expect(domainOf(undefined)).toBeUndefined();
  });
});

describe("collectYc", () => {
  const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it("reads and maps the list, counting rejects", async () => {
    const r = await collectYc(reply(JSON.stringify([yc(), yc({ slug: "b", name: "B" }), { name: "x" }])));
    expect(r.companies.map((c) => c.sourceRef)).toEqual(["circuithub", "b"]);
    expect(r.rejected).toBe(1);
  });
  it("fails clearly on a bad answer", async () => {
    await expect(collectYc(reply("x", 500))).rejects.toThrow(/500/);
    await expect(collectYc(reply("not json"))).rejects.toThrow(/valid JSON/);
    await expect(collectYc(reply('{"a":1}'))).rejects.toThrow(/not a list/);
  });
});

describe("importDirectory", () => {
  const rows = () => [mapYcCompany(yc())!, mapYcCompany(yc({ slug: "acme", name: "Acme", website: "https://acme.io", regions: ["Fully Remote"] }))!];

  it("adds, and a second import updates instead of duplicating", () => {
    const db = openDb(":memory:");
    expect(importDirectory(db, rows(), "system")).toEqual({ added: 2, updated: 0, skipped: 0 });
    expect(importDirectory(db, rows(), "system")).toEqual({ added: 0, updated: 2, skipped: 0 });
    expect(directoryStats(db)).toMatchObject({ total: 2, bySource: [{ source: "yc", companies: 2, remote: 2 }], careers: { unknown: 2, found: 0, none: 0 } });
  });

  it("cleans text and stores the domain without www", () => {
    const db = openDb(":memory:");
    importDirectory(db, rows(), "system");
    const c = db.prepare("SELECT * FROM companies WHERE source_ref = 'circuithub'").get() as any;
    expect(c.domain).toBe("circuithub.com");
    expect(c.description).toBe("Makes boards.");
    expect(c.careers_status).toBe("unknown");
  });

  it("fills in a company the agent already knew from a job, without a second row", () => {
    const db = openDb(":memory:");
    const id = upsertCompany(db, { name: "Acme", domain: "acme.io" }, "agent");
    importDirectory(db, rows(), "system");
    const all = db.prepare("SELECT id, source FROM companies WHERE domain = 'acme.io'").all() as any[];
    expect(all).toEqual([{ id, source: "yc" }]);
  });

  it("skips rows with no name or id and keeps another list's company", () => {
    const db = openDb(":memory:");
    importDirectory(db, rows(), "system");
    const other = importDirectory(db, [{ name: "Acme Ltd", website: "https://acme.io", source: "uk", sourceRef: "123" }, { name: "", source: "uk", sourceRef: "9" }], "system");
    expect(other).toEqual({ added: 0, updated: 0, skipped: 2 });
  });

  it("does not store a website that is not a web link", () => {
    const db = openDb(":memory:");
    importDirectory(db, [{ name: "Odd", website: "javascript:alert(1)", source: "yc", sourceRef: "odd" }], "system");
    const c = db.prepare("SELECT website, domain FROM companies WHERE source_ref = 'odd'").get() as any;
    expect(c).toEqual({ website: null, domain: null });
  });
});

describe("listDirectory", () => {
  it("filters by text and remote, and lists fully remote first", () => {
    const db = openDb(":memory:");
    importDirectory(db, [
      mapYcCompany(yc())!,
      mapYcCompany(yc({ slug: "acme", name: "Acme", website: "https://acme.io", regions: ["Fully Remote"], one_liner: "Payments for wallets" }))!,
      mapYcCompany(yc({ slug: "plain", name: "Plain Co", website: "https://plain.co", regions: [] }))!,
    ], "system");
    expect(listDirectory(db).map((c) => c.name)).toEqual(["Acme", "CircuitHub", "Plain Co"]);
    expect(listDirectory(db, { remote: true }).map((c) => c.name)).toEqual(["Acme", "CircuitHub"]);
    expect(listDirectory(db, { q: "wallet" }).map((c) => c.name)).toEqual(["Acme"]);
    expect(listDirectory(db, { q: "%" })).toEqual([]);
    expect(listDirectory(db, { limit: 1 })).toHaveLength(1);
  });
  it("does not list companies that came only from jobs", () => {
    const db = openDb(":memory:");
    upsertCompany(db, { name: "Jobs Only", domain: "jobs.only" }, "agent");
    expect(listDirectory(db)).toEqual([]);
  });
});
