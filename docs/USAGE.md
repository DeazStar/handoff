# Using Handoff

This guide shows what to click and what to type, with examples. For what the project is and how to install it, see the [README](../README.md).

**Contents**
1. [The idea in two minutes](#1-the-idea-in-two-minutes)
2. [First-time setup](#2-first-time-setup)
3. [The daily loop](#3-the-daily-loop)
4. [Commands, one by one](#4-commands-one-by-one)
5. [Dashboard, page by page](#5-dashboard-page-by-page)
6. [Walkthroughs](#6-walkthroughs)
7. [Settings reference](#7-settings-reference)
8. [How the writing rules work](#8-how-the-writing-rules-work)
9. [Safety rules and permission words](#9-safety-rules-and-permission-words)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. The idea in two minutes

You use two windows side by side:
- **Claude Code**, opened in this project's folder. You type slash commands here. The assistant does the work.
- **The dashboard** (a web page on your own computer). You review, edit, approve, send and decide here.

Three ideas run through everything:

**Facts.** You write down true things about your work (*Facts*) and your jobs and projects (*CV*). Every CV, letter and email the assistant writes comes only from these, and each claim cites the facts behind it. If a job wants something your facts do not cover, you get a **gap** card. The assistant never invents one.

**The Needs-you queue.** Whenever the assistant reaches something only you can do (check a form, approve an email, make an account, answer a question, solve a CAPTCHA), it puts a card in **Needs you** and stops. You decide, then run the command again.

**Job states.** Each job moves along a fixed path. The assistant moves it forward as far as it may. You make the last steps.

```
found → verified_live → matched → materials_ready → awaiting_approval → applied → replied → interview → offer
                                                                           ↘ no_response / rejected
(any time: skipped, dead)
```
- `matched` means it was scored against your settings.
- `materials_ready` means the CV (and letter) exist.
- `awaiting_approval` means an email draft or a filled form is waiting for you.
- `applied` and beyond are set by you, or by the mailbox check when someone replies in your thread.
- You can send a `materials_ready` job back to `matched` (job page, **Move this job**) to have its materials made again.

---

## 2. First-time setup

Do these once, in this order. Each takes a few minutes.

### 2.1 Start everything
```bash
npm install && npm run build
cp .mcp.json.example .mcp.json
npx playwright install chromium
npm start -w @jobhunt/server
```
The last command prints:
```
Database: /Users/you/.jobhunt/jobhunt.db
Dashboard: http://127.0.0.1:4317/?token=...
Shared browser: started.
```
Open the **Dashboard** link. It carries a private token; keep it to yourself. Then open **Claude Code in this folder** (so it finds `.mcp.json` and `.claude/commands`).

### 2.2 Settings → About you
Name, email, phone, city and country, links (LinkedIn, GitHub, site), languages, **work authorization** and **Do you need a visa sponsored?**

Example: `Work authorization: Needs sponsorship`, *Requires sponsorship*: yes. The assistant uses this to answer form questions and to rank jobs.

### 2.3 Settings → What you are looking for
- **Roles:** `Backend Engineer`, `AI Engineer` (one per line or comma separated).
- **Levels:** open the drop-down and tick every level you would accept (intern, junior, mid, senior, lead, staff and above). A job at another level is flagged and ranked lower, not skipped.
- **Remote policy and remote scope:** fully remote, worldwide or open to you.
- **Salary range and period:** `1200 to 2500 USD per month`.
- **Exclusions:** words that rule a job out.

### 2.4 CV and Facts
This is the most important step. The CV page holds **entries**: each job, project and school, with dates and bullets. The Facts page holds free statements.

Good fact: *"Built a payments API serving 50000 users at Acme, 2022 to 2024."*
Bad fact: *"Worked on backend stuff."* (nothing to cite, nothing a number can match.)

For each job entry you can set a **weight**: *lead* (must be on every CV, first), *always* (must be on every CV) or *normal*. Set a country and employment type if you want the order rules to apply.

Skills go in groups (`Backend: Node.js, Python, Rust`), and a skill can carry a level: `Python:advanced`.

### 2.5 Vault (only if you want email)
**Vault → Create vault:** choose a passphrase of at least 12 characters. Then save your **Gmail app password** (the page explains how to make one). It is used to send the emails you approve and to read replies (read-only). The vault **locks every time the dashboard restarts**; unlock it on the Vault page when you need it.

### 2.6 Optional: the company list
**Companies → Collect Y Combinator companies** downloads a public list of YC companies that say they are hiring (one request, no AI). Then **Find all career pages** finds each company's careers link. See [Walkthrough E](#e-find-jobs-from-a-company-list).

---

## 3. The daily loop

1. **Find:** `/discover`, or `/scout 10`, or `/add <links>`.
2. **Take a job forward:** `/go <id>` (or `/tailor`, then `/email` or `/apply`).
3. **Review in the dashboard:** open **Needs you**; check the CV, letter and email or form.
4. **Send or submit it yourself:** the **Send** button on an email, or **Submit** on the site's own form. Then mark it done.
5. **Follow up:** open **Replies** (press **Check replies**), handle replies, draft follow-ups.

A good first day: do 2.2 to 2.4, then `/add` one real link with `go`, and walk through what lands in **Needs you**.

---

## 4. Commands, one by one

Type these in Claude Code. A number is a job id (shown on the job page and in the Pipeline). Examples are illustrative.

### `/discover`
Searches for jobs that fit your settings, on the sites you listed under **Settings → Sites to search**, and, if "Search any site" is on, on Google and company career pages. It opens each page, checks it is live, saves the posting text, scores it against your settings and records it. It stops when the **daily discovery limit** is reached.
- Type: `/discover`
- Result: a summary of jobs added (title, company, score) and ones skipped, and the budget left. The jobs appear in **Pipeline**.

### `/scout [n]`
Judges companies from your company list. It opens each company's career page, adds the openings that fit you, and marks the company **potential** (it has a fitting job) or **discarded** (with a reason).
- Type: `/scout 10` (empty means up to 5; capped by your batch size).
- If few companies have a career page yet, it finds more by itself (up to three rounds). If it still comes up short it tells you how many are ready and how many need career pages found.
- Result: one line per company with its verdict and the jobs added.

### `/add <link> [<link> ...] [go] [consent | consent all]`
Adds jobs from links you already have. They use their own daily allowance and are added even if they score low, with the weakness stated.
- Type: `/add https://jobs.acme.com/123 https://boards.example.com/456`
- With `go`: takes each added job as far as it can, one at a time, in priority order. Example: `/add https://jobs.acme.com/123 go`
- Result: a line per link (added, duplicate or dead) and, with `go`, where each job now stands.

### `/tailor [id | all]`
Builds a tailored CV PDF: a role headline, a three-sentence summary, the most relevant experience and projects, education and skills. Then it scores the CV against the posting's keywords.
- Type: `/tailor 12`, or `/tailor all` (every matched job without a CV, up to your batch size), or `/tailor` (the best one).
- Result: the document id, pages, **ATS score out of 100** with its four parts, keywords still missing, and **gaps** it reported. Look at the score on the job page.
- Re-running on a job saves a **new version**. Older ones are kept.

### `/cover <id>`
Writes the cover letter: three or four short paragraphs, 180 to 300 words. You rarely need this directly; `/email` and `/apply` write one when needed.
- Type: `/cover 12`

### `/email [id | all] [new letter]`
For jobs that apply by email. It finds a contact address that really appears on the company's page (or is read from the posting), checks the domain takes mail, then drafts the email, with your CV and cover letter attached. It **never sends**.
- Type: `/email 12`. Add `new letter` to rewrite the cover letter too; otherwise an existing one is kept.
- Result: a draft in **Emails** and a card in **Needs you**. If it cannot find a verified address it says so and you apply through the site.

### `/apply [id | all] [refill] [consent | consent all]`
For jobs that apply by form. It fills the form in the shared browser, uploads your CV, leaves the tab open and records every answer with its source. **It never presses Submit.**
- Type: `/apply 12`
- `refill`: the browser tab was lost; put the saved answers back without rewriting anything. Example: `/apply 12 refill`
- `consent`: tick the privacy/data-processing box the form requires, for this run only.
- `consent all`: tick every box needed to submit. It never ticks marketing or optional ones. See [section 9](#9-safety-rules-and-permission-words).
- Result: the filled form open in the browser, plus a card in **Needs you** listing what it left blank and why (a demographic question you have no saved answer for, a CAPTCHA, a personal story your facts do not cover).
- If the site needs an account or a profile first, it stops and gives you a card for that.

### `/go <id> [consent | consent all]`
The one-job shortcut. Looks at the job's state and does the next steps: tailor the CV if needed, write the letter, then draft the email or fill the form, and stop for your review.
- Type: `/go 12`, or `/go 12 consent`.
- A job in `found` or `verified_live` needs `/discover` first. A job already waiting for you is left alone and you are told where to look.

### `/profile [id] [save] [page address] [start at <section>]`
Fills a website's **candidate profile** (for example a job board's profile) from your profile, CV and facts. It covers every tab. It never types a password or your email.
- Type: `/profile 12 save` (the dashboard's **Fill in the profile** button copies this command for you).
- Without `save` it fills but does not press Save. With `save` it presses each section's Save or Next button, never an application or publish button.
- `start at Skills` begins at a section; `https://...` gives the page if none is open.

### `/gaps`
Runs the background requests you made from the dashboard (**Draft with Claude**, **Improve my wording**, number wording). Normally the dashboard starts this for you; use it by hand if the buttons say Claude cannot be started.
- Type: `/gaps`

### `/reset-limit`
Resets today's application count so more forms can be started. Only type it yourself; Claude is told never to run it on its own.

### Terminal commands
| Command | What it does |
|---|---|
| `npm start -w @jobhunt/server` | Start the dashboard (and the shared browser) |
| `npm run browser` | Start the shared browser by hand |
| `npm run reset-limit` | Reset today's application count |
| `npm run collect:yc` | Download the Y Combinator company list |
| `npm test` | Build and run the tests |

---

## 5. Dashboard, page by page

**Needs you** (the home page). A card for every decision waiting for you, in tabs:
- **Waiting for you:** a filled form to check (**Review the application**, **Browser closed? Refill the form**), an email draft to approve (**Review the draft**), a follow-up to decide.
- **Questions:** an answer only you can give (equity, skill level, a preference). Pick an option or type it, and it is saved for next time. Wording you told the assistant appears as a card showing what you said and how it is worded: **Save as worded**, or open it to use your exact words.
- **Gaps:** something a job wants that your facts do not cover. Type what you really did, choose *Something I did / A result I achieved / A skill I have*, pick the role it belongs under and save it for this job or for all jobs. Buttons: **Draft with Claude** (drafts from facts you already have), **Improve my wording** (rewords what you typed, adding nothing), **Draft all with Claude**, **Ask for numbers**, **Save all filled boxes**, **I don't have this**.
- **Sign-in:** an account to make or a profile to fill. **Make a password** (saves a random one in the vault, and shows **Copy password** and **Copy email**), **I created the account**, **Fill in the profile**, **It is filled in**.
- **Other:** anything else, such as a CAPTCHA to solve or a bounced address.

**Pipeline.** All jobs by state, sorted by priority (match score, plus a bonus for fully remote and for visa sponsorship, and a small penalty for a level mismatch). Open a job to see:
- the posting, link checks, contacts, people at the company;
- the **documents** (CV, cover letter, email) with the **ATS score** and the missing keywords;
- **Move this job** (skip, mark applied, send back to matched...);
- **Add a contact myself**, **Draft a follow-up** (for an applied email job).

**Tracker.** Every application that has gone out, including ones you record by hand (**Add an application I made myself**). Change a status, see days since you applied.

**Companies.** The company list. Buttons: **Collect Y Combinator companies**, **Find all career pages** (keeps going until done; **Stop** pauses it). Tabs: To review, Potential, Discarded. Filter by search text, fully remote, and career page status.

**Forms.** Filled forms waiting for you, with **Today: N of M applications used** and **Reset today's count**. Open one to see each answer, where it came from, anything flagged as *differs from its source*, and what was left blank. **I submitted it** after you press Submit on the site; **Discard** to start again.

**Emails.** Drafts and sent mail. Edit the text, see the attachments and warnings (an address on another domain, an address read in a browser), then **Send** or **Discard**. A sent email counts toward the daily limit.

**Replies.** Press **Check replies** (the mailbox is read-only; nothing is moved or deleted). Each reply shows how it matched: same thread (certain) or a *possible match* (check it). Buttons: **It is an interview**, **It is a rejection**, **Mark handled**, **Not a reply** or **Not about this job**.

**Accounts.** Sites where the tool saved a password for you, with **Copy email / Copy password** (the clipboard clears after 30 seconds), **Mark email verified**, **Forget** (it deletes the saved password with the account), and **Site profiles**, which lists sites whose candidate profile is complete (**Not finished** makes the assistant check again).

**CV.** Your entries and bullets; reorder them, set weights, edit, preview the CV PDF.

**Facts.** Free statements about your work, and **Ask me for numbers**, which turns bullets without a number into cards.

**Settings.** See [section 7](#7-settings-reference).

**Vault.** Create the vault, unlock it, lock it, save or remove the mail login.

---

## 6. Walkthroughs

### A. Add one link and take it all the way (email job)
1. Type `/add https://acme.example/jobs/42 go`.
2. Claude adds the job, checks it is live, scores it (say 7 of 10), builds the CV, writes the letter, finds `jobs@acme.example` on the company's page and drafts the email. It stops.
3. Open **Needs you**. Under *Waiting for you* there is an **approve email** card. Click **Review the draft**.
4. Read the email and the attachments. Edit if you like. Press **Send**. (The vault must be unlocked.)
5. The job becomes `applied`. Later, **Replies → Check replies** shows any answer.

### B. Apply through a form
1. `/go 12` (a form job). Claude fills the form in the shared browser window and stops.
2. In **Needs you** a **check and submit** card says, for example, *"8 answers entered, 3 left for you"*. Click **Review the application** to see each answer and its source, and the blanks.
3. Switch to the browser tab. Finish the blanks (an uploaded resume it could not attach, a demographic question). Press the site's **Submit** yourself.
4. Back in the dashboard click **I submitted it**.
5. Tab closed by accident? Type `/apply 12 refill`, or click **Browser closed? Refill the form**.

### C. A site wants an account or a profile first
- *Account:* a **Sign-in** card says "create an account". Click **Make a password**, which saves a random password in the vault. Use **Copy email** and **Copy password** to paste them into the site, solve any CAPTCHA, create the account, and click **I created the account**. Run the command again. Claude never sees the password.
- *Profile:* a card says "fill in the profile". Click **Fill in the profile** (it copies `/profile 12 save`), paste it into Claude Code, let it fill every tab, then click **It is filled in**. The site is remembered as complete and is not asked again.

### D. Fill in a gap
A tailoring run reports *Golang* as something the job wants and no fact mentions it.
1. **Needs you → Gaps**. The card shows the requirement and what you have that comes closest.
2. If you have done it, type it plainly in the box ("I wrote two small services in Go at Acme"), choose *Something I did*, pick the role, and click **Save for all my jobs**.
3. Not sure how to word it? Click **Improve my wording**; Claude rewrites your sentence without adding anything and you choose **Use this wording**.
4. Not true? **I don't have this**.
5. Run `/tailor <id>` again to use the new fact.

### E. Find jobs from a company list
1. **Companies → Collect Y Combinator companies.**
2. **Find all career pages.** It works through the list in batches of 40; **Stop** if you want.
3. `/scout 10`. Claude judges ten companies and adds the openings that fit.
4. Open **Pipeline**, then `/go <id>` for the ones you like.

### F. Make your numbers stronger
1. **Facts → Ask me for numbers** (or **Needs you → Gaps → Ask for numbers**).
2. A card shows a bullet with no number: *"Designed the authentication layer."*
3. Type only the number and what it counts: `about 12,000 customers`. Click **Let Claude word it**.
4. Read the new bullet, edit if you like, click **Save this bullet**. It is updated for every job. No number? **I don't know a number** (it never asks about that bullet again).

### G. Follow up and track
- **Replies → Check replies.** An answer in your thread moves the job to *replied* by itself (if that setting is on). Mail from a company's own address, or from a job platform that names the company and job, shows as a *possible match* for you to confirm.
- A job with no answer after N days gets a card: **Draft a follow-up**. It writes a short reminder in the same thread, and you send it.
- Applied by hand somewhere else? **Tracker → Add an application I made myself**.

### H. Redo a job after you changed your facts or rules
1. Job page → **Move this job → matched** (if it was `materials_ready` or `awaiting_approval`, discard the email draft or form first).
2. `/go <id>`. New versions of the CV, letter and email are made; the old ones stay as history.

---

## 7. Settings reference

| Section | What it controls |
|---|---|
| **About you** | Name, contact details, links, work authorization, whether you need sponsorship, notice period. |
| **What you are looking for** | Roles, levels, locations, remote policy and scope, industries, exclusions, salary range and unit, how to rank (remote first or sponsorship first), country and employment-type priority for the CV, a default skill level, how you want CVs built. |
| **Research and batches** | The minimum score before the assistant researches people at a company, how many items a run handles. |
| **When Claude needs an answer only I can give** | *Batch* (fill everything possible, then ask all at the end), *chat* (ask right away), *cards* (only as cards). You can override the mode per kind of question, or turn asking off. |
| **Writing** | **How everything written for me should sound** (your own words come first), and how cover letters should read. Cover letters: automatic for email jobs and for forms that ask, or off. |
| **Form behaviour** | Cookie banners (accept all or only necessary), and the default for consent boxes (none, privacy only, or all needed to submit). |
| **Replies and follow-ups** | Move a job to replied on a direct reply, follow-up after N days, how many follow-ups, mark *no response* after N days, how long to keep message text, check the mailbox every N minutes (0 means only when you press the button). |
| **Daily limits** | Jobs added per day by search, applications per day, and **Reset today's count**. |
| **Sites to search** | Job sites, career pages and contacts the assistant may use. |
| **Standard answers** | Answers you saved to repeat (*Are you willing to relocate? Yes*). Demographic questions are answered only from here. |

---

## 8. How the writing rules work

Everything written in your name follows guides in `.claude/writing/` and `.claude/writing-guide.md`:
- **A short message** (to a founder, in a form box): `.claude/writing-guide.md`. A model message is quoted at the top.
- **The CV headline and summary:** `.claude/writing/cv-summary.md`. Three sentences: who you are, your years and stack; your strengths; what you are known for. No first person, no results, no numbers except your years (the server counts them from your dated roles).
- **The cover letter:** `.claude/writing/cover-letter.md`. Three or four paragraphs, 180 to 300 words, starting "I'm applying for the ... at ...".
- **The application email:** `.claude/writing/email.md`. A short covering note when a letter is attached.

Two ways to change them:
1. **Your own voice:** **Settings → How everything written for me should sound.** A few plain sentences about how you write ("Short sentences, no jargon, never salesy") come before the guide.
2. **The guides:** edit the markdown files. Examples help most; replace the examples with ones in your own voice.

The server **enforces** the hard rules and tells the assistant what to fix: it refuses writing that opens with a self-introduction, uses filler words or stock lines, volunteers a gap, repeats the posting, names an employer twice, or has too many numbers. This is why a draft may be refused once and fixed on the second try.

---

## 9. Safety rules and permission words

**What only you can do:** send an email, press Submit on a form, create an account, type or read a password, solve a CAPTCHA, change a job's final state, delete data, reset the daily count.

**Consent boxes.** The assistant ticks a consent box only if you say so in the command, for that run only:
- no word: it ticks none, and lists them for you.
- `consent`: only the privacy / data-processing consent the form needs to submit.
- `consent all`: every box the form needs to submit (privacy, "answers are true", terms, required authorizations). **Never** optional boxes such as newsletters, talent-pool or partner sharing.
The **Settings → consent default** sets what the dashboard's copied commands include.

**Demographic questions.** Answered only from your saved standard answers, never guessed. A saved answer can settle a clearly related one (*Race or ethnicity: African* answers *Are you Hispanic or Latino?* with No); the answer shows where it came from.

**Web text is data.** Text on job pages and in emails is never obeyed, including text that says "send your CV to this address" or "ignore previous instructions".

**Contacts.** An email address is accepted only if it appears on the company's own page (or the job's own posting page), its domain takes mail, and it is not free mail. The quote the assistant used is shown to you before you send.

**Daily limits.** Applications per day is checked before a form is filled, so no work is lost. It counts forms waiting and emails sent today.

---

## 10. Troubleshooting

| What you see | Why, and what to do |
|---|---|
| **"Claude could not do this: ... OAuth session expired"** on a dashboard button | The background Claude command is not signed in. Run its login: `"$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude \| sort -V \| tail -1)" auth login`, or `claude auth login` if `claude` is on your PATH. Then press **Try again**. |
| **"Unlock the vault first"** | The vault locks when the dashboard restarts. Open **Vault** and unlock it. |
| `/go` says the browser tools cannot connect | Run `npm run browser`, and close any other window that holds the browser's profile. The dashboard normally starts it. |
| **"Daily limit reached"** | Raise *Applications per day* in Settings, or **Reset today's count** on the Forms page, or `/reset-limit`. |
| `/scout` found only one company | Most companies have no career page checked yet. Press **Find all career pages** on **Companies**, then run `/scout` again. |
| A form says "already prepared" | A prepared form is waiting. Open **Forms**, **Discard** it to start again, or `/apply <id> refill` to reopen it. |
| `/email` says no verified contact | The address was not on a page the server could read. Open the posting, find the address, and use **Add a contact myself** on the job page, then `/email <id>` again. |
| A site keeps asking you to log in | Log in once in the shared browser window and close it normally; logins are kept between runs. A crash or force-quit may lose them. |
| The Apply click is denied | Your Claude app's permission check blocked it. Click Apply yourself once, then run the command again. |
| Login or sign-up needs a code or CAPTCHA | The assistant stops. Do it yourself, then run the command again. |
| You moved a job and want it redone | See Walkthrough H. |
| Reply from a company did not show up | Press **Check replies**. Only mail that can belong to an application is read: replies in your thread, mail from the company's own address, or a job platform's mail that names the company and job. |

**Where is my data?** `~/.jobhunt` (the database, generated PDFs in `documents/`, and the shared browser's profile). Delete that folder to start from nothing. To keep a backup, copy `jobhunt.db`.
