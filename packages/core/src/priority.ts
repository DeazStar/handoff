export const PRIORITY_MODES = ["remote_first", "sponsored_first", "balanced"] as const;
export type PriorityMode = (typeof PRIORITY_MODES)[number];

/** Who the posting lets work remotely. worldwide: anywhere. open_to_me: a region that includes the user's country. closed: limited to places that exclude the user. */
export const REMOTE_SCOPES = ["worldwide", "open_to_me", "closed", "unclear"] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

/** confirmed: the posting says it offers sponsorship or relocation. likely: the company is on a sponsor register. */
export const SPONSORSHIPS = ["confirmed", "likely", "unknown"] as const;
export type Sponsorship = (typeof SPONSORSHIPS)[number];

// How many points (on the 0 to 10 match scale) a full remote or sponsorship signal adds in each mode.
const WEIGHTS: Record<PriorityMode, { remote: number; sponsor: number }> = {
  remote_first: { remote: 3, sponsor: 1 },
  sponsored_first: { remote: 1, sponsor: 3 },
  balanced: { remote: 1.5, sponsor: 1.5 },
};
const REMOTE_SHARE: Record<RemoteScope, number> = { worldwide: 1, open_to_me: 0.75, closed: 0, unclear: 0 };
const SPONSOR_SHARE: Record<Sponsorship, number> = { confirmed: 1, likely: 0.5, unknown: 0 };

/** The match score plus a bonus for remote and sponsorship, weighted by the user's chosen mode. Used only to order jobs. */
export function priorityScore(
  matchScore: number | undefined,
  remoteScope: RemoteScope | undefined,
  sponsorship: Sponsorship,
  mode: PriorityMode,
  levelFit?: "match" | "stretch" | "mismatch",
): number {
  const w = WEIGHTS[mode];
  const bonus = w.remote * REMOTE_SHARE[remoteScope ?? "unclear"] + w.sponsor * SPONSOR_SHARE[sponsorship];
  // A job at the wrong level is shown, but lower: one step off costs a point, further off three.
  const levelPenalty = levelFit === "mismatch" ? 3 : levelFit === "stretch" ? 1 : 0;
  return (matchScore ?? 0) + bonus - levelPenalty;
}
