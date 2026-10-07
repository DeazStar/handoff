import type { DirectoryCompany } from "./directory.js";

/** Y Combinator companies that say they are hiring, from the public yc-oss mirror of YC's company directory. */
export const YC_HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";
const MAX_BYTES = 25 * 1024 * 1024;

/** One entry of the YC list as a directory company, or null when it has no name, no id or is not an active company. */
export function mapYcCompany(raw: unknown): DirectoryCompany | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.slug !== "string") return null;
  if (r.status !== "Active" && r.status !== "Public") return null;
  const regions = Array.isArray(r.regions) ? r.regions.filter((x): x is string => typeof x === "string") : [];
  return {
    name: r.name,
    website: typeof r.website === "string" ? r.website : undefined,
    location: typeof r.all_locations === "string" ? r.all_locations : undefined,
    oneLiner: typeof r.one_liner === "string" ? r.one_liner : undefined,
    description: typeof r.long_description === "string" ? r.long_description : undefined,
    industry: typeof r.industry === "string" ? r.industry : undefined,
    teamSize: typeof r.team_size === "number" ? r.team_size : undefined,
    remoteHint: regions.includes("Fully Remote") ? "fully" : regions.includes("Remote") || regions.includes("Partly Remote") ? "partly" : undefined,
    source: "yc",
    sourceRef: r.slug,
  };
}

/** Downloads the list (one request, no model) and maps it. `fetchImpl` is for tests. */
export async function collectYc(fetchImpl: typeof fetch = fetch): Promise<{ companies: DirectoryCompany[]; rejected: number }> {
  const res = await fetchImpl(YC_HIRING_URL, { signal: AbortSignal.timeout(60_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`The YC list answered ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("The YC list is larger than expected; not importing it");
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new Error("The YC list was not valid JSON"); }
  if (!Array.isArray(data)) throw new Error("The YC list was not a list");
  const companies: DirectoryCompany[] = [];
  let rejected = 0;
  for (const raw of data) {
    const c = mapYcCompany(raw);
    if (c) companies.push(c); else rejected++;
  }
  return { companies, rejected };
}
