import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "gclid", "fbclid", "msclkid", "ref", "ref_src", "referrer", "trk", "trackingid",
  "gh_src", "lever-source", "source", "src", "mc_cid", "mc_eid",
]);

/**
 * Reduces a job link to one standard form so the same posting always yields
 * the same string. Query parameters that identify the job (e.g. ?id=123) are kept.
 */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.port === "443" || url.port === "80") url.port = "";

  const kept = [...url.searchParams.entries()]
    .filter(([k]) => {
      const key = k.toLowerCase();
      return !key.startsWith("utm_") && !TRACKING_PARAMS.has(key);
    })
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/**
 * Fingerprint of a job description that ignores case, markup, punctuation and
 * whitespace. Returns null when there is no usable text.
 */
export function hashDescription(text: string): string | null {
  const normalized = text
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
