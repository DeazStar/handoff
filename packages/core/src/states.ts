export const JOB_STATES = [
  "found",
  "verified_live",
  "matched",
  "materials_ready",
  "awaiting_approval",
  "applied",
  "replied",
  "interview",
  "offer",
  "rejected",
  "no_response",
  "dead",
  "skipped",
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type Actor = "agent" | "human" | "system";

/** Who may perform each transition. Irreversible steps are human-only. */
const TRANSITIONS: Record<JobState, Partial<Record<JobState, Actor[]>>> = {
  found: { verified_live: ["agent", "system"], dead: ["agent", "system"], skipped: ["agent", "human"] },
  verified_live: { matched: ["agent", "system"], skipped: ["agent", "human"], dead: ["agent", "system"] },
  matched: { materials_ready: ["agent", "system"], skipped: ["agent", "human"], dead: ["agent", "system"] },
  materials_ready: { awaiting_approval: ["agent", "system"], skipped: ["agent", "human"], dead: ["agent", "system"] },
  awaiting_approval: { applied: ["human"], skipped: ["human"], dead: ["agent", "human"] },
  applied: { replied: ["agent", "human"], no_response: ["agent", "human", "system"], rejected: ["agent", "human"] },
  replied: { interview: ["human"], rejected: ["agent", "human"] },
  interview: { offer: ["human"], rejected: ["human"] },
  offer: {},
  rejected: {},
  no_response: { replied: ["agent", "human"] },
  dead: {},
  skipped: { found: ["human"] },
};

export class TransitionError extends Error {}

export function assertTransition(from: JobState, to: JobState, actor: Actor): void {
  const allowed = TRANSITIONS[from]?.[to];
  if (!allowed) throw new TransitionError(`Illegal transition ${from} -> ${to}`);
  if (!allowed.includes(actor)) {
    throw new TransitionError(`${actor} may not move a job ${from} -> ${to}`);
  }
}

/** The states a job can move to right now for this actor; the dashboard uses it to show only valid buttons. */
export function allowedTransitions(from: JobState, actor: Actor): JobState[] {
  return Object.entries(TRANSITIONS[from] ?? {})
    .filter(([, actors]) => actors?.includes(actor))
    .map(([to]) => to as JobState);
}
