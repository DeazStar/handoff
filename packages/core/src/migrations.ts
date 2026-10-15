export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  location TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  work_authorization TEXT,
  notice_period TEXT,
  languages TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('experience','skill','achievement','education','cert')),
  text TEXT NOT NULL,
  date_range TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  roles TEXT NOT NULL DEFAULT '[]',
  seniority TEXT NOT NULL DEFAULT '[]',
  locations TEXT NOT NULL DEFAULT '[]',
  remote_policy TEXT NOT NULL DEFAULT 'any' CHECK (remote_policy IN ('any','remote','onsite','hybrid')),
  industries TEXT NOT NULL DEFAULT '[]',
  exclusions TEXT NOT NULL DEFAULT '[]',
  salary_floor INTEGER,
  salary_target INTEGER,
  salary_ceiling INTEGER,
  currency TEXT,
  daily_application_limit INTEGER NOT NULL DEFAULT 5,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT UNIQUE,
  careers_url TEXT,
  notes TEXT,
  discovered_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('google','jobsite','careers_page','email_contact')),
  name TEXT NOT NULL,
  url TEXT,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK (added_by IN ('user','agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  source_id INTEGER REFERENCES sources(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  location TEXT,
  remote INTEGER,
  posted_at TEXT,
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  description_hash TEXT,
  match_score REAL,
  match_reason TEXT,
  state TEXT NOT NULL DEFAULT 'found',
  state_reason TEXT,
  route TEXT NOT NULL DEFAULT 'none' CHECK (route IN ('form','email','none')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_desc_hash ON jobs(description_hash);

CREATE TABLE verifications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  http_status INTEGER,
  title_matches INTEGER,
  apply_path_found INTEGER,
  result TEXT NOT NULL CHECK (result IN ('live','dead','unclear')),
  evidence TEXT
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cv','cover','email')),
  version INTEGER NOT NULL DEFAULT 1,
  path TEXT NOT NULL,
  fact_ids_used TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  route TEXT NOT NULL CHECK (route IN ('form','email')),
  prepared_at TEXT,
  approved_at TEXT,
  sent_at TEXT,
  salary_quoted INTEGER,
  salary_reason TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  outcome TEXT
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT NOT NULL,
  role TEXT,
  source_url TEXT NOT NULL,
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, email)
);

CREATE TABLE action_queue (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'approve_email','signup_needed','captcha','sensitive_question',
    'confirm_submit','out_of_range','verify_unclear','follow_up')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_action_queue_open ON action_queue(status, created_at);

-- Accounts hold no secrets. Credentials live in the vault, out of the agent's reach.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  email_used TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','verified','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site, email_used)
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  site_pattern TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  spec TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (site_pattern, version)
);

-- Append-only audit log.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL CHECK (actor IN ('agent','human','system')),
  type TEXT NOT NULL,
  job_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE VIEW source_stats AS
SELECT
  s.id AS source_id,
  s.name AS source_name,
  COUNT(j.id) AS found,
  SUM(CASE WHEN j.state = 'dead' THEN 1 ELSE 0 END) AS dead,
  SUM(CASE WHEN j.state IN ('applied','replied','interview','offer','rejected','no_response') THEN 1 ELSE 0 END) AS applied,
  SUM(CASE WHEN j.state IN ('replied','interview','offer') THEN 1 ELSE 0 END) AS replies
FROM sources s LEFT JOIN jobs j ON j.source_id = s.id
GROUP BY s.id;
`,
  },
  {
    id: 2,
    name: "job_state_guard",
    // SQLite has no session variables, so transitionJob announces the change it is about
    // to make in this one-row table and the triggers refuse any state change that was not
    // announced. This stops accidental direct UPDATEs; it is not a defence against code
    // that deliberately writes to the guard table.
    sql: `
CREATE TABLE transition_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  job_id INTEGER,
  to_state TEXT
);
INSERT INTO transition_guard (id) VALUES (1);

CREATE TRIGGER jobs_state_insert_guard BEFORE INSERT ON jobs
WHEN NEW.state != 'found'
BEGIN SELECT RAISE(ABORT, 'jobs must be created in state found'); END;

CREATE TRIGGER jobs_state_update_guard BEFORE UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'job state can only change through transitionJob')
  WHERE NOT EXISTS (
    SELECT 1 FROM transition_guard WHERE job_id = OLD.id AND to_state = NEW.state
  );
END;
`,
  },
  {
    id: 3,
    name: "document_content",
    // The blocks as written, so the exact wording can be reviewed before approval.
    sql: `ALTER TABLE documents ADD COLUMN content TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    id: 4,
    name: "action_kind_gap",
    // SQLite cannot alter a CHECK constraint, so the table is rebuilt with 'gap' added.
    sql: `
CREATE TABLE action_queue_new (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'approve_email','signup_needed','captcha','sensitive_question',
    'confirm_submit','out_of_range','verify_unclear','follow_up','gap')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
INSERT INTO action_queue_new (id, job_id, kind, payload, status, created_at, resolved_at)
  SELECT id, job_id, kind, payload, status, created_at, resolved_at FROM action_queue;
DROP TABLE action_queue;
ALTER TABLE action_queue_new RENAME TO action_queue;
CREATE INDEX idx_action_queue_open ON action_queue(status, created_at);
`,
  },
  {
    id: 5,
    name: "job_scoped_facts",
    // job_id NULL = a general fact. A number = usable only in documents for that job.
    sql: `ALTER TABLE facts ADD COLUMN job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE;`,
  },
  {
    id: 6,
    name: "discovery_budget_and_source_toggle",
    // How many jobs one day's discovery may add, and a switch to pause a source without deleting it.
    sql: `
ALTER TABLE preferences ADD COLUMN daily_discovery_limit INTEGER NOT NULL DEFAULT 10;
ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    id: 7,
    name: "search_any_site",
    // 1: the agent may use Google and any career page. 0: only the sites the user listed.
    sql: `ALTER TABLE preferences ADD COLUMN search_any_site INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    id: 8,
    name: "skipped_candidates",
    // Links the agent opened and rejected. Remembered so they are never opened twice, and counted per source.
    sql: `
CREATE TABLE skipped_candidates (
  id INTEGER PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('dead','closed','not_a_match','blocked','repost','other')),
  detail TEXT,
  source_id INTEGER REFERENCES sources(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP VIEW source_stats;
CREATE VIEW source_stats AS
SELECT
  s.id AS source_id,
  s.name AS source_name,
  COUNT(j.id) AS found,
  SUM(CASE WHEN j.state = 'dead' THEN 1 ELSE 0 END) AS dead,
  SUM(CASE WHEN j.state IN ('applied','replied','interview','offer','rejected','no_response') THEN 1 ELSE 0 END) AS applied,
  SUM(CASE WHEN j.state IN ('replied','interview','offer') THEN 1 ELSE 0 END) AS replies,
  (SELECT COUNT(*) FROM skipped_candidates k WHERE k.source_id = s.id) AS skipped
FROM sources s LEFT JOIN jobs j ON j.source_id = s.id
GROUP BY s.id;
`,
  },
  {
    id: 9,
    name: "cv_entries",
    // Jobs, education and projects as structured entries. Bullets are facts that point at an entry.
    // Skill facts carry their group. A CV document keeps the plan it was built from.
    sql: `
CREATE TABLE cv_entries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('work','education','project')),
  title TEXT NOT NULL,
  organization TEXT,
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE facts ADD COLUMN entry_id INTEGER REFERENCES cv_entries(id);
ALTER TABLE facts ADD COLUMN skill_group TEXT;
ALTER TABLE documents ADD COLUMN plan TEXT;
CREATE INDEX idx_facts_entry ON facts(entry_id);
`,
  },
  {
    id: 10,
    name: "entry_weight_and_cv_guidance",
    // weight: how much a tailored CV must respect an entry. lead: always included and listed before
    // the others of its kind. always: always included. normal: the agent decides.
    sql: `
ALTER TABLE cv_entries ADD COLUMN weight TEXT NOT NULL DEFAULT 'normal' CHECK (weight IN ('normal','always','lead'));
ALTER TABLE preferences ADD COLUMN cv_guidance TEXT;
`,
  },
  {
    id: 11,
    name: "country_priority",
    // country: where an entry's work was for. country_priority: the user's ranking of countries, best first.
    sql: `
ALTER TABLE cv_entries ADD COLUMN country TEXT;
ALTER TABLE preferences ADD COLUMN country_priority TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 12,
    name: "employment_type",
    // employment_type: how the work was done (full_time, part_time, contract, freelance). employment_priority:
    // the user's ranking of those types, best first, used after country priority.
    sql: `
ALTER TABLE cv_entries ADD COLUMN employment_type TEXT CHECK (employment_type IN ('full_time','part_time','contract','freelance'));
ALTER TABLE preferences ADD COLUMN employment_priority TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 13,
    name: "emails",
    // Contacts record where an address was found and whether it bounced. An email is a draft the agent writes
    // (its body is a saved document, so every claim is checked against facts) and the user edits and sends.
    sql: `
ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','bounced'));
ALTER TABLE contacts ADD COLUMN verified_at TEXT;
ALTER TABLE contacts ADD COLUMN added_by TEXT NOT NULL DEFAULT 'agent' CHECK (added_by IN ('agent','user'));

CREATE TABLE emails (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  subject TEXT NOT NULL,
  body_document_id INTEGER NOT NULL REFERENCES documents(id),
  body_text TEXT,
  attachment_document_id INTEGER REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed','discarded')),
  error TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX idx_emails_job ON emails(job_id);
CREATE UNIQUE INDEX idx_emails_open ON emails(job_id, contact_id) WHERE status IN ('draft','sending');

ALTER TABLE preferences ADD COLUMN bcc_self INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    id: 14,
    name: "posting_details_and_people",
    // The posting text is kept, so tailoring and emailing never reopen the page. People are the decision makers
    // found on a company's own site. A contact is either seen on a page, derived from the company's address
    // pattern (with its evidence), or typed by the user.
    sql: `
ALTER TABLE jobs ADD COLUMN description TEXT;
ALTER TABLE jobs ADD COLUMN posted_by TEXT;
ALTER TABLE jobs ADD COLUMN apply_url TEXT;
ALTER TABLE jobs ADD COLUMN details_at TEXT;
ALTER TABLE companies ADD COLUMN researched_at TEXT;

CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  source_url TEXT NOT NULL,
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

ALTER TABLE contacts ADD COLUMN person_id INTEGER REFERENCES people(id);
ALTER TABLE contacts ADD COLUMN verification TEXT NOT NULL DEFAULT 'on_page' CHECK (verification IN ('on_page','pattern','user'));
ALTER TABLE contacts ADD COLUMN evidence TEXT;
UPDATE contacts SET verification = 'user' WHERE added_by = 'user';

ALTER TABLE preferences ADD COLUMN research_min_score INTEGER NOT NULL DEFAULT 7;
ALTER TABLE preferences ADD COLUMN research_scope TEXT NOT NULL DEFAULT 'all' CHECK (research_scope IN ('all','email_only','off'));
ALTER TABLE preferences ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 10;
`,
  },
  {
    id: 15,
    name: "form_applications",
    // A prepared form application: what was typed into the form, what was left for the user, and the salary
    // quoted. The user submits on the site and then marks it submitted. Standard answers are the user's own
    // answers to questions every form asks.
    sql: `
ALTER TABLE applications ADD COLUMN form_url TEXT;
ALTER TABLE applications ADD COLUMN left_blank TEXT NOT NULL DEFAULT '[]';
ALTER TABLE applications ADD COLUMN notes TEXT;
ALTER TABLE applications ADD COLUMN salary_period TEXT;
ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','discarded'));
UPDATE applications SET status = 'submitted' WHERE sent_at IS NOT NULL;

CREATE TABLE standard_answers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  answer TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE preferences ADD COLUMN salary_period TEXT CHECK (salary_period IN ('month','year'));
`,
  },
  {
    id: 16,
    name: "consent_default",
    // What the Apply button starts with: none, privacy (the privacy consent only) or required (every box needed to submit).
    // Only the dashboard reads it. Each run still carries its own word in the command the user pastes.
    sql: `ALTER TABLE preferences ADD COLUMN consent_default TEXT NOT NULL DEFAULT 'none' CHECK (consent_default IN ('none','privacy','required'));`,
  },
  {
    id: 17,
    name: "remote_and_sponsorship",
    sql: `
      ALTER TABLE jobs ADD COLUMN remote_scope TEXT CHECK (remote_scope IN ('worldwide','open_to_me','closed','unclear'));
      ALTER TABLE jobs ADD COLUMN sponsorship TEXT NOT NULL DEFAULT 'unknown' CHECK (sponsorship IN ('confirmed','likely','unknown'));
      ALTER TABLE jobs ADD COLUMN sponsorship_evidence TEXT;
      ALTER TABLE preferences ADD COLUMN priority_mode TEXT NOT NULL DEFAULT 'remote_first' CHECK (priority_mode IN ('remote_first','sponsored_first','balanced'));
    `,
  },
  {
    id: 18,
    name: "company_directory",
    // Companies collected from public lists, before any job from them is found.
    // careers_status: unknown (never looked), found (careers_url is set), none (looked, no careers page).
    sql: `
      ALTER TABLE companies ADD COLUMN website TEXT;
      ALTER TABLE companies ADD COLUMN location TEXT;
      ALTER TABLE companies ADD COLUMN one_liner TEXT;
      ALTER TABLE companies ADD COLUMN description TEXT;
      ALTER TABLE companies ADD COLUMN industry TEXT;
      ALTER TABLE companies ADD COLUMN team_size INTEGER;
      ALTER TABLE companies ADD COLUMN remote_hint TEXT CHECK (remote_hint IN ('fully','partly'));
      ALTER TABLE companies ADD COLUMN source TEXT;
      ALTER TABLE companies ADD COLUMN source_ref TEXT;
      ALTER TABLE companies ADD COLUMN careers_status TEXT NOT NULL DEFAULT 'unknown' CHECK (careers_status IN ('unknown','found','none'));
      ALTER TABLE companies ADD COLUMN careers_checked_at TEXT;
      ALTER TABLE companies ADD COLUMN collected_at TEXT;
      CREATE UNIQUE INDEX idx_companies_source_ref ON companies(source, source_ref) WHERE source IS NOT NULL;
    `,
  },
  {
    id: 19,
    name: "company_verdicts",
    // verdict: unreviewed (nobody has judged it), potential (it has an opening that fits) or discarded (nothing fits).
    // verdict_by: agent or user. A user's verdict is never changed by the agent.
    // careers_note: why the career page is still unknown (for example, the page needs a browser).
    sql: `
      ALTER TABLE companies ADD COLUMN verdict TEXT NOT NULL DEFAULT 'unreviewed' CHECK (verdict IN ('unreviewed','potential','discarded'));
      ALTER TABLE companies ADD COLUMN verdict_reason TEXT;
      ALTER TABLE companies ADD COLUMN verdict_by TEXT CHECK (verdict_by IN ('agent','user'));
      ALTER TABLE companies ADD COLUMN verdict_at TEXT;
      ALTER TABLE companies ADD COLUMN careers_note TEXT;
      CREATE INDEX idx_companies_verdict ON companies(verdict);
    `,
  },
  {
    id: 20,
    name: "scout_tried",
    // When /scout was last handed this company. A company handed out without getting a verdict goes behind the untried ones.
    sql: `ALTER TABLE companies ADD COLUMN scout_tried_at TEXT;`,
  },
  {
    id: 21,
    name: "profile_sponsorship",
    // Whether the user needs a visa sponsored. Null means not said yet. A form's sponsorship question is answered from it.
    sql: `ALTER TABLE profile ADD COLUMN requires_sponsorship INTEGER CHECK (requires_sponsorship IN (0,1));`,
  },
  {
    id: 22,
    name: "cover_letters",
    // cover_letters: auto (a letter for every email job and for forms that ask) or off.
    // A sent email carries the cover letter PDF next to the CV.
    sql: `
      ALTER TABLE preferences ADD COLUMN cover_letters TEXT NOT NULL DEFAULT 'auto' CHECK (cover_letters IN ('auto','off'));
      ALTER TABLE preferences ADD COLUMN cover_guidance TEXT;
      ALTER TABLE emails ADD COLUMN cover_document_id INTEGER REFERENCES documents(id);
    `,
  },
  {
    id: 23,
    name: "replies_and_follow_ups",
    // messages: replies found in the user's mailbox that belong to an application (nothing else is kept).
    // emails.kind: a follow-up is an email in the same thread as the application email, with no attachments.
    sql: `
      ALTER TABLE emails ADD COLUMN kind TEXT NOT NULL DEFAULT 'application' CHECK (kind IN ('application','follow_up'));
      ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        from_addr TEXT NOT NULL,
        from_name TEXT,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'reply' CHECK (category IN ('reply','auto_reply','bounce','rejection','interview','other')),
        matched_by TEXT NOT NULL CHECK (matched_by IN ('thread','sender')),
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled','ignored')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_messages_job ON messages(job_id);
      CREATE TABLE mail_sync (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_run_at TEXT,
        last_error TEXT,
        last_checked INTEGER NOT NULL DEFAULT 0,
        last_matched INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE preferences ADD COLUMN auto_mark_replied INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE preferences ADD COLUMN follow_up_days INTEGER NOT NULL DEFAULT 7;
      ALTER TABLE preferences ADD COLUMN max_follow_ups INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE preferences ADD COLUMN no_response_days INTEGER NOT NULL DEFAULT 21;
      ALTER TABLE preferences ADD COLUMN reply_snippet_days INTEGER NOT NULL DEFAULT 90;
      ALTER TABLE preferences ADD COLUMN reply_check_minutes INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 24,
    name: "user_provided_jobs",
    // A job added from a link the user gave. It does not use the discovery limit; a separate daily allowance applies.
    sql: `ALTER TABLE jobs ADD COLUMN user_provided INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: 25,
    name: "cookie_banners",
    // How the agent answers a cookie banner on a site it visits: accept (so the page is not blocked) or necessary (strictly necessary only).
    sql: `ALTER TABLE preferences ADD COLUMN cookie_banners TEXT NOT NULL DEFAULT 'accept' CHECK (cookie_banners IN ('accept','necessary'));`,
  },
  {
    id: 26,
    name: "manual_applications",
    // jobs.manual: the user applied by hand and recorded it; it uses no discovery limit. applications.contact_id: who a manual email went to.
    sql: `
      ALTER TABLE jobs ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE applications ADD COLUMN contact_id INTEGER REFERENCES contacts(id);
    `,
  },
  {
    id: 27,
    name: "accounts_for_signup",
    // The password is never in the database: it is in the vault under vault_name. confirmed_at: the user created the account on the site.
    sql: `
      ALTER TABLE accounts ADD COLUMN vault_name TEXT;
      ALTER TABLE accounts ADD COLUMN login_url TEXT;
      ALTER TABLE accounts ADD COLUMN confirmed_at TEXT;
      ALTER TABLE accounts ADD COLUMN verified_at TEXT;
      ALTER TABLE accounts ADD COLUMN last_used_at TEXT;
      ALTER TABLE accounts ADD COLUMN job_id INTEGER;
    `,
  },
  {
    id: 28,
    name: "verification_mails",
    // Mail that looks like a site checking an address, for an account the user just made. The link is a one-time key:
    // it is dropped once used, and after 7 days.
    sql: `
      CREATE TABLE verification_mails (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE,
        from_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        link TEXT,
        link_host TEXT,
        link_related INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','used','ignored')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 29,
    name: "skill_levels",
    // A level the user states for a skill, for sites that ask for one. default_skill_level is used when a skill has none.
    sql: `
      ALTER TABLE facts ADD COLUMN skill_level TEXT CHECK (skill_level IN ('beginner','intermediate','advanced','expert'));
      ALTER TABLE preferences ADD COLUMN default_skill_level TEXT CHECK (default_skill_level IN ('beginner','intermediate','advanced','expert'));
    `,
  },
  {
    id: 30,
    name: "job_seniority",
    // The level the posting asks for, recorded when the job is scored. How it fits the user's wanted levels is worked out when it is read.
    sql: `ALTER TABLE jobs ADD COLUMN seniority TEXT CHECK (seniority IN ('intern','junior','mid','senior','lead','staff_plus'));`,
  },
  {
    id: 31,
    name: "question_modes",
    // How the agent asks for an answer only the user can give: batch (all at the end, in the chat, and as cards), chat (at once, in the chat)
    // or cards (only in Needs you). question_overrides: a mode per kind of question, or never.
    sql: `
      ALTER TABLE preferences ADD COLUMN question_mode TEXT NOT NULL DEFAULT 'batch' CHECK (question_mode IN ('batch','chat','cards'));
      ALTER TABLE preferences ADD COLUMN question_overrides TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: 32,
    name: "application_count_reset",
    // When the user last reset the daily application count. Applications sent and forms prepared before this moment no longer count against today's limit.
    sql: `ALTER TABLE preferences ADD COLUMN application_count_reset_at TEXT;`,
  },
  {
    id: 33,
    name: "writing_style",
    // How the user wants everything written for them to read: emails, cover letters and the free-text answers on forms.
    sql: `ALTER TABLE preferences ADD COLUMN writing_style TEXT;`,
  },
  {
    id: 34,
    name: "cv_scores",
    // The ATS score of a saved CV against its job's keywords, with the breakdown the dashboard shows.
    sql: `
      CREATE TABLE cv_scores (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        score INTEGER NOT NULL,
        detail TEXT NOT NULL,
        scored_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 35,
    name: "site_profiles",
    // Whether a site's candidate profile is finished, so a run does not check it or ask for it again and again.
    sql: `
      CREATE TABLE site_profiles (
        site TEXT PRIMARY KEY,
        complete INTEGER NOT NULL CHECK (complete IN (0,1)),
        source TEXT NOT NULL CHECK (source IN ('user','agent')),
        evidence TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];
