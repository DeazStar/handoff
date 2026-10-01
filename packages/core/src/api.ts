import { recordVerification, setMatch, upsertCompany, upsertSource, type Verification } from "./agentOps.js";
import { confirmGap, listOpenActions, queueAction, reportGap, resolveAction, type ActionKind, type GapReport } from "./actionQueue.js";
import type { DB } from "./db.js";
import { getDocument, listDocuments, saveDocument, type NewDocument } from "./documents.js";
import { addFact, deleteFact, getFacts, listFacts, makeFactGeneral, updateFact, type FactKind, type NewFact } from "./facts.js";
import { addCandidateJob, logEvent, transitionJob, type NewJob } from "./jobs.js";
import { getPreferences, getProfile, setPreferences, setProfile, type Preferences, type Profile } from "./profile.js";
import { listActionsDetailed, listJobs, getJob, sourceStats } from "./queries.js";
import { allowedTransitions, type JobState } from "./states.js";

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
    // The agent only ever sees general facts plus those reserved for the job it is working on.
    listFacts: (forJob: number | null, kind?: FactKind) => listFacts(db, { forJob, kind }),
    getFacts: (ids: number[]) => getFacts(db, ids),
    saveDocument: (doc: NewDocument) => saveDocument(db, doc, "agent"),
    getDocument: (id: number) => getDocument(db, id),
    listDocuments: (jobId: number | null) => listDocuments(db, jobId),
    listJobs: (state?: JobState) => listJobs(db, { state }),
    getJob: (id: number) => getJob(db, id),
    upsertCompany: (c: Parameters<typeof upsertCompany>[1]) => upsertCompany(db, c, "agent"),
    upsertSource: (s: Parameters<typeof upsertSource>[1]) => upsertSource(db, s, "agent"),
    recordVerification: (jobId: number, v: Verification) => recordVerification(db, jobId, v, "agent"),
    setMatch: (jobId: number, score: number, reason: string) => setMatch(db, jobId, score, reason, "agent"),
    reportGap: (jobId: number, gap: GapReport) => reportGap(db, jobId, gap, "agent"),
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
    makeFactGeneral: (id: number) => makeFactGeneral(db, id, "human"),
    listFacts: () => listFacts(db),
    confirmGap: (actionId: number, fact: Omit<NewFact, "jobId">, scope: "job" | "general") =>
      confirmGap(db, actionId, fact, scope, "human"),
    getDocument: (id: number) => getDocument(db, id),
    listDocuments: (jobId: number | null) => listDocuments(db, jobId),
    getProfile: () => getProfile(db),
    getPreferences: () => getPreferences(db),
    listJobs: (state?: JobState) => listJobs(db, { state }),
    getJob: (id: number) => getJob(db, id),
    listActionsDetailed: () => listActionsDetailed(db),
    sourceStats: () => sourceStats(db),
    allowedTransitions: (from: JobState) => allowedTransitions(from, "human"),
  };
}
