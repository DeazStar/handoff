export { openDb, migrate, type DB } from "./db.js";
export { JOB_STATES, assertTransition, allowedTransitions, TransitionError, type JobState, type Actor } from "./states.js";
export { addCandidateJob, transitionJob, logEvent, type NewJob } from "./jobs.js";
export { queueAction, listOpenActions, resolveAction, reportGap, confirmGap, ACTION_KINDS, type ActionKind, type GapReport } from "./actionQueue.js";
export { canonicalizeUrl, hashDescription } from "./normalize.js";
export { createAgentApi, createHumanApi } from "./api.js";
export {
  getProfile, setProfile, getPreferences, setPreferences,
  type Profile, type Preferences,
} from "./profile.js";
export { addFact, updateFact, deleteFact, makeFactGeneral, listFacts, getFacts, FACT_KINDS, type Fact, type NewFact, type FactKind } from "./facts.js";
export { saveDocument, deleteDocument, getDocument, listDocuments, checkProvenance, numberTokens, ProvenanceError, type Block, type NewDocument, type SavedDocument } from "./documents.js";
export { listJobs, getJob, listActionsDetailed, sourceStats, type JobRow, type JobDetail, type ActionDetail } from "./queries.js";
export { resolveDataPaths } from "./paths.js";
export { upsertCompany, upsertSource, recordVerification, setMatch, setRoute, checkCandidate, logSkippedCandidate, SKIP_REASONS, BudgetError, addCandidateJobWithinBudget, userLinkBudget, checkLinks, type LinkCheck, listSources, setSourceEnabled, discoveryBudget, type Verification, type SourceRow } from "./agentOps.js";
export {
  ENTRY_KINDS, ENTRY_WEIGHTS, EMPLOYMENT_TYPES, listEntries, getEntry, addEntry, updateEntry, moveEntry, deleteEntry, addBullet, setSkillGroup,
  getCvMaterial, importCv,
  type EntryKind, type EntryWeight, type EmploymentType, type EntryInput, type CvEntry, type CvMaterial, type CvImport,
} from "./cv.js";
export { prepareCv, orderForCv, type CvPlan, type ResolvedCv, type BulletRef } from "./cvPlan.js";
export { nextDocumentVersion } from "./documents.js";
export { COUNTRIES, canonicalCountry, requireCountry, type Country } from "./countries.js";
export {
  addContact, listContacts, getContact, markContactBounced, noContactFound, draftEmail, composeBody, getEmail, listEmails,
  updateEmail, discardEmail, beginSend, finishSend, failSend, releaseSend, applicationsToday, resetApplicationCount, countResetAt,
  type Contact, type DraftInput, type EmailDetail,
} from "./email.js";
export { verifyContact, pageShowsEmail, isPrivateAddress, defaultVerifyDeps, type VerifyDeps, type VerifyResult } from "./contactVerify.js";
export { addPerson, listPeople, getCompanyResearch, markCompanyResearched, type Person, type CompanyResearch } from "./research.js";
export { getJobDescription, type JobDetails } from "./queries.js";
export { saveJobDetails, MAX_DESCRIPTION } from "./jobs.js";
export { verifyPerson, derivePatternContact, pageShowsName, inferPattern, deriveAddress, splitName, ADDRESS_PATTERNS, type PatternResult, type NameCheck } from "./contactVerify.js";
export {
  prepareApplication, applicationRoom, assertApplicationRoom, getApplication, listApplications, markApplicationSubmitted, discardApplication, listStandardAnswers, setStandardAnswer, deleteStandardAnswer,
  ANSWER_KINDS, type Application, type ApplicationRow, type AnswerInput, type PrepareInput, type StandardAnswer,
} from "./application.js";
export { effectiveSponsorship } from "./profile.js";
export { PRIORITY_MODES, REMOTE_SCOPES, SPONSORSHIPS, priorityScore, type PriorityMode, type RemoteScope, type Sponsorship } from "./priority.js";
export { importDirectory, listDirectory, directoryStats, domainOf, listScoutCompanies, setCompanyVerdict, VERDICTS, type Verdict, type DirectoryCompany, type DirectoryRow, type DirectoryFilter, type DirectoryStats, type ImportResult } from "./directory.js";
export { collectYc, mapYcCompany, YC_HIRING_URL } from "./yc.js";
export { findCareersLink, findCareersPage, runCareerFinder, setCareersPage, looksScripted, type CareersOutcome, type FinderResult } from "./careers.js";
export { PROFILE_FIELDS, checkProfileAnswer, checkStandardAnswer, resolveSources, checkObserved, type CheckResult, type Check, type ProfileField } from "./answerCheck.js";
export { prepareCover, coverMode, latestCover, coverText, getCoverMaterial, CoverProblems, COVER_LIMITS, type CoverPlan, type ResolvedCover } from "./cover.js";
export { classifyMessage, matchMessage, ingestMessages, listMessages, newMessageCount, setMessageStatus, setMessageCategory, applyMessageOutcome, purgeOldSnippets, getSyncState, recordSync, dueFollowUps, scanFollowUps, draftFollowUp, getSyncTargets, CATEGORIES, type InboundMessage, type MessageRow, type Category, type MessageStatus, type IngestResult, type DueFollowUp, type ScanResult, type SyncState, type SyncTargets } from "./replies.js";
export { verifyContactFromBrowser, samePostingPage, TRUSTED_PAGE_RULES, MAX_BROWSER_QUOTE } from "./contactVerify.js";
export { recordManualApplication, listTracker, MANUAL_STATUSES, type ManualApplication, type ManualStatus, type TrackerRow } from "./manual.js";
export { requestProfileFill, createAccount, confirmAccount, markAccountVerified, deleteAccount, getAccount, listAccounts, accountStatus, requestAccount, generatePassword, siteOf, canonicalSite, SITE_FAMILIES, vaultNameFor, DEFAULT_PASSWORD_LENGTH, type PasswordRules, type AccountRow, type AccountRequest } from "./accounts.js";
export { ingestVerifications, looksLikeVerification, relatedToSite, pickVerificationLink, pendingAccounts, purgeVerifications, verificationTargets, siteLabel, listVerifications, setVerificationUsed, ignoreVerification, type VerificationMail } from "./verification.js";
export { experienceSummary, type ExperienceSummary } from "./cv.js";
export { askUser } from "./accounts.js";
export { SKILL_LEVELS, parseSkillItem, type SkillLevel } from "./cv.js";
export { proposeRemember, acceptProposal, type Proposal } from "./remember.js";
export { SENIORITY_LEVELS, SENIORITY_LABELS, normalizeSeniority, levelFit, type Seniority } from "./levels.js";
export { QUESTION_MODES, QUESTION_CATEGORIES, QUESTION_CATEGORY_TEXT, type QuestionMode, type QuestionCategory } from "./questions.js";

export { requestGapDrafts, cancelGapDrafts, listGapDraftRequests, submitGapDraft, type GapDraftState } from "./actionQueue.js";
export { requestMetricPolish, requestGapPolish, clearGapPolish, listGapPolishRequests, submitGapPolish, type GapPolishState } from "./actionQueue.js";
export { emailShapeProblems, EMAIL_LIMITS } from "./email.js";
export { lintWriting, assertWellWritten, type WritingIssue } from "./writingLint.js";
export { scoreCv, saveCvScore, getCvScore, type CvScore, type ScoreKeyword, type KeywordResult } from "./cvScore.js";
export { summaryProblems, headlineProblems, repeatsBullet } from "./cvPlan.js";
export { countBulletsWithoutNumber, requestMetricCards, confirmMetric } from "./metrics.js";
export { getSiteProfile, listSiteProfiles, setSiteProfile, type SiteProfile } from "./siteProfile.js";
