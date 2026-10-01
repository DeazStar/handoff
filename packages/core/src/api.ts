import { listOpenActions, queueAction, resolveAction, type ActionKind } from "./actionQueue.js";
import type { DB } from "./db.js";
import { saveDocument, type NewDocument } from "./documents.js";
import { addFact, deleteFact, getFacts, listFacts, updateFact, type FactKind, type NewFact } from "./facts.js";
import { addCandidateJob, logEvent, transitionJob, type NewJob } from "./jobs.js";
import { getPreferences, getProfile, setPreferences, setProfile, type Preferences, type Profile } from "./profile.js";
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
    // Read-only access to the user's truth. Writing it is human-only.
    getProfile: () => getProfile(db),
    getPreferences: () => getPreferences(db),
    listFacts: (kind?: FactKind) => listFacts(db, kind),
    getFacts: (ids: number[]) => getFacts(db, ids),
    saveDocument: (doc: NewDocument) => saveDocument(db, doc, "agent"),
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
    setProfile: (p: Profile) => setProfile(db, p, "human"),
    setPreferences: (p: Preferences) => setPreferences(db, p, "human"),
    addFact: (f: NewFact) => addFact(db, f, "human"),
    updateFact: (id: number, f: NewFact) => updateFact(db, id, f, "human"),
    deleteFact: (id: number) => deleteFact(db, id, "human"),
  };
}
