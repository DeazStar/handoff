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

## 15. Vault (secrets)

Holds secrets the user types: today the mail app password, later website sign-up credentials. Only the dashboard process can open it. The agent's tools never can.

### Principles
1. **The agent never sees a secret.** No MCP tool reads, writes or lists secret values, and the MCP package does not import the vault (a test checks this, like the existing import test).
2. **The key exists only in the dashboard's memory.** It is derived from a passphrase the user types, never stored. The agent's shell access could read a keychain entry or a key file; it cannot read a passphrase that was never written down.
3. **Write-only from the page.** The browser can set or replace a secret and see its name and "set" state. No endpoint ever returns a value.
4. **Secrets never reach logs, events, errors or the database.** The `accounts` table keeps site and email only.

### Storage
- One file in the data folder, `vault.enc`, mode 0600, written atomically (temp file, then rename).
- Format: a small header (magic, version, scrypt salt and parameters, nonce) followed by AES-256-GCM ciphertext of a JSON object `{ name: { value, updatedAt } }`.
- Key: scrypt from the passphrase (N=2^17, r=8, p=1, 32-byte output, random 16-byte salt). A wrong passphrase fails GCM authentication and nothing is returned.
- A fresh random nonce on every write. Changing the passphrase re-encrypts under a new salt.
- Passphrase: at least 12 characters, with a plain warning that it cannot be recovered. If it is forgotten, the vault is deleted and the secrets re-entered (app passwords are revocable, so nothing else is lost).

### Lifecycle
- **No vault yet:** the dashboard shows "Create vault" (passphrase twice).
- **Locked (every server start):** secrets cannot be read or written. Actions that need one say "Unlock the vault first".
- **Unlocked:** the derived key is held in memory. It is cleared on lock, on server stop, and after 30 minutes idle. The buffer is zeroed when dropped.
- Unlock attempts are throttled (at most 5 a minute) on top of the cost of scrypt.

### Dashboard API (all behind the existing token, Host and Origin checks)
| Call | Effect |
|---|---|
| `GET /api/vault/status` | `{ exists, unlocked, secrets: [{ name, updatedAt }] }`. Names only. |
| `POST /api/vault/create` `{ passphrase }` | Creates and unlocks. Refuses if one exists. |
| `POST /api/vault/unlock` `{ passphrase }` / `POST /api/vault/lock` | Opens or closes. |
| `PUT /api/vault/secrets/:name` `{ value }` | Sets or replaces. Write-only. |
| `DELETE /api/vault/secrets/:name` | Removes. |
| `POST /api/vault/change-passphrase` `{ old, new }` | Re-encrypts. |

### Code layout
- `packages/vault`: a library with no HTTP and no database: `createVault(dir)` with `create`, `unlock`, `lock`, `isUnlocked`, `names`, `set`, `remove`, `use(name, fn)`.
- `use(name, fn)` hands the secret to a callback and never returns it, so the mailer can open an SMTP session without the value passing through general code.
- Only `packages/server` depends on it. The MCP package must not.

### Secret names
- `mail.smtp`: `{ host, port, user, password }`. Defaults host `smtp.gmail.com`, port 465, user = the profile email.
- Later: `site:<hostname>` for sign-up credentials, used only by the extension on the user's click.

### Threats considered
| Threat | Mitigation |
|---|---|
| The agent reads the vault | No tool for it, no import of the package, key only in the dashboard's memory |
| The agent runs shell commands against the file | The file is ciphertext; the key is a passphrase it never sees |
| A web page calls the dashboard | Existing token, Host and Origin checks; secrets are write-only |
| Secret leaks through logs or errors | Values are never passed to the logger; SMTP errors are reduced to a short message |
| Stolen vault file | scrypt cost plus a 12+ character passphrase |
| User pastes a secret into chat | Documented; the setup screen says never to do this |

## 16. Email route: draft, approve, send

The agent finds a public contact and drafts the email. The user reviews and sends it from the dashboard. Sending is the user's click and nothing the agent can do.

### Data
- **contacts** (exists): `company_id, name, email, role, source_url`. The agent adds one with a required `source_url`, the public page where the address was found.
- **emails** (new): `id, job_id, contact_id, subject, body_blocks (JSON), body_text (the user's edited text, if any), attachment_document_id, status (draft | sending | sent | failed | discarded), error, message_id, created_at, sent_at`.
- The body is written as blocks, like any document, and must pass the same provenance check (every claim cites a fact, every number matches). Greetings and sign-offs are boilerplate.
- The attachment is a saved CV document for the same job.
- Plain text only: no HTML, no tracking pixels.

### Agent tools (MCP)
- `add_contact { companyId, email, name?, role?, sourceUrl }`: validates the address and requires the source URL.
- `draft_email { jobId, contactId, subject, blocks, attachCvDocumentId }`: runs the provenance check, saves a draft, queues `approve_email`, and moves the job to `awaiting_approval`. At most one open draft per job and contact.
- There is no tool that sends.

### Dashboard review
- Shows the recipient and the page it came from, the subject, the body (editable), and the attached CV with an Open PDF link.
- **Red warning when the recipient's domain does not match the company's domain.** This guards against a hostile page telling the agent to send the CV to an attacker.
- Buttons: Save edits, Send, Discard. Editing is the user writing, so their text is not provenance-checked.
- "Send test email to myself" to confirm the credentials before the first real send.

### Send (`POST /api/emails/:id/send`)
1. Preconditions: status is draft, the vault is unlocked, `mail.smtp` is set, the attachment file exists inside the documents folder, the address is valid.
2. Daily cap: emails sent today (the user's local day) must be below "Applications per day" in Settings.
3. Set status `sending` first, so a double click cannot send twice.
4. Send over SMTP from the profile email, with the CV attached as `<Name>-CV.pdf`, Reply-To set to the profile email, and an optional BCC to self (a setting).
5. On success: status `sent`, store the message id, write an `applications` record, move the job from `awaiting_approval` to `applied` as the human, and log the event. On failure: status `failed` with a short error and no secret, and a Retry button.

### Safety rules
- The agent cannot send, cannot change a draft after the user edits it, and cannot read the vault.
- One recipient per email, no lists, no CC.
- Limits on subject and body length and on attachment size.
- Tests use a JSON transport that sends nothing.

### Build order
1. `packages/vault` with tests (wrong passphrase, tampering, atomic write, idle lock, no secret in errors).
2. Dashboard vault endpoints and an Unlock/Create box.
3. Mail credentials form and "Send test email to myself".
4. `emails` table, contact and draft tools, provenance check on drafts.
5. Review and Send in the dashboard, with the daily cap.
6. A `/email` command that finds a contact and drafts for jobs that apply by email.

### Contact verification (before any draft)
The agent's `add_contact` is refused unless all of these hold. The refusal tells it to search again.
1. The address is well formed, and its domain has mail records (MX, or A as a fallback).
2. **The address appears on the cited source page.** The server fetches `source_url` itself (https only, 10 second timeout, 2 MB cap, up to 3 redirects, and every hop is checked so it cannot reach private or local addresses), and looks for the address in the text and in `mailto:` links. A guessed address will not be there.
3. The address is not marked bounced.
- No SMTP probing: it is unreliable, blocked on most home networks, and looks like address harvesting.
- If a page builds its text with JavaScript, the fetch can miss a real address. The user can then add the contact by hand in the dashboard, which skips check 2 but keeps check 1.
- After a send, a bounce arrives in the user's inbox. The user marks the contact bounced, and the agent is told never to reuse it.

### Decisions
- BCC the user on every email (a setting, on by default).
- Default subject: `Application: <role>, <profile name>`, editable on each draft.
- Vault passphrase: at least 12 characters.

### Open questions
1. Gmail OAuth later, instead of app passwords?
