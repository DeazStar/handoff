import { listOpenActions, queueAction, resolveAction, type ActionKind } from "./actionQueue.js";
import type { DB } from "./db.js";
import { addCandidateJob, logEvent, transitionJob, type NewJob } from "./jobs.js";
import type { JobState } from "./states.js";

/**
 * What the AI agent is allowed to do. The actor is fixed to "agent" here and is not a
 * parameter, so a caller cannot claim to be a human. The MCP server must only use this.
 * There is deliberately no resolveAction: the agent queues items, the human decides.
 */
export function createAgentApi(db: DB) {
  return {
    addCandidateJob: (job: NewJob) => addCandidateJob(db, job, "agent"),
    transitionJob: (jobId: number, to: JobState, reason?: string) =>
      transitionJob(db, jobId, to, "agent", reason),
    queueAction: (kind: ActionKind, jobId: number | null, payload: unknown = {}) =>
      queueAction(db, kind, jobId, payload, "agent"),
    listOpenActions: () => listOpenActions(db),
    logEvent: (type: string, jobId: number | null, detail: unknown = {}) =>
      logEvent(db, "agent", type, jobId, detail),
  };
}

/** What the dashboard and extension do on the user's behalf. Never hand this to the agent. */
export function createHumanApi(db: DB) {
  return {
    transitionJob: (jobId: number, to: JobState, reason?: string) =>
      transitionJob(db, jobId, to, "human", reason),
    resolveAction: (id: number, status: "done" | "dismissed") =>
      resolveAction(db, id, status, "human"),
    listOpenActions: () => listOpenActions(db),
  };
}
