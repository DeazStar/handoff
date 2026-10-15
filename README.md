# jobhunt-copilot

A local-first job-hunt platform. An AI assistant (Claude Code) does the tiring work: it finds real jobs, checks they are still open, tailors your CV and cover letter from facts you wrote, finds a verified contact, drafts the email and fills in the form. **You approve every step that cannot be undone.** Nothing is submitted, sent or signed up for without you.

Everything runs on your computer. Your data lives in one SQLite file, the dashboard listens only on `127.0.0.1`, and your secrets sit in an encrypted vault the assistant cannot read.

> **Status:** early. It is built and used by one person, mostly on macOS. Expect rough edges, and read the [limitations](#limitations) before relying on it.

## What it does

| | |
|---|---|
| **Find jobs** | `/discover` searches the sites and companies you choose, opens each page, checks it is live and scores it against your settings. `/scout` works through a list of companies (for example Y Combinator's) and judges their openings. `/add <link>` takes links you already have. |
| **Tailor** | `/tailor` builds a CV PDF (two pages at most) from your own facts and a cover letter that follows your writing rules. Every claim cites a fact, and every number must match one. It reports the skills a job wants that your facts do not support (a *gap*) and never covers them up. |
| **Apply by email** | `/email` finds a contact address that is really on the company's page, checks that its domain takes mail, and drafts the email. You edit and send it from the dashboard. |
| **Apply by form** | `/apply` fills the form in a real browser, leaves the tab open and records every answer with its source. You check and press Submit yourself. |
| **Follow up** | The dashboard reads your mailbox (read-only) for replies, moves jobs to *replied* when someone answers in your thread, and reminds you to follow up. A **Tracker** keeps applications you made by hand. |
| **Improve over time** | Gaps and bullets without numbers become cards. You answer once and every later CV benefits. An ATS-style score tells you what a CV is missing. |

## How it stays safe
- The assistant can **draft, fill and record**. It cannot **send, submit, create accounts, type passwords or read your vault**. Those are human actions in the dashboard. The code enforces this: the assistant and the human use different APIs, and a database trigger blocks job state changes that skip the rules.
- **No invented facts.** A CV, letter or email is checked against your saved facts before it is saved. An unsupported number or claim is refused.
- **Web pages and emails are data, not instructions.** Text from the internet is never obeyed.
- **No bot-detection tricks.** CAPTCHAs and cookie banners are handled as the page asks; CAPTCHAs are left to you.
- Daily limits cap how many jobs are added and how many applications go out.

## Requirements
- **Node.js 20 or newer**
- **[Claude Code](https://claude.com/claude-code)**, signed in, to run the slash commands
- **A Chromium-based browser** for form filling: Playwright's Chromium (`npx playwright install chromium`) or Google Chrome
- **A Gmail account with an app password**, only if you want to send email and read replies from the dashboard

## Quick start
```bash
git clone <this repository> jobhunt-copilot
cd jobhunt-copilot
npm install
npm run build
cp .mcp.json.example .mcp.json         # tells Claude Code where the tools are
npx playwright install chromium        # once, for form filling
npm start -w @jobhunt/server           # prints a dashboard link; also starts the shared browser
```
1. Open the **Dashboard** link that prints (it contains a private token).
2. **Settings:** fill in *About you* and *What you are looking for*.
3. **CV** and **Facts:** enter your jobs, projects, education and skills, and the true statements about your work. Everything the assistant writes comes only from these.
4. **Vault:** create a passphrase and, if you want email, save a Gmail app password. The vault locks every time the dashboard restarts.
5. Open Claude Code **in this folder** and try:
   ```
   /add https://example.com/jobs/123 go
   ```
   Then look at **Needs you** in the dashboard.

The step-by-step guide, with every command and example, is in **[docs/USAGE.md](docs/USAGE.md)**.

## Commands at a glance
| Type | What it does |
|---|---|
| `/discover` | Search for jobs that fit your settings |
| `/scout [n]` | Judge companies from your company list |
| `/add <link>... [go]` | Add job links; `go` takes each as far as it can |
| `/tailor <id\|all>` | Build tailored CVs |
| `/cover <id>` | Write a cover letter |
| `/email <id\|all>` | Find a contact and draft the email |
| `/apply <id\|all> [refill] [consent]` | Fill an application form (never submits) |
| `/go <id>` | Tailor, then email or form, then stop for your review |
| `/profile [id] [save]` | Fill a site's candidate profile |
| `/gaps` | Draft answers for the gaps you asked about |
| `/reset-limit` | Reset today's application count |

## How it fits together
```
Claude Code ──(MCP, stdio)──> jobhunt MCP server ─┐
        │                                         ├─> SQLite database  (~/.jobhunt)
        └──> Playwright MCP ──> shared Chromium     │
                                                  │
Dashboard (127.0.0.1) <── HTTP server ─────────────┘
        └── Vault (encrypted: mail login, site passwords)
```
Packages: `core` (database, rules, checks), `mcp` (the assistant's tools), `server` (dashboard and background tasks), `render` (CV and letter PDFs), `vault` (encryption). The design and boundaries are in [DESIGN.md](DESIGN.md).

## Configuration
Data lives in `~/.jobhunt` by default. Useful environment variables:

| Variable | Meaning |
|---|---|
| `JOBHUNT_HOME` | Data folder (default `~/.jobhunt`) |
| `JOBHUNT_DB` | Database file (default `$JOBHUNT_HOME/jobhunt.db`) |
| `JOBHUNT_PORT` | Dashboard port (default 4317) |
| `JOBHUNT_BROWSER` | Path to a Chromium or Chrome to use |
| `JOBHUNT_BROWSER_PORT` | Control port of the shared browser (default 9222, this computer only) |
| `JOBHUNT_NO_BROWSER` | Do not start the shared browser with the dashboard |
| `JOBHUNT_NO_DRAFTER` | Turn off the dashboard's background Claude buttons |
| `JOBHUNT_CLAUDE` | Path to the `claude` command the dashboard should use |
| `JOBHUNT_MAIL_DRY_RUN` | Build emails but do not send them |

## Limitations
- Built on macOS. Linux should work for most parts; Windows is untested.
- The dashboard's background buttons (draft a gap answer, reword a bullet) start Claude Code headlessly and need it signed in. If its login expires, the card shows the reason.
- Form filling depends on each site's page and on the permission prompts of your Claude app. Some sites need a manual click.
- Reply matching for form applications is a suggestion for you to check, never automatic.
- Nothing here is legal, career or financial advice. You are responsible for what you send.

## Development
```bash
npm test          # builds, then runs all workspaces' tests
npm run browser   # start the shared browser by hand
```
Contributions are welcome. Read [DESIGN.md](DESIGN.md) first: the boundaries between what the assistant may do and what only a person may do are the point of the project, and changes that blur them will not be accepted.

## License
MIT. See [LICENSE](LICENSE).
