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
