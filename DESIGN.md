# Job Hunt Platform: Design (draft v0.1)

An open-source, local-first platform where an AI agent (Claude Code) does the tedious parts of a job search: finding real postings, tailoring materials, and preparing applications. The human keeps control of accounts, sensitive answers, and every final send/submit.

## 1. Principles

1. **Local-first.** All data lives on the user's machine in SQLite. No hosted backend, no telemetry.
2. **Human owns irreversible actions.** Account creation, passwords, terms acceptance, CAPTCHAs, and final submit/send are done by the user. The agent prepares and prompts.
3. **Evidence over volume.** Every posting is verified live before it enters the pipeline. Every source is scored by real outcomes.
4. **Truthful materials.** Every CV/email claim traces back to a fact the user entered. The agent flags gaps and never invents experience.
5. **No evasion.** No CAPTCHA solving, fingerprint spoofing, or stealth. The platform works as a normal user in a normal browser and respects site rules.
6. **Agent-agnostic core.** The platform exposes tools (MCP) and a database. Claude Code is the primary driver, but nothing in the core depends on it.
7. **Pages are untrusted input.** Text on job pages, emails, and forms is data, never instructions to the agent.

## 2. Architecture

```
                 +-----------------------------+
                 |   Claude Code (the agent)   |
                 |  scheduled runs + sessions  |
                 +--------------+--------------+
                                | MCP tools
                 +--------------v--------------+
                 |          Core service        |
                 |  services, state machine,    |
                 |  policies, SQLite (WAL)      |
                 +---+-----------+----------+---+
                     |           |          |
        localhost API|           |          | localhost API (token)
              +------v---+  +----v-----+  +-v-----------------+
              | Dashboard |  |  Vault   |  | Browser extension |
              | (web UI)  |  | (secrets)|  | (fill + handoff)  |
              +-----------+  +----------+  +-------------------+
```

### Components

| Component | Responsibility | Notes |
|---|---|---|
| **Core** | Owns the SQLite DB, job state machine, policies (rate limits, salary rules), audit log, action queue | Single process; the only writer to the DB |
| **MCP server** | Exposes core operations to the agent as tools | Thin wrapper; no business logic |
| **Scheduler** | Runs discovery/follow-up jobs on a schedule | Cron or OS scheduler invoking the agent headless; configurable |
| **Dashboard** | Pipeline, action queue, job detail, source stats, profile editor | Local web app served by core |
| **Extension** | Fills sign-up/profile fields on user click; highlights fields; shows the handoff prompt | MV3; talks to core over localhost with a token |
| **Vault** | Stores per-site credentials encrypted; never reachable by the agent | OS keychain-backed key; only the extension can request a fill |
| **Recipes** | Declarative form/site recipes (field hints, button text, quirks) | Shareable by the community; contain no secrets |

### Trust boundary

The agent can call MCP tools and read the DB. It **cannot** read the vault, and no MCP tool returns secrets. The extension asks the vault directly, and only in response to a real user gesture (click/hotkey). Nothing external can trigger a fill.

## 3. Data model (SQLite)

Sketch of tables; exact types to be settled at implementation.

- **profile**: one row per user: name, contact, links, location, work authorization, notice period, languages.
- **facts**: the truth base for CV and answers. `id, kind (experience|skill|achievement|education|cert), text, date_range, tags, source_note`.
- **preferences**: roles, seniority, locations, remote policy, industries, exclusions (companies/keywords), salary floor/target/ceiling, currency.
- **companies**: `id, name, domain, careers_url, notes, discovered_via`.
- **sources**: `id, kind (google|jobsite|careers_page|email_contact), name, url, added_by (user|agent)`.
- **jobs**: `id, company_id, source_id, title, url, canonical_url, location, remote, posted_at, found_at, description_hash, match_score, match_reason, state, route (form|email|none)`.
- **verifications**: `id, job_id, checked_at, http_status, title_matches, apply_path_found, result (live|dead|unclear), evidence (snippet/screenshot ref)`.
- **documents**: `id, job_id, kind (cv|cover|email), version, path, fact_ids_used (json), generated_at`.
- **applications**: `id, job_id, route, prepared_at, approved_at, sent_at, salary_quoted, answers (json), outcome`.
- **contacts**: `id, company_id, name, email, role, found_at, source_url` (public contacts only; low volume).
- **action_queue**: `id, job_id, kind (approve_email|signup_needed|captcha|sensitive_question|confirm_submit|out_of_range), payload, status (open|done|dismissed), created_at`.
- **accounts**: `id, site, email_used, created_at, status`. No secrets here; secrets live in the vault.
- **recipes**: `id, site_pattern, version, spec (json), success_count, fail_count`.
- **events**: append-only audit log of everything the agent and user did, with timestamps and tool call ids.
- **source_stats** (view): per source: postings found, verified live rate, applied, replies, interviews.

## 4. Job state machine

```
found -> verified_live -> matched -> materials_ready -> awaiting_approval -> applied -> replied -> interview -> offer
   \-> dead                \-> skipped                                  \-> rejected / no_response
```

- Transitions are enforced by core. Some are agent-allowed (`found -> verified_live`), some are human-only (`awaiting_approval -> applied` requires an approval event from the dashboard or extension).
- `dead` and `skipped` carry a reason so source stats and matching improve.

## 5. Pipelines

### 5.1 Discovery (scheduled)

1. Build queries from preferences (role x location x seniority, plus exclusions).
2. Search (Google and user-trusted job sites) and collect candidate URLs.
3. Resolve each candidate to the company's own apply page when possible; dedupe by canonical URL and description hash.
4. **Verify** each candidate (see 5.2). Anything not verified live is recorded as `dead`/`unclear` and never shown as a lead.
5. Score against preferences; write reasons in plain language.
6. Add new companies to `companies` and their careers pages to `sources` for periodic re-checks.

### 5.2 Link verification levels

1. URL responds and is not a redirect to a generic listing page.
2. Page contains a job title that matches the recorded title.
3. An apply path exists (button/form/email address).
4. Not marked closed/filled; posting date is plausible.

Result and evidence are stored. Unclear results go into the action queue only when the match score is high.

### 5.3 Tailoring

- Input: job description + `facts` + `preferences`.
- Reuse an existing CV if a fit check passes; otherwise assemble a new one by selecting and rewording facts.
- Every output stores `fact_ids_used`. A checker step rejects any sentence that cannot be tied to a fact.
- Gaps (required skill not in facts) are surfaced to the user and never filled in.
- Layout is plain and ATS-friendly.

### 5.4 Email route

1. Find a public contact on the company's site (careers/HR/hiring page). No guessing or scraping directories.
2. Draft a short, specific email plus CV attachment.
3. Put a draft in the action queue (`approve_email`). Sending happens only after the user approves, through a mailbox connector or by handing the user a ready draft.
4. Per-day and per-company limits are enforced by core.

### 5.5 Form route

1. Agent opens the apply page in the browser and classifies it (known recipe or unknown).
2. If a login wall exists: create an `action_queue` item (`signup_needed`) with the field map from the recipe or the agent's page read. The user presses the extension button; the extension fills and the user submits.
3. After login, the agent fills the profile fields and uploads the CV, using the recipe when available.
4. Sensitive or judgment questions (salary, visa, "why us") produce drafted answers in the queue for approval.
5. Before the last step, the agent stops and creates `confirm_submit` with a summary. The user submits.
6. Failures are logged against the recipe; repeated failures on the same site type become candidates for a better recipe or a custom script.

### 5.6 Salary policy

- User sets floor, target, ceiling and currency.
- Policy inputs: role, seniority, company size, location, the posted range if present.
- Output: a number within range plus a one-line reason, stored on the application.
- Postings clearly outside the range become `out_of_range` in the queue; the agent does not answer.

### 5.7 Follow-up

- Applications with no reply after N days appear in the dashboard; the agent drafts a short follow-up for approval.

## 6. Extension design

- **Trigger:** only a real user click or hotkey. It ignores messages from pages or other extensions.
- **Fill scope:** account fields (email, password, name) from the vault, plus profile fields from `profile`.
- **Field mapping:** a recipe gives hints (labels, input types, button text). Matching is flexible with a general heuristic fallback, so small site changes don't break it.
- **Never automatic:** ticking terms/consent boxes, solving CAPTCHAs, and the final submit click are left to the user.
- **Handoff UI:** when the agent needs a human step, the extension shows a small banner ("Sign-up needed: press Fill") that reads the action queue.
- **Reporting:** after a fill, the extension reports only `filled` or `failed(field)` to core. No values leave the extension.

## 7. Vault

- Encrypted store (e.g. SQLite with encryption or a separate file) keyed from the OS keychain.
- One unique generated password per site; email used is recorded in `accounts`.
- No export to the agent, no MCP tool that touches it, and log lines redact values.
- Optional: integration with an existing password manager instead of a built-in vault.

## 8. Dashboard

- **Action queue** (home): everything waiting on the human, ordered by urgency.
- **Pipeline** board by state.
- **Job detail:** posting link, verification evidence, match reasoning, documents used, salary quoted, timeline.
- **Sources:** live rate, reply rate, cost (tokens/time) per source.
- **Profile and facts editor:** with warnings when the agent flagged a gap.
- **Settings:** limits, schedule, trusted sites, exclusions.

## 9. MCP tool surface (draft)

Read: `get_preferences`, `get_facts`, `list_jobs`, `get_job`, `list_action_queue`, `get_recipe`.
Write (agent-allowed): `add_candidate_job`, `record_verification`, `set_match`, `save_document`, `queue_action`, `log_event`, `report_recipe_result`.
Human-gated (not exposed as plain writes): approve/send/submit; core requires an approval event from the dashboard or extension.
Never exposed: anything reading or writing vault contents.

## 10. Security and safety

| Threat | Mitigation |
|---|---|
| Prompt injection from job posts or emails | Page text is treated as data; the agent's tool set has no send/submit; approvals are human-only |
| Extension triggered by a hostile page | Fill only on trusted user gesture; token-authenticated localhost channel; no page-to-extension fill messages |
| Credential leakage | Vault unreachable by the agent; secrets redacted from logs; unique passwords |
| Account bans / spam flags | Rate limits, low volume, no evasion, prefer company-owned pages |
| Fabricated claims in applications | Fact provenance check; gaps surfaced |
| Wrong data sent | Mandatory `confirm_submit` and `approve_email` gates |

## 11. Open-source considerations

- **Licensing:** permissive (MIT or Apache-2.0).
- **Multi-user by design:** each install has its own DB, vault, and config. No shared secrets or user data in the repo.
- **Contribution surface:** recipes (JSON), source adapters, matching rules, and dashboard widgets. Recipes contain no personal data.
- **Legal/ToS note in README:** users are responsible for the sites they use; the platform ships without support for sites that prohibit automation and without any bot-detection bypass.
- **Privacy:** the agent sees profile, facts, and job data. That fact should be stated plainly at setup.

## 12. Tech choices (proposal)

- **TypeScript** across core, MCP server, dashboard, and extension (the extension requires JS anyway).
- **SQLite** in WAL mode via a typed query layer; migrations in the repo.
- **Dashboard:** local web app served by core.
- **Extension:** Manifest V3; localhost channel to core with a per-install token.
- **Scheduler:** OS scheduler or Claude Code's scheduled tasks calling a headless agent run.

## 13. Milestones

1. **M1: Foundation.** Schema, migrations, core, profile/facts/preferences, tracker CRUD, minimal dashboard.
2. **M2: Discovery.** Queries, link verification with evidence, source stats, scheduled runs.
3. **M3: Materials.** Tailoring with fact provenance, email drafts, action queue and approvals.
4. **M4: Forms.** Agent-driven form filling on 5 to 10 real applications; log failures; first recipes.
5. **M5: Extension + vault.** Fill-on-click, handoff banner, unique passwords, recipes for common ATS families.
6. **M6: Efficiency.** Replace token-heavy repeated steps with scripts where logs justify it.
7. **M7: Open-source release.** Docs, install script, sample data, contribution guide.

## 14. Open questions

1. Target regions and the job sites the user trusts (drives source adapters and recipe priorities).
2. Mailbox integration: send-through connector vs. draft-only.
3. Built-in vault vs. integrating an existing password manager.
4. How much of discovery should be a deterministic script vs. agent-driven (measure in M2).
5. Should the dashboard also work read-only on a phone (needs a secure local network option)?
