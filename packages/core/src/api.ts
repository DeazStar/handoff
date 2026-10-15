import { getSiteProfile, listSiteProfiles, setSiteProfile } from "./siteProfile.js";
import { confirmMetric, countBulletsWithoutNumber, requestMetricCards } from "./metrics.js";
import { getCvScore, saveCvScore, scoreCv, type ScoreKeyword } from "./cvScore.js";
import { applicationRoom, assertApplicationRoom, deleteStandardAnswer, discardApplication, getApplication, getPreparedApplication, listApplications, listStandardAnswers, markApplicationSubmitted, prepareApplication, setStandardAnswer, type PrepareInput } from "./application.js";
import { addPerson, getCompanyResearch, listPeople, markCompanyResearched } from "./research.js";
import { getJobDescription } from "./queries.js";
import { saveJobDetails } from "./jobs.js";
import { addContact, applicationsToday, resetApplicationCount, beginSend, discardEmail, draftEmail, failSend, finishSend, getContact, getEmail, listContacts, listEmails, markContactBounced, noContactFound, releaseSend, updateEmail, type DraftInput } from "./email.js";
import { addCandidateJobWithinBudget, checkCandidate, checkLinks, userLinkBudget, logSkippedCandidate, type SkipReason, discoveryBudget, listSources, recordVerification, setMatch, type JobSignals, setRoute, setSourceEnabled, upsertCompany, upsertSource, type Verification } from "./agentOps.js";
import { cancelGapDrafts, clearGapPolish, listGapPolishRequests, requestGapPolish, requestMetricPolish, submitGapPolish, confirmGap, listGapDraftRequests, listOpenActions, requestGapDrafts, submitGapDraft, queueAction, reportGap, resolveAction, type ActionKind, type GapReport } from "./actionQueue.js";
import type { DB } from "./db.js";
import { deleteDocument, getDocument, listDocuments, nextDocumentVersion, saveDocument, type NewDocument } from "./documents.js";
import { addBullet, addEntry, deleteEntry, getCvMaterial, importCv, listEntries, moveEntry, setSkillGroup, updateEntry, type CvImport, type EntryInput } from "./cv.js";
import { prepareCv, type CvPlan } from "./cvPlan.js";
import { addFact, deleteFact, getFacts, listFacts, makeFactGeneral, updateFact, type FactKind, type NewFact } from "./facts.js";
import { addCandidateJob, logEvent, transitionJob, type NewJob } from "./jobs.js";
import { getPreferences, getProfile, setPreferences, setProfile, type Preferences, type Profile } from "./profile.js";
import { directoryStats, importDirectory, listDirectory, listScoutCompanies, setCompanyVerdict, type DirectoryCompany, type DirectoryFilter, type Verdict } from "./directory.js";
import { setCareersPage } from "./careers.js";
import { acceptProposal, proposeRemember, type Proposal } from "./remember.js";
import { askUser, requestProfileFill, accountStatus, confirmAccount, createAccount, deleteAccount, listAccounts, markAccountVerified, requestAccount, getAccount, touchAccount, type AccountRequest } from "./accounts.js";
import { ignoreVerification, listVerifications, setVerificationUsed } from "./verification.js";
import { listTracker, recordManualApplication, type ManualApplication } from "./manual.js";
import { applyMessageOutcome, draftFollowUp, dueFollowUps, getSyncState, listMessages, newMessageCount, setMessageCategory, setMessageStatus, type Category, type MessageStatus } from "./replies.js";
import { coverMode, getCoverMaterial, latestCover, prepareCover, type CoverPlan } from "./cover.js";
import { listActionsDetailed, listJobs, getJob, sourceStats } from "./queries.js";
import { allowedTransitions, type JobState } from "./states.js";

/**
 * What the AI agent is allowed to do. The actor is fixed to "agent" here and is not a
 * parameter, so a caller cannot claim to be a human. The MCP server must only use this.
 * There is deliberately no resolveAction: the agent queues items, the human decides.
 */
export function createAgentApi(db: DB) {
  return {
    // Stops at the user's daily limit so a run cannot keep spending tokens on new jobs.
    addCandidateJob: (job: NewJob) => addCandidateJobWithinBudget(db, job, "agent"),
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
    nextDocumentVersion: (jobId: number | null, kind: NewDocument["kind"]) => nextDocumentVersion(db, jobId, kind),
    getCvMaterial: (forJob: number | null) => getCvMaterial(db, forJob),
    prepareCv: (plan: CvPlan, jobId: number | null) => prepareCv(db, plan, jobId),
    listJobs: (state?: JobState, sort?: "updated" | "priority") => listJobs(db, { state, sort }),
    getJob: (id: number) => getJob(db, id),
    // Companies from the public lists. The agent judges them; it cannot overrule a verdict the user set.
    // Cover letters: the agent supplies the paragraphs; the server checks the claims and draws the letter.
    prepareCover: (plan: CoverPlan, jobId: number, contactId?: number) => prepareCover(db, plan, jobId, contactId),
    getCoverMaterial: (jobId: number) => getCoverMaterial(db, jobId),
    latestCover: (jobId: number) => latestCover(db, jobId),
    coverMode: () => coverMode(db),
    userLinkBudget: () => userLinkBudget(db),
    // Accounts: the agent may ask for one and ask whether one exists. It never sees a password or a username.
    requestAccount: (jobId: number | null, r: AccountRequest) => requestAccount(db, jobId, r, "agent"),
    accountStatus: (site: string) => accountStatus(db, site),
    proposeRemember: (jobId: number | null, p: Proposal) => proposeRemember(db, jobId, p, "agent"),
    askUser: (jobId: number | null, q: { question: string; options?: string[]; site?: string }) => askUser(db, jobId, q, "agent"),
    requestProfileFill: (jobId: number | null, r: { pageUrl: string; note?: string }) => requestProfileFill(db, jobId, r, "agent"),
    companyDomain: (companyId: number) => (db.prepare("SELECT domain FROM companies WHERE id = ?").get(companyId) as { domain: string | null } | undefined)?.domain ?? undefined,
    getPreparedApplication: (jobId: number) => getPreparedApplication(db, jobId),
    siteProfileStatus: (site: string) => getSiteProfile(db, site) ?? { site, complete: false, unknown: true },
    markSiteProfile: (site: string, complete: boolean, evidence?: string) => setSiteProfile(db, site, complete, evidence, "agent"),
    applicationRoom: () => applicationRoom(db),
    scoreCv: (documentId: number, keywords: ScoreKeyword[], pages?: number) => { const s = scoreCv(db, documentId, keywords, pages); saveCvScore(db, documentId, s, "agent"); return s; },
    assertApplicationRoom: (jobId: number) => assertApplicationRoom(db, jobId),
    listScoutCompanies: (limit: number) => listScoutCompanies(db, limit, true),
    setCareersPage: (companyId: number, r: { url: string } | { none: true; note?: string }) => setCareersPage(db, companyId, r, "agent"),
    setCompanyVerdict: (companyId: number, verdict: "potential" | "discarded", reason: string) => setCompanyVerdict(db, companyId, verdict, reason, "agent"),
    // Contacts and drafts. The agent can add a verified contact and write a draft; it can never send.
    addContact: (c: { companyId: number; email: string; name?: string; role?: string; sourceUrl: string; personId?: number; verification?: "on_page" | "pattern"; browserEvidence?: { quote: string; pageUrl: string; rule?: string }; evidence?: { pattern: string; exampleEmail: string; exampleName: string; exampleUrl: string } }) => addContact(db, c, "agent"),
    listContacts: (companyId: number) => listContacts(db, companyId),
    addPerson: (p: { companyId: number; name: string; role: string; sourceUrl: string }) => addPerson(db, p, "agent"),
    listPeople: (companyId: number) => listPeople(db, companyId),
    getCompanyResearch: (companyId: number) => getCompanyResearch(db, companyId),
    markCompanyResearched: (companyId: number) => markCompanyResearched(db, companyId, "agent"),
    getJobDescription: (jobId: number) => getJobDescription(db, jobId),
    prepareApplication: (input: PrepareInput) => prepareApplication(db, input, "agent"),
    getApplication: (jobId: number) => getApplication(db, jobId),
    listStandardAnswers: () => listStandardAnswers(db),
    saveJobDetails: (jobId: number, d: { description: string; postedBy?: string; applyUrl?: string }) => saveJobDetails(db, jobId, d, "agent"),
    draftEmail: (d: DraftInput) => draftEmail(db, d, "agent"),
    noContactFound: (jobId: number, detail?: string) => noContactFound(db, jobId, detail, "agent"),
    upsertCompany: (c: Parameters<typeof upsertCompany>[1]) => upsertCompany(db, c, "agent"),
    upsertSource: (s: Parameters<typeof upsertSource>[1]) => upsertSource(db, s, "agent"),
    recordVerification: (jobId: number, v: Verification) => recordVerification(db, jobId, v, "agent"),
    setMatch: (jobId: number, score: number, reason: string, signals?: JobSignals) => setMatch(db, jobId, score, reason, "agent", signals),
    setRoute: (jobId: number, route: "form" | "email" | "none", opts: { requiresSignin?: boolean; applyUrl?: string } = {}) =>
      setRoute(db, jobId, route, opts, "agent"),
    listSources: () => listSources(db),
    discoveryBudget: () => discoveryBudget(db),
    checkCandidate: (url: string) => checkCandidate(db, url),
    logSkippedCandidate: (c: { url: string; reason: SkipReason; detail?: string; sourceId?: number }) =>
      logSkippedCandidate(db, c, "agent"),
    reportGap: (jobId: number, gap: GapReport) => reportGap(db, jobId, gap, "agent"),
    listGapDraftRequests: () => listGapDraftRequests(db),
    listGapPolishRequests: () => listGapPolishRequests(db),
    submitGapPolish: (actionId: number, polished: string, note?: string) => submitGapPolish(db, actionId, polished, note, "agent"),
    submitGapDraft: (actionId: number, draft: Parameters<typeof submitGapDraft>[2], note?: string, closestFactIds?: number[]) => submitGapDraft(db, actionId, draft, note, closestFactIds, "agent"),
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
    requestGapPolish: (actionId: number, text: string) => requestGapPolish(db, actionId, text, "human"),
    clearGapPolish: (actionId: number) => clearGapPolish(db, actionId, "human"),
    requestGapDrafts: (scope: { actionId?: number; jobId?: number }) => requestGapDrafts(db, scope, "human"),
    cancelGapDrafts: (scope: { actionId?: number; jobId?: number }) => cancelGapDrafts(db, scope, "human"),
    confirmGap: (actionId: number, fact: Omit<NewFact, "jobId">, scope: "job" | "general") =>
      confirmGap(db, actionId, fact, scope, "human"),
    getDocument: (id: number) => getDocument(db, id),
    deleteDocument: (id: number) => deleteDocument(db, id, "human"),
    listDocuments: (jobId: number | null) => listDocuments(db, jobId),
    listEntries: () => listEntries(db),
    addEntry: (e: EntryInput) => addEntry(db, e, "human"),
    updateEntry: (id: number, e: EntryInput) => updateEntry(db, id, e, "human"),
    moveEntry: (id: number, direction: "up" | "down") => moveEntry(db, id, direction, "human"),
    deleteEntry: (id: number) => deleteEntry(db, id, "human"),
    addBullet: (entryId: number, text: string) => addBullet(db, entryId, text, "human"),
    setSkillGroup: (group: string, items: string[]) => setSkillGroup(db, group, items, "human"),
    importCv: (data: CvImport) => importCv(db, data, "human"),
    getCvMaterial: (forJob: number | null) => getCvMaterial(db, forJob),
    prepareCv: (plan: CvPlan, jobId: number | null) => prepareCv(db, plan, jobId),
    getProfile: () => getProfile(db),
    getPreferences: () => getPreferences(db),
    addContact: (c: { companyId: number; email: string; name?: string; role?: string }) => addContact(db, c, "human"),
    listContacts: (companyId: number) => listContacts(db, companyId),
    getContact: (id: number) => getContact(db, id),
    getCompanyResearch: (companyId: number) => getCompanyResearch(db, companyId),
    getJobDescription: (jobId: number) => getJobDescription(db, jobId),
    getApplication: (jobId: number) => getApplication(db, jobId),
    listApplications: (status?: string) => listApplications(db, status),
    markApplicationSubmitted: (jobId: number) => markApplicationSubmitted(db, jobId, "human"),
    discardApplication: (jobId: number) => discardApplication(db, jobId, "human"),
    listStandardAnswers: () => listStandardAnswers(db),
    setStandardAnswer: (label: string, answer: string) => setStandardAnswer(db, label, answer, "human"),
    deleteStandardAnswer: (id: number) => deleteStandardAnswer(db, id, "human"),
    markContactBounced: (id: number) => markContactBounced(db, id, "human"),
    getEmail: (id: number) => getEmail(db, id),
    listEmails: (status?: string) => listEmails(db, { status }),
    updateEmail: (id: number, edit: { subject: string; bodyText: string }) => updateEmail(db, id, edit, "human"),
    discardEmail: (id: number) => discardEmail(db, id, "human"),
    beginSend: (id: number) => beginSend(db, id, "human"),
    finishSend: (id: number, messageId: string) => finishSend(db, id, messageId, "human"),
    failSend: (id: number, message: string) => failSend(db, id, message, "human"),
    releaseSend: (id: number) => releaseSend(db, id, "human"),
    applicationsToday: () => applicationsToday(db),
    applicationRoom: () => applicationRoom(db),
    getCvScore: (documentId: number) => getCvScore(db, documentId),
    listSiteProfiles: () => listSiteProfiles(db),
    setSiteProfile: (site: string, complete: boolean) => setSiteProfile(db, site, complete, "marked by you", "human"),
    countBulletsWithoutNumber: () => countBulletsWithoutNumber(db),
    requestMetricPolish: (actionId: number, numbers: string) => requestMetricPolish(db, actionId, numbers, "human"),
    requestMetricCards: (limit = 5) => requestMetricCards(db, limit, "human"),
    confirmMetric: (actionId: number, text: string) => confirmMetric(db, actionId, text, "human"),
    resetApplicationCount: () => resetApplicationCount(db, "human"),
    listJobs: (state?: JobState, sort?: "updated" | "priority") => listJobs(db, { state, sort }),
    getJob: (id: number) => getJob(db, id),
    listActionsDetailed: () => listActionsDetailed(db),
    sourceStats: () => sourceStats(db),
    listDirectory: (f: DirectoryFilter) => listDirectory(db, f),
    checkLinks: (urls: string[]) => checkLinks(db, urls),
    directoryStats: () => directoryStats(db),
    importDirectory: (rows: DirectoryCompany[]) => importDirectory(db, rows, "human"),
    // The tracker: applications made by hand, and everything that has gone out.
    recordManualApplication: (m: ManualApplication) => recordManualApplication(db, m, "human"),
    listTracker: () => listTracker(db),
    acceptProposal: (actionId: number, choice: { use?: "polished" | "original" | "text"; text?: string }) => acceptProposal(db, actionId, choice, "human"),
    listAccounts: () => listAccounts(db),
    listVerifications: () => listVerifications(db),
    setVerificationUsed: (id: number) => setVerificationUsed(db, id, "human"),
    ignoreVerification: (id: number) => ignoreVerification(db, id, "human"),
    getAccount: (id: number) => getAccount(db, id),
    createAccount: (a: { site: string; username: string; loginUrl?: string; jobId?: number }) => createAccount(db, a, "human"),
    confirmAccount: (id: number) => confirmAccount(db, id, "human"),
    markAccountVerified: (id: number) => markAccountVerified(db, id, "human"),
    touchAccount: (id: number) => touchAccount(db, id),
    deleteAccount: (id: number) => deleteAccount(db, id, "human"),
    // Replies and follow-ups. The dashboard reads the mailbox itself; the agent cannot.
    listMessages: (opts?: { status?: MessageStatus; jobId?: number }) => listMessages(db, opts),
    newMessageCount: () => newMessageCount(db),
    setMessageStatus: (id: number, status: MessageStatus) => setMessageStatus(db, id, status, "human"),
    setMessageCategory: (id: number, category: Category) => setMessageCategory(db, id, category, "human"),
    applyMessageOutcome: (id: number, to: "replied" | "interview" | "rejected") => applyMessageOutcome(db, id, to, "human"),
    draftFollowUp: (jobId: number) => draftFollowUp(db, jobId, "human"),
    getSyncState: () => getSyncState(db),
    dueFollowUps: () => dueFollowUps(db),
    setCompanyVerdict: (companyId: number, verdict: Verdict, reason?: string) => setCompanyVerdict(db, companyId, verdict, reason, "human"),
    listSources: () => listSources(db),
    addSource: (s: Parameters<typeof upsertSource>[1]) => upsertSource(db, s, "human"),
    setSourceEnabled: (id: number, enabled: boolean) => setSourceEnabled(db, id, enabled, "human"),
    discoveryBudget: () => discoveryBudget(db),
    allowedTransitions: (from: JobState) => allowedTransitions(from, "human"),
  };
}
