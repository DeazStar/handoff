// Entry point for the MCP server: it can import the agent API and nothing that accepts an actor.
export { openDb, type DB } from "./db.js";
export { createAgentApi } from "./api.js";
export { canonicalizeUrl, hashDescription } from "./normalize.js";
export { resolveDataPaths } from "./paths.js";
// Constants and types the tool definitions need.
export { JOB_STATES, type JobState } from "./states.js";
export { FACT_KINDS, type FactKind } from "./facts.js";
export { ACTION_KINDS, type ActionKind } from "./actionQueue.js";
export type { Block } from "./documents.js";
export { SKIP_REASONS, type SkipReason } from "./agentOps.js";
export type { CvPlan, ResolvedCv, BulletRef } from "./cvPlan.js";
export type { CvMaterial, CvEntry } from "./cv.js";
export { verifyContact, verifyContactFromBrowser, samePostingPage, MAX_BROWSER_QUOTE, type VerifyResult } from "./contactVerify.js";
export type { Contact } from "./email.js";
export { verifyPerson, derivePatternContact, type PatternResult, type NameCheck, type VerifyDeps } from "./contactVerify.js";
export type { Person, CompanyResearch } from "./research.js";
export { ANSWER_KINDS, type AnswerInput, type PrepareInput, type Application, type StandardAnswer } from "./application.js";
export { REMOTE_SCOPES, SPONSORSHIPS } from "./priority.js";
export { coverText, COVER_LIMITS } from "./cover.js";
export type { CoverPlan, ResolvedCover } from "./cover.js";
export { effectiveSponsorship } from "./profile.js";
export { runCareerFinder } from "./careers.js";
export { defaultVerifyDeps } from "./contactVerify.js";
