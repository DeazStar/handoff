"use strict";
// All data shown here can come from the internet (job titles, descriptions, URLs).
// Elements are built with textContent only, never innerHTML, so page text cannot run as script.

const view = document.getElementById("view");
const nav = document.getElementById("nav");

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    // The page policy forbids inline style attributes, so styles go through the style object.
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : undefined);

// A thin bar at the top of the screen shows while anything is loading or saving. It waits a moment so quick calls do not flash it.
const bar = document.getElementById("progress");
let inflight = 0;
let barTimer = null;
const busyStart = () => {
  inflight++;
  if (inflight === 1) barTimer = setTimeout(() => bar.classList.add("on"), 120);
};
const busyEnd = () => {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) { clearTimeout(barTimer); barTimer = null; bar.classList.remove("on"); }
};

async function api(method, path, body) {
  busyStart();
  try {
    const res = await fetch(path, {
      method,
      // The server accepts only JSON on anything that changes data, so a POST with nothing to say still sends {}.
      headers: method === "GET" && body === undefined ? {} : { "content-type": "application/json" },
      body: method === "GET" && body === undefined ? undefined : JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } finally {
    busyEnd();
  }
}

// Messages sit in the corner of the screen, so they are seen on every page and survive moving between pages.
// A success goes away by itself; an error stays until it is dismissed, and can be copied.
const toastBox = document.getElementById("toasts");
let toastCount = 0;
function toast(kind, text, ms) {
  toastCount++;
  const message = String(text);
  const el = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" },
    h("span", { class: "icon", "aria-hidden": "true" }, kind === "ok" ? "✓" : kind === "error" ? "!" : "i"),
    h("div", { class: "msg" }, message),
    kind === "error" ? h("button", { onclick: () => { navigator.clipboard.writeText(message).then(() => toast("info", "Copied", 1500), () => {}); } }, "Copy") : null,
    h("button", { class: "close", "aria-label": "Dismiss", onclick: () => el.remove() }, "×"));
  toastBox.append(el);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  const life = kind === "error" ? 0 : ms ?? Math.min(12000, 3500 + message.length * 40);
  if (life) setTimeout(() => el.remove(), life);
  return el;
}
const showNote = (text) => toast("ok", text);
const showError = (e) => toast("error", String(e && e.message ? e.message : e));

/**
 * The handler for a button that changes something: the button shows a spinner and cannot be pressed twice, the page refreshes
 * afterwards, and the user always gets a message ("Done" unless the action said something more useful itself).
 */
const act = (fn, okText) => async (ev) => {
  const btn = ev && ev.currentTarget && ev.currentTarget.tagName === "BUTTON" ? ev.currentTarget : null;
  if (btn && btn.disabled) return;
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  const before = toastCount;
  try {
    await fn();
    await render();
    if (toastCount === before) toast("ok", okText || "Done");
  } catch (e) {
    showError(e);
  } finally {
    if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
  }
};

/** A button for something that cannot be undone: the first click asks, the second does it. */
function confirmButton(text, confirmText, run, cls = "danger") {
  let armed = false;
  let timer;
  const btn = h("button", { class: cls, onclick: async (ev) => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmText;
      timer = setTimeout(() => { armed = false; btn.textContent = text; }, 6000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.textContent = text;
    await act(run)(ev);
  } }, text);
  return btn;
}

/** One tab bar for every page: the label, a count, and the one that is open. `items` are { id, text, count, cls }. */
function tabBar(items, active, choose) {
  return h("div", { class: "tabs", role: "tablist" }, items.map((t) =>
    h("button", { class: `tab ${t.cls || ""}${t.id === active ? " on" : ""}`, role: "tab", "aria-selected": t.id === active ? "true" : "false", onclick: () => choose(t.id) },
      t.text, h("span", { class: `count${t.count ? "" : " zero"}` }, String(t.count ?? 0)))));
}

/** A page's title with a short line under it and, on the right, the actions that belong to the whole page. */
function pageHead(title, sub, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "muted" }, sub) : null), actions.length ? h("div", { class: "row" }, actions) : null);
}

const label = (s) => s.replaceAll("_", " ");


/** What the agent may tick on a form in one run. The same choice wherever a command is copied. */
function consentSelect() {
  const sel = h("select", { title: "What the agent may tick on the form for this run only. It never ticks optional boxes such as marketing." },
    [["none", "tick no consent boxes"], ["privacy", "tick the privacy consent only"], ["required", "tick all boxes needed to submit"]].map(([v, t]) => h("option", { value: v }, t)));
  sel.value = (currentPrefs && currentPrefs.consentDefault) || "none";
  return sel;
}
const consentWord = (sel) => (sel.value === "none" ? "" : sel.value === "privacy" ? " consent" : " consent all");

/** The filled form lives only in the browser tab. If that was closed, this copies the command that puts the saved answers back. */
function refillBox(jobId) {
  const consent = consentSelect();
  return h("div", { class: "row" },
    h("button", { onclick: async () => {
      const cmd = `/apply ${jobId} refill${consentWord(consent)}`;
      try { await navigator.clipboard.writeText(cmd); showNote(`Copied ${cmd}. Paste it into your Claude session. It opens the form and puts your saved answers back, without writing anything again.`); }
      catch { showNote(`Copy this and paste it into your Claude session: ${cmd}`); }
    } }, "Browser closed? Refill the form"), consent);
}

/** One click gets the right command onto the clipboard. A web page cannot start a Claude session itself. */
function goButton(job) {
  if (job.state !== "matched" && job.state !== "materials_ready") return null;
  const next = job.state === "matched"
    ? "tailor the CV, then draft the email or fill the form"
    : job.route === "email" ? "draft the email" : job.route === "form" ? "fill the form" : "nothing more to do";
  const forForm = job.route !== "email";
  const consent = consentSelect();
  const btn = h("button", { class: "primary", title: "Copies the command to paste into Claude", onclick: async () => {
    const word = forForm ? consentWord(consent) : "";
    const cmd = `/go ${job.id}${word}`;
    try {
      await navigator.clipboard.writeText(cmd);
      showNote(`Copied ${cmd}. Paste it into your Claude session and press Enter. It will ${next}, then stop for your review.`);
    } catch {
      showNote(`Copy this and paste it into your Claude session: ${cmd}`);
    }
  } }, "Apply");
  return h("span", { class: "row" }, btn, h("span", { class: "muted" }, `next: ${next}`), forForm && consent);
}

// ---------- views ----------

const QUEUE_TABS = [
  { id: "waiting", text: "Waiting for you", empty: "Nothing is waiting for your check. Forms to submit and emails to send show here." },
  { id: "questions", text: "Questions", empty: "No questions. When Claude needs an answer only you can give, it shows here." },
  { id: "gaps", text: "Gaps", empty: "No gaps. Skills a job asks for that your facts do not cover show here." },
  { id: "signin", text: "Sign-in", empty: "No accounts to make and nothing to verify." },
  { id: "other", text: "Other", empty: "Nothing else is waiting." },
];
const queueBucket = (a) =>
  a.kind === "confirm_submit" || a.kind === "approve_email" ? "waiting"
  : a.kind === "sensitive_question" ? "questions"
  : a.kind === "gap" ? "gaps"
  : a.kind === "signup_needed" ? "signin" : "other";

async function queueView() {
  const items = await api("GET", "/api/actions");
  const by = (id) => items.filter((a) => queueBucket(a) === id);
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  // It opens on the first tab that has something, unless the user chose one.
  const active = QUEUE_TABS.some((t) => t.id === params.get("t")) ? params.get("t") : (QUEUE_TABS.find((t) => by(t.id).length) || QUEUE_TABS[0]).id;
  view.replaceChildren(pageHead(`Needs you (${items.length})`, items.length ? "Everything Claude is waiting on you for, sorted by what it is." : "Nothing is waiting. Claude has no open questions."));
  if (!items.length) { view.append(h("div", { class: "empty" }, "All clear.")); return 0; }
  view.append(tabBar(QUEUE_TABS.map((t) => ({ id: t.id, text: t.text, count: by(t.id).length })), active, (id) => { location.hash = `#/?t=${id}`; }));
  const list = by(active);
  if (!list.length) { view.append(h("div", { class: "empty" }, QUEUE_TABS.find((t) => t.id === active).empty)); return items.length; }

  if (active === "questions") {
    const proposals = list.filter((a) => a.payload && a.payload.proposal);
    if (proposals.length > 1) {
      view.append(h("div", { class: "card" }, h("div", { class: "row" },
        h("strong", { class: "grow" }, `${proposals.length} things you told Claude are ready to be saved`),
        h("button", { class: "primary", onclick: act(async () => { for (const a of proposals) await api("POST", `/api/proposals/${a.id}/accept`, { use: "polished" }); showNote("Saved."); }) }, `Save all ${proposals.length} as worded`)),
        h("div", { class: "hint" }, "Each card shows what you said and how it is worded. Open a card to use your exact words instead.")));
    }
    list.forEach((a) => view.append(actionCard(a)));
  } else if (active === "gaps") {
    await gapList(list);
  } else {
    list.forEach((a) => view.append(actionCard(a)));
  }
  return items.length;
}

function jobLink(a) {
  return a.jobId ? h("a", { href: `#/jobs/${a.jobId}` }, a.jobTitle || `Job ${a.jobId}`) : h("span", { class: "muted" }, "no job");
}

// Something the user told Claude in chat. It was already used; this keeps it for next time, after one click.
function rememberCard(a) {
  const p = a.payload.proposal;
  const text = h("textarea", {});
  text.value = p.polished;
  const accept = (body) => async () => {
    try { await api("POST", `/api/proposals/${a.id}/accept`, body); showNote(p.type === "answer" ? "Saved under Standard answers." : "Saved as a fact."); await render(); } catch (e) { showError(e); }
  };
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, p.type === "answer" ? "keep this answer?" : "keep this fact?"), a.jobId ? jobLink(a) : null),
    p.type === "answer" ? h("p", {}, h("strong", {}, p.label)) : h("div", { class: "muted" }, `As a ${p.kind} fact${p.entryId ? ` under role ${p.entryId}` : ""}`),
    h("div", { class: "muted" }, "You said:"), h("div", { class: "pre" }, p.original),
    h("div", { class: "muted mt-sm" }, "Saved as (you can edit it):"), text,
    h("div", { class: "row mt" },
      h("button", { class: "primary", onclick: () => accept({ use: "text", text: text.value })() }, "Save"),
      h("button", { onclick: accept({ use: "original" }) }, "Save my exact words"),
      h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Not this")));
}

// A question only the user can answer. The answer is saved once as a standard answer, so it is never asked again.
function questionCard(a) {
  const q = a.payload;
  const save = async (answer) => {
    if (!String(answer).trim()) { showError(new Error("Choose or write an answer first")); return; }
    try {
      await api("PUT", "/api/standard-answers", { label: q.question, answer: String(answer) });
      await api("POST", `/api/actions/${a.id}/resolve`, { status: "done" });
      showNote("Saved. Claude will use it from now on. Run the command again to carry on.");
      await render();
    } catch (e) { showError(e); }
  };
  const free = h("input", { placeholder: "Your answer", class: "grow grow-min" });
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, "a question for you"), a.jobId ? jobLink(a) : null, q.site ? h("span", { class: "muted" }, q.site) : null),
    h("p", {}, q.question),
    q.options && q.options.length
      ? h("div", { class: "row" }, q.options.map((o) => h("button", { class: "primary", onclick: () => save(o) }, o)))
      : h("div", { class: "row" }, free, h("button", { class: "primary", onclick: () => save(free.value) }, "Save my answer")),
    h("div", { class: "muted" }, "Your answer is saved once under Standard answers, and used every time a site asks this."),
    h("div", { class: "row mt" }, h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
}

// Claude cannot be started from a button, so this copies the command for the user's Claude session, like the Apply button.
function profileCommandBox(jobId) {
  const save = h("input", { type: "checkbox" });
  save.checked = true;
  const button = h("button", { class: "primary", onclick: async () => {
    const cmd = `/profile${jobId ? " " + jobId : ""}${save.checked ? " save" : ""}`;
    try { await navigator.clipboard.writeText(cmd); showNote(`Copied ${cmd}. Paste it into your Claude session and press Enter. It goes through every tab of the profile.`); }
    catch { showNote(`Copy this and paste it into your Claude session: ${cmd}`); }
  } }, "Fill in the profile");
  return h("div", { class: "row mt" }, button, h("label", {}, save, " also save each section"));
}

function profileCard(a, p) {
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, "fill in the profile"), a.jobId ? jobLink(a) : null, h("strong", {}, p.site),
      safeHref(p.applyUrl) ? h("a", { href: safeHref(p.applyUrl), target: "_blank", rel: "noopener noreferrer" }, "the page") : null),
    h("div", { class: "muted" }, p.note || "This site has a profile to fill in. Claude fills it from your profile, CV and facts, tab by tab, and leaves the email and password boxes."),
    profileCommandBox(a.jobId),
    h("div", { class: "row mt" },
      h("button", { class: "primary", onclick: act(async () => { await api("POST", "/api/site-profiles", { site: p.site, complete: true }); showNote(`Marked the profile on ${p.site} as complete. Claude will not ask for it again.`); }) }, "It is filled in"),
      h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
}

// A site sent a mail to check the address. The link is untrusted: the page shows where it goes, and only the user opens it.
function verifyCard(a, p) {
  const link = /^https:\/\//i.test(p.link || "") ? p.link : undefined;
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, "verify your email"), a.jobId ? jobLink(a) : null, h("strong", {}, p.site)),
    h("div", { class: "muted" }, `The site sent: "${p.subject}" from ${p.from}.`),
    link ? h("div", { class: p.linkRelated ? "muted" : "warn" }, p.linkRelated
      ? `The link goes to ${p.linkHost}, which is part of ${p.site}.`
      : `Careful: the link goes to ${p.linkHost}, which is not ${p.site}. Mail services often route links through their own address, but check the sender and the address before you click.`)
      : h("div", { class: "muted" }, "I could not pick out the link. Open the email in your mailbox and click it there."),
    h("div", { class: "row mt" },
      link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Open the link") : null,
      h("button", { class: "primary", onclick: act(() => api("POST", `/api/verifications/${p.verificationId}/used`, {})) }, "I verified it"),
      h("button", { onclick: act(() => api("POST", `/api/verifications/${p.verificationId}/ignore`, {})) }, "This is not it")));
}

// The password is made and copied by the server. It is never shown here and never sent to Claude.
/** The vault locks whenever the dashboard restarts. When that is why something failed, take the user to the page that unlocks it. */
function sendToVault(e) {
  if (/vault/i.test(String((e && e.message) || e)) && /unlock|locked/i.test(String((e && e.message) || e))) setTimeout(() => { location.hash = "#/vault"; }, 1200);
}

function signupCard(a) {
  const p = a.payload;
  const card = h("div", { class: "card" });
  if (p.mode === "verify") return verifyCard(a, p);
  if (p.mode === "profile") return profileCard(a, p);
  const draw = async () => {
    const [accounts, profile] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/profile")]);
    // The account the user already has for this site: the one they confirmed, else the oldest (the list is newest first).
    const matches = accounts.filter((x) => x.site === p.site);
    const mine = matches.find((x) => x.confirmedAt) || matches[matches.length - 1];
    const login = p.mode === "login" || (mine && mine.confirmedAt);
    const copy = (id, what) => h("button", { onclick: async () => { try { const r = await api("POST", `/api/accounts/${id}/copy`, { what }); showNote(what === "password" ? `Password copied. It leaves the clipboard in ${r.clearsInSeconds} seconds.` : "Copied."); } catch (e) { showError(e); sendToVault(e); } } }, what === "password" ? "Copy password" : (p.username ? "Copy username" : "Copy email"));
    const rules = p.passwordRules ? [p.passwordRules.minLength && `at least ${p.passwordRules.minLength} characters`, p.passwordRules.maxLength && `at most ${p.passwordRules.maxLength}`, p.passwordRules.symbols === false && "no special characters"].filter(Boolean).join(", ") : "";
    const rows = [
      h("div", { class: "row" }, h("span", { class: "badge" }, login ? "log in" : "create an account"), a.jobId ? jobLink(a) : null, h("strong", {}, p.site),
        safeHref(p.applyUrl) ? h("a", { href: safeHref(p.applyUrl), target: "_blank", rel: "noopener noreferrer" }, "the page") : null),
      h("div", { class: "muted" }, login ? "Claude found the login page. It cannot type the password: you do." : "Claude stops here: it never creates accounts and never sees a password. You make it, then run the job again."),
      p.fields && p.fields.length ? h("div", { class: "muted" }, `The page asks for: ${p.fields.join(", ")}`) : null,
      rules ? h("div", { class: "muted" }, `Password rules on that page: ${rules}`) : null,
    ];
    if (!mine) {
      rows.push(h("div", { class: "row mt" },
        h("button", { class: "primary", onclick: quiet(async () => {
          try { await api("POST", "/api/accounts/start", { site: p.site, pageUrl: p.applyUrl, passwordRules: p.passwordRules, jobId: a.jobId || undefined, username: p.username || undefined }); await draw(); } catch (e) { sendToVault(e); throw e; }
        }) }, "Make a password"),
        h("span", { class: "muted" }, `A random 20-character password is saved in your vault for ${p.site}. The account ${p.username ? "username is " + p.username : "email is " + (profile && profile.email ? profile.email : "(set your email in the profile)")}.`)));
    } else {
      rows.push(h("div", { class: "row mt" }, copy(mine.id, "username"), copy(mine.id, "password"),
        h("span", { class: "muted" }, "Paste each into the form yourself, tick the terms, solve any CAPTCHA, and press the site's own button.")));
      rows.push(h("div", { class: "row mt" },
        h("button", { class: "primary", onclick: act(async () => { if (login) await api("POST", `/api/actions/${a.id}/resolve`, { status: "done" }); else { await api("POST", `/api/accounts/${mine.id}/confirm`, {}); showNote("Recorded. If the site has a profile to fill in, use Fill in the profile on the Accounts page."); } }) }, login ? "I am logged in" : "I created the account"),
        h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
    }
    if (!mine) rows.push(h("div", { class: "row" }, h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
    card.replaceChildren(...rows.filter(Boolean));
  };
  card.append(h("div", { class: "muted" }, "Loading..."));
  draw().catch((e) => card.replaceChildren(h("div", { class: "error" }, String(e.message || e))));
  return card;
}

function actionCard(a) {
  if (a.kind === "confirm_submit" && a.jobId) {
    return h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, "check and submit"), jobLink(a)),
      h("div", { class: "muted" }, `${a.payload.answers || 0} answers entered, ${a.payload.leftBlank || 0} left for you`),
      h("div", { class: "row mt" }, h("a", { href: `#/applications/${a.jobId}` }, "Review the application")),
      h("div", { class: "mt" }, refillBox(a.jobId)));
  }
  if (a.kind === "approve_email" && a.payload && a.payload.emailId) {
    return h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, "approve email"), jobLink(a)),
      h("div", { class: "muted" }, `To: ${a.payload.to}`),
      h("div", { class: "muted" }, `Subject: ${a.payload.subject}`),
      h("div", { class: "row mt" }, h("a", { href: `#/emails/${a.payload.emailId}` }, "Review the draft")));
  }
  if (a.kind === "sensitive_question" && a.payload && a.payload.proposal) return rememberCard(a);
  if (a.kind === "sensitive_question" && a.payload && a.payload.question) return questionCard(a);
  if (a.kind === "signup_needed" && a.payload && a.payload.site) return signupCard(a);
  if (a.kind === "follow_up" && a.jobId) {
    const why = (a.payload || {}).reason;
    const dismiss = h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss");
    if (why === "no_reply") {
      return h("div", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "badge" }, "no reply yet"), jobLink(a)),
        h("div", { class: "muted" }, `Your email went out ${a.payload.days} days ago and nobody has answered.`),
        h("div", { class: "row mt" },
          h("button", { class: "primary", onclick: async () => { try { const r = await api("POST", `/api/jobs/${a.jobId}/follow-up`, {}); location.hash = `#/emails/${r.emailId}`; } catch (e) { showError(e); } } }, "Draft a follow-up"), dismiss));
    }
    if (why === "bounce") {
      return h("div", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "badge gap" }, "email bounced"), jobLink(a)),
        h("div", { class: "muted" }, `Your email to ${a.payload.to} was not delivered. Find another contact for this company.`),
        h("div", { class: "row mt" }, h("a", { href: `#/jobs/${a.jobId}` }, "Open the job"), dismiss));
    }
    return h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, "check the portal"), jobLink(a)),
      h("div", { class: "muted" }, `You applied ${a.payload.days} days ago${a.payload.byHand ? " by hand" : " through a form"} and nothing has come back. Look at the company's site or your email for news.`),
      h("div", { class: "row mt" }, dismiss));
  }
  const details = Object.entries(a.payload || {}).map(([k, v]) =>
    h("div", { class: "muted" }, `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, label(a.kind)), jobLink(a)),
    details,
    h("div", { class: "row mt" },
      h("button", { class: "primary", onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "done" })) }, "Done"),
      h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
}

const GAP_KINDS = [["experience", "Something I did"], ["achievement", "A result I achieved"], ["skill", "A skill I have"]];

/**
 * A gap is something a job or form asks for that the facts do not cover. The card says exactly what, and has a box to say what the
 * user really did. Nothing is saved until they click, and it is saved as their own fact (this job only, or for every job).
 * `registry` lets the page save every filled box at once.
 */
/**
 * A bullet with no number. The user types the number and what it counts; Claude rewords the bullet to carry it (grammar included);
 * the user reads the result and saves it. The fact is updated for every job.
 */
function metricCard(a, g) {
  const bullet = (g.suggestedFact && g.suggestedFact.text) || "";
  const numbers = h("input", { class: "grow", placeholder: "The number and what it counts, e.g. 12,000 patients, about 40% faster, 6 services" });
  const panel = h("div", {});
  const clear = () => api("POST", "/api/gap-polish/clear", { actionId: a.id });
  const save = (box) => quiet(async () => {
    if (!/\d/.test(box.value)) throw new Error("The bullet needs the number in it");
    await api("POST", `/api/actions/${a.id}/confirm-metric`, { text: box.value });
    toast("ok", "Saved on the bullet for every job");
    await render();
  });
  const addBtn = h("button", { class: "primary", onclick: quiet(async () => {
    if (!/\d/.test(numbers.value)) throw new Error("Type the number first, for example 12,000 patients or 40% faster");
    await api("POST", "/api/metric-polish", { actionId: a.id, numbers: numbers.value });
    card.dataset.state = ""; show({ status: "requested", original: bullet, numbers: numbers.value }); pollDrafts();
  }) }, "Let Claude word it");
  const mine = h("button", { onclick: () => {
    const box = h("textarea", { class: "tall-sm" }); box.value = bullet;
    panel.replaceChildren(h("div", { class: "field" }, h("label", {}, "The bullet, written by you with the number in it"), box),
      h("div", { class: "row mt" }, h("button", { class: "primary", onclick: save(box) }, "Save this bullet"), h("button", { onclick: () => show(null) }, "Cancel")));
  } }, "Write the bullet myself");
  /** Shows where the rewording stands: nothing yet, Claude working, or Claude's bullet to check and save. */
  const show = (p, run) => {
    addBtn.disabled = Boolean(p && p.status === "requested" && (!run || run.running));
    if (!p) { panel.replaceChildren(); return; }
    if (p.status === "requested") {
      const r = run || { running: true };
      const cancel = h("button", { onclick: quiet(() => clear().then(() => show(null)), "Request cancelled") }, "Cancel");
      if (r.running) {
        panel.replaceChildren(h("div", { class: "drafting", role: "status" }, h("span", { class: "spin" }),
          h("div", { class: "grow" }, h("strong", {}, "Claude is wording this bullet with your number…"), h("div", { class: "hint" }, "Usually under a minute. Leave this page open: the bullet appears here by itself.")), cancel));
      } else {
        const why = r.error ? `Claude could not do this: ${r.error}` : r.available === false ? "Claude cannot be started from the dashboard here. Run /gaps in a Claude session, or write the bullet yourself." : "Claude finished without wording this one.";
        panel.replaceChildren(h("div", { class: "drafting" }, h("div", { class: "grow" }, h("strong", {}, why)), cancel));
      }
      return;
    }
    const box = h("textarea", { class: "tall-sm" }); box.value = p.polished || "";
    panel.replaceChildren(h("div", { class: "polished" },
      h("div", { class: "hint" }, "Claude's bullet with your number. Edit it if you like, then save:"), box,
      p.note ? h("div", { class: "hint" }, p.note) : null,
      h("div", { class: "row mt" }, h("button", { class: "primary", onclick: save(box) }, "Save this bullet"), h("button", { onclick: quiet(() => clear().then(() => show(null))) }, "Try again"))));
  };
  const card = h("div", { class: "card warn-card", "data-gap": String(a.id) },
    h("div", { class: "row" }, h("span", { class: "badge gap" }, "needs a number"), h("span", { class: "muted" }, g.detail ? g.detail.split(".")[0] : "")),
    h("h2", { class: "mt-sm" }, "Add a real number to this bullet"),
    h("div", { class: "hint" }, "Recruiters and ATS read a number as proof. Only a number you can stand behind in an interview. You type the number; Claude words the sentence."),
    h("div", { class: "card inner" }, bullet),
    h("div", { class: "field mt" }, h("label", {}, "Your number"), h("div", { class: "row" }, numbers, addBtn)),
    panel,
    h("div", { class: "row mt" }, mine,
      confirmButton("I don't know a number", "Click again: stop asking about this bullet", () => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" }))));
  card.applyDraft = (latest, run) => show((latest.payload || {}).polish, run);
  show(g.polish);
  if (g.polish && g.polish.status === "requested") pollDrafts();
  return card;
}

function gapCard(a, ctx = {}, registry = []) {
  const g = a.payload || {};
  if (g.metric) return metricCard(a, g);
  const draft = g.suggestedFact || {};
  const text = h("textarea", { class: "tall-sm", placeholder: "Say it in your own words, with real numbers if you have them. Only what is true: it is saved as your fact, and Claude will never add to it." });
  text.value = draft.text || "";
  const kind = h("select", {}, GAP_KINDS.map(([v, t]) => h("option", { value: v }, t)));
  kind.value = draft.kind || "experience";
  const role = h("select", {}, h("option", { value: "" }, "Not tied to a role"), (ctx.entries || []).map((e) => h("option", { value: String(e.id) }, `${e.title}${e.organization ? `, ${e.organization}` : ""}`)));
  const closest = (g.closestFactIds || []).map((id) => ctx.facts && ctx.facts.get(id)).filter(Boolean);
  const save = async (scope) => {
    if (!text.value.trim()) throw new Error("Write what you did first");
    await api("POST", `/api/actions/${a.id}/confirm-gap`, { scope, fact: { kind: kind.value, text: text.value, dateRange: draft.dateRange, entryId: role.value ? Number(role.value) : undefined } });
  };
  const panel = h("div", {});
  const polishPanel = h("div", {});
  const polishBtn = h("button", { title: "Claude rewords what you wrote so it reads better, without adding anything", onclick: quiet(async () => {
    if (!text.value.trim()) throw new Error("Write what you did first, then Claude can improve the wording");
    await api("POST", "/api/gap-polish", { actionId: a.id, text: text.value });
    card.dataset.state = ""; showPolish({ status: "requested", original: text.value }); pollDrafts();
  }) }, "Improve my wording");
  /** Shows the polish request: spinner while Claude works, then its wording to accept or decline. */
  const showPolish = (p, run) => {
    polishBtn.disabled = Boolean(p && p.status === "requested" && (!run || run.running));
    if (!p) { polishPanel.replaceChildren(); return; }
    const clear = () => api("POST", "/api/gap-polish/clear", { actionId: a.id });
    if (p.status === "requested") {
      const r = run || { running: true };
      const keep = h("button", { onclick: quiet(() => clear().then(() => showPolish(null)), "Request cancelled") }, "Cancel");
      if (r.running) {
        polishPanel.replaceChildren(h("div", { class: "drafting", role: "status" }, h("span", { class: "spin" }),
          h("div", { class: "grow" }, h("strong", {}, "Claude is improving your wording…"), h("div", { class: "hint" }, "Usually under a minute. Your text stays in the box meanwhile.")), keep));
      } else {
        const why = r.error ? `Claude could not do this: ${r.error}` : r.available === false ? "Claude cannot be started from the dashboard here. Run /gaps in a Claude session." : "Claude finished without improving this one.";
        polishPanel.replaceChildren(h("div", { class: "drafting" }, h("div", { class: "grow" }, h("strong", {}, why)), keep));
      }
      return;
    }
    polishPanel.replaceChildren(h("div", { class: "polished" },
      h("div", { class: "hint" }, "Claude's wording of what you wrote (nothing added):"),
      h("div", { class: "polished-text" }, p.polished),
      p.note ? h("div", { class: "hint" }, p.note) : null,
      h("div", { class: "row mt" },
        h("button", { class: "primary", onclick: quiet(() => clear().then(() => { text.value = p.polished; showPolish(null); }), "Using Claude's wording") }, "Use this wording"),
        h("button", { onclick: quiet(() => clear().then(() => showPolish(null))) }, "Keep mine"))));
  };
  const draftBtn = h("button", { onclick: quiet(() => api("POST", "/api/gap-drafts", { actionId: a.id }).then(() => { card.dataset.state = ""; show({ status: "requested" }); pollDrafts(); })) }, "Draft with Claude");
  /** Shows where the draft stands: waiting (spinner), ready, or nothing to draft from. */
  const show = (d) => {
    const status = d && d.status;
    draftBtn.textContent = status === "ready" || status === "none" ? "Draft again" : "Draft with Claude";
    draftBtn.disabled = status === "requested";
    if (status === "requested") {
      const run = (d && d.run) || { running: true };
      const retry = h("button", { onclick: quiet(() => api("POST", "/api/gap-drafts", { actionId: a.id }).then(() => { card.dataset.state = ""; show({ status: "requested" }); pollDrafts(); })) }, "Try again");
      const cancel = h("button", { onclick: quiet(() => api("POST", "/api/gap-drafts/cancel", { actionId: a.id }).then(() => show(null)), "Request cancelled") }, "Cancel");
      if (run.running) {
        panel.replaceChildren(h("div", { class: "drafting", role: "status" }, h("span", { class: "spin" }),
          h("div", { class: "grow" }, h("strong", {}, "Claude is drafting this…"), h("div", { class: "hint" }, "Usually under a minute. Leave this page open: the draft appears here by itself.")), cancel));
      } else {
        const why = run.error ? `Claude could not draft this: ${run.error}` : run.available === false
          ? "Claude cannot be started from the dashboard on this computer. Run /gaps in a Claude session and the draft appears here."
          : "Claude finished without drafting this one.";
        panel.replaceChildren(h("div", { class: "drafting" }, h("div", { class: "grow" }, h("strong", {}, why)), run.available === false ? null : retry, cancel));
      }
    } else if (status === "ready") {
      panel.replaceChildren(h("div", { class: "draft-note ok" }, "Drafted by Claude from your facts. Read it, fix anything that is not true, then save.", d.note ? h("div", { class: "hint" }, d.note) : null));
    } else if (status === "none") {
      panel.replaceChildren(h("div", { class: "draft-note" }, "Claude found nothing in your facts that covers this, so the box is empty.", d.note ? h("div", { class: "hint" }, d.note) : null));
    } else panel.replaceChildren();
  };
  const card = h("div", { class: "card warn-card", "data-gap": String(a.id) },
    h("div", { class: "row" }, h("span", { class: "badge gap" }, "gap"), g.importance ? h("span", { class: `badge ${g.importance === "required" ? "bad" : ""}` }, label(g.importance)) : null, a.jobId ? jobLink(a) : null),
    h("h2", { class: "mt-sm" }, g.requirement || "A requirement"),
    g.detail ? h("div", { class: "muted" }, g.detail) : null,
    closest.length ? h("div", { class: "hint" }, "Closest things you have saved: ", closest.map((f) => `"${f.text}"`).join("; ")) : null,
    h("div", { class: "field mt-lg" }, h("div", { class: "row" }, h("label", { class: "grow" }, "What have you actually done that covers this?"), polishBtn, draftBtn), text),
    panel,
    polishPanel,
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", {}, "It is"), kind),
      h("div", { class: "field" }, h("label", {}, "Add it under"), role)),
    h("div", { class: "row mt" },
      h("button", { class: "primary", onclick: act(() => save("job"), "Saved for this job") }, "Save for this job only"),
      h("button", { onclick: act(() => save("general"), "Saved to your facts") }, "Save for all my jobs"),
      confirmButton("I don't have this", "Click again: stop listing it", () => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" }))));
  registry.push({ filled: () => text.value.trim().length > 0, save });
  /** Called by the poller with the gap's latest state. A draft never overwrites what the user already typed. */
  card.applyDraft = (latest, run) => {
    const lg = latest.payload || {};
    show(lg.draft ? { ...lg.draft, run } : lg.draft);
    showPolish(lg.polish, run);
    const d = lg.suggestedFact;
    if (lg.draft && lg.draft.status === "ready" && d && !text.value.trim()) { text.value = d.text || ""; kind.value = d.kind || kind.value; }
  };
  show(g.draft);
  showPolish(g.polish);
  if ((g.draft && g.draft.status === "requested") || (g.polish && g.polish.status === "requested")) pollDrafts();
  return card;
}

/** Like act, but keeps the page as it is, so text typed in other boxes is not lost. */
const quiet = (fn, okText) => async (ev) => {
  const btn = ev && ev.currentTarget && ev.currentTarget.tagName === "BUTTON" ? ev.currentTarget : null;
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  try { await fn(); if (okText) toast("ok", okText); } catch (e) { showError(e); if (btn) btn.disabled = false; } finally { if (btn) btn.classList.remove("busy"); }
};

let draftTimer = null;
/** While any gap card on screen is waiting for Claude, look every 3 seconds and show what arrived. */
function pollDrafts() {
  if (draftTimer) return;
  draftTimer = setInterval(async () => {
    const waiting = [...document.querySelectorAll("[data-gap]")].filter((c) => c.applyDraft);
    if (!waiting.length) { clearInterval(draftTimer); draftTimer = null; return; }
    try {
      const [items, run] = await Promise.all([api("GET", "/api/actions"), api("GET", "/api/gap-drafts/status")]);
      let pending = 0;
      for (const c of waiting) {
        const latest = items.find((i) => String(i.id) === c.dataset.gap);
        if (!latest) { c.remove(); continue; }
        const dSt = (latest.payload.draft && latest.payload.draft.status) || "";
        const pSt = (latest.payload.polish && latest.payload.polish.status) || "";
        const waitingNow = dSt === "requested" || pSt === "requested";
        if (waitingNow) pending++;
        const key = `${dSt}|${pSt}|${waitingNow ? `${run.running}:${run.error || ""}:${run.available}` : ""}`;
        if (c.dataset.state !== key) { c.dataset.state = key; c.applyDraft(latest, run); }
      }
      if (!pending) { clearInterval(draftTimer); draftTimer = null; }
    } catch { /* the next look tries again */ }
  }, 3000);
}

/** The gap cards, with one button to save every box that has been filled in. */
async function gapList(list) {
  const [facts, cv] = await Promise.all([api("GET", "/api/facts"), api("GET", "/api/cv")]);
  const ctx = { facts: new Map(facts.map((f) => [f.id, f])), entries: cv.entries.filter((e) => e.kind !== "education") };
  const registry = [];
  const scope = h("select", {}, h("option", { value: "job" }, "for each gap's own job"), h("option", { value: "general" }, "for all my jobs"));
  const cards = list.map((a) => gapCard(a, ctx, registry));
  view.append(h("div", { class: "card" }, h("div", { class: "row" },
    h("strong", { class: "grow" }, `${list.length} gap${list.length === 1 ? "" : "s"}. Fill in what you have done, then save.`),
    h("button", { onclick: act(() => api("POST", "/api/metric-gaps", {}).then((r) => showNote(r.added ? `Added ${r.added} bullet${r.added === 1 ? "" : "s"} that need a number. ${r.left} more without one.` : "Every bullet already has a number, or you said you have none."))) }, "Ask for numbers"),
    h("button", { onclick: act(() => api("POST", "/api/gap-drafts", { all: true }).then((r) => { showNote(r.requested ? `Asked Claude to draft ${r.requested} gap${r.requested === 1 ? "" : "s"}. Run /gaps in a Claude session.` : "Every gap is already waiting for Claude."); })) }, "Draft all with Claude"),
    scope,
    h("button", { class: "primary", onclick: act(async () => {
      const todo = registry.filter((r) => r.filled());
      if (!todo.length) throw new Error("Fill in at least one box first");
      for (const r of todo) await r.save(scope.value);
      showNote(`Saved ${todo.length} fact${todo.length === 1 ? "" : "s"}. Run /tailor again on those jobs to use them.`);
    }) }, "Save all filled boxes")),
    h("div", { class: "hint" }, "A gap you leave empty stays here. Claude only drafts from facts you already saved, and nothing is saved until you press a save button.")));
  cards.forEach((c) => view.append(c));
}

const SCOPE_TEXT = { worldwide: "remote, worldwide", open_to_me: "remote, open to you" };
const SPONSOR_TEXT = { confirmed: "sponsors visas", likely: "on a sponsor register" };

const levelName = (v) => ((lists && lists.seniorityLevels.find((l) => l.value === v)) || { label: v }).label;

function signalBadges(j) {
  return [
    j.levelFit === "stretch" ? h("span", { class: "badge warn", title: "One step away from the levels you want. Ranked a little lower." }, `asks ${levelName(j.seniority)}: a stretch`) : null,
    j.levelFit === "mismatch" ? h("span", { class: "badge bad", title: "Two or more steps away from the levels you want. Ranked lower." }, `asks ${levelName(j.seniority)}: level mismatch`) : null,
    SCOPE_TEXT[j.remoteScope] && h("span", { class: "badge", title: "The posting lets someone in your country work remotely" }, SCOPE_TEXT[j.remoteScope]),
    SPONSOR_TEXT[j.sponsorship] && h("span", { class: "badge", title: j.sponsorshipEvidence || "" }, SPONSOR_TEXT[j.sponsorship]),
  ].filter(Boolean);
}

function addLinksBox() {
  const box = h("textarea", { placeholder: "Paste job links here, one per line. Claude opens each one, checks it, saves it and scores it." });
  const go = h("input", { type: "checkbox" });
  const result = h("div", {});
  const READY = ["found", "verified_live", "matched", "materials_ready"];
  let usable = [];
  const copy = h("button", { class: "primary", disabled: true, onclick: async () => {
    const cmd = `/add ${usable.join(" ")}${go.checked ? " go" : ""}`;
    try { await navigator.clipboard.writeText(cmd); showNote(`Copied. Paste it into your Claude session and press Enter.${go.checked ? " It will also fill each application and stop for your review." : ""}`); }
    catch { showNote(`Copy this and paste it into your Claude session: ${cmd}`); }
  } }, "Copy the /add command");
  const check = h("button", { onclick: async () => {
    const urls = [...new Set(box.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
    if (!urls.length) { result.replaceChildren(h("div", { class: "muted" }, "Paste at least one link.")); copy.disabled = true; return; }
    if (urls.length > 20) { result.replaceChildren(h("div", { class: "error" }, "Up to 20 links at a time.")); copy.disabled = true; return; }
    try {
      const checks = await api("POST", "/api/links/check", { urls });
      usable = checks.filter((c) => c.ok && (c.known !== "job" || READY.includes(c.state))).map((c) => c.url);
      result.replaceChildren(...checks.map((c) => h("div", { class: c.ok ? "muted" : "error" },
        !c.ok ? `Not a web link: ${c.url}` : c.known === "job" ? `Already in your pipeline (job ${c.jobId}, ${label(c.state)}): ${c.url}` : c.known === "skipped" ? `Rejected before, will be tried once more: ${c.url}` : `New: ${c.url}`)),
        h("div", { class: "muted" }, usable.length ? `${usable.length} will be sent to Claude.` : "Nothing new to add."));
      copy.disabled = usable.length === 0;
    } catch (e) { showError(e); }
  } }, "Check the links");
  return h("div", { class: "card" },
    h("h2", {}, "Add job links"), box,
    h("div", { class: "row mt" }, check, copy, h("label", {}, go, " also fill each application (it still stops for your review)")),
    result);
}

async function pipelineView() {
  const jobs = await api("GET", "/api/jobs");
  view.replaceChildren(h("h1", {}, `Pipeline (${jobs.length})`), addLinksBox());
  if (jobs.length === 0) view.append(h("div", { class: "empty" }, "No jobs yet."));
  const byState = {};
  for (const j of jobs) (byState[j.state] ||= []).push(j);
  for (const [state, list] of Object.entries(byState)) {
    view.append(h("h2", {}, `${label(state)} (${list.length})`));
    view.append(h("table", { class: "card-table" }, list.map((j) => h("tr", {},
      h("td", {}, h("a", { href: `#/jobs/${j.id}` }, j.title), h("span", { class: "muted" }, `  #${j.id}`), h("div", { class: "muted" }, j.company || "")),
      h("td", { class: "muted" }, j.matchScore !== undefined ? `${j.matchScore}` : ""),
      h("td", {}, signalBadges(j)),
      h("td", { class: "muted" }, j.source || ""),
      h("td", {}, goButton(j))))));
  }
}

function followUpButton(j, d) {
  const sentByEmail = d.application && d.application.route === "email";
  if ((j.state !== "applied" && j.state !== "no_response") || !sentByEmail) return null;
  return h("div", { class: "row" },
    h("button", { onclick: async () => { try { const r = await api("POST", `/api/jobs/${j.id}/follow-up`, {}); location.hash = `#/emails/${r.emailId}`; } catch (e) { showError(e); } } }, "Draft a follow-up"),
    h("span", { class: "muted" }, "A short reminder in the same email thread. You edit it and press Send."));
}

async function jobView(id) {
  const d = await api("GET", `/api/jobs/${id}`);
  const j = d.job;
  view.replaceChildren(...[
    h("p", {}, h("a", { href: "#/pipeline" }, "← pipeline")),
    h("h1", {}, j.title, h("span", { class: "muted" }, `  #${j.id}`)),
    h("div", { class: "row" },
      h("span", { class: "badge" }, label(j.state)), h("span", { class: "badge" }, `route: ${j.route}`),
      j.company && h("span", { class: "muted" }, j.company),
      safeHref(j.url) && h("a", { href: safeHref(j.url), target: "_blank", rel: "noopener noreferrer" }, "open posting")),
    goButton(j),
    followUpButton(j, d),
    h("div", { class: "row" }, signalBadges(j)),
    j.sponsorshipEvidence && h("p", { class: "muted" }, `Sponsorship: ${j.sponsorshipEvidence}`),
    j.matchReason && h("p", {}, `Match ${j.matchScore ?? ""}: ${j.matchReason}`),
    j.stateReason && h("p", { class: "muted" }, `Last change: ${j.stateReason}`),
  ].filter(Boolean));

  if (d.messages && d.messages.length) {
    view.append(h("h2", {}, `Replies (${d.messages.length})`));
    d.messages.forEach((m) => view.append(messageCard(m, () => jobView(id))));
  }
  const gaps = d.actions.filter((a) => a.kind === "gap");
  if (gaps.length) {
    view.append(h("div", { class: "row" }, h("h2", { class: "grow" }, "Gaps"),
      h("button", { onclick: act(() => api("POST", "/api/gap-drafts", { jobId: id }).then(() => showNote("Asked Claude to draft these. Run /gaps in a Claude session."))) }, "Draft all with Claude")));
    gaps.forEach((a) => view.append(gapCard(a)));
  }
  const others = d.actions.filter((a) => a.kind !== "gap");
  if (others.length) { view.append(h("h2", {}, "Waiting on you")); others.forEach((a) => view.append(actionCard(a))); }

  if (d.allowedTransitions.length) {
    view.append(h("h2", {}, "Move this job"),
      h("div", { class: "row" }, d.allowedTransitions.map((to) =>
        h("button", { onclick: act(() => api("POST", `/api/jobs/${id}/transition`, { to })) }, label(to)))));
  }

  if (d.application && d.application.status !== "discarded") {
    view.append(h("h2", {}, "Application"),
      h("div", { class: "row" }, statusBadge(d.application.status), d.application.route === "form" ? h("a", { href: `#/applications/${id}` }, "review the filled form") : h("span", { class: "muted" }, "sent by email")));
  }
  const posting = d.posting || {};
  view.append(h("h2", {}, "Posting"));
  if (posting.description) {
    view.append(h("div", { class: "muted" }, [posting.postedBy && `Posted by: ${posting.postedBy}`, posting.applyUrl && safeHref(posting.applyUrl) && "apply link saved", `saved ${(posting.detailsAt || "").slice(0, 16)}`].filter(Boolean).join("  |  ")),
      h("details", { class: "card" }, h("summary", {}, `Saved text (${posting.description.length} characters)`),
        h("div", { class: "pre mt" }, posting.description)));
  } else {
    view.append(h("div", { class: "muted" }, "No posting text saved yet. Tailoring will open the page once and save it."));
  }
  const people = d.people || [];
  view.append(h("h2", {}, "People at the company"));
  if (!people.length) {
    view.append(h("div", { class: "muted" }, d.researchedAt ? "The company's own pages were searched and no decision makers were found." : "Not searched yet."));
  }
  for (const p of people) {
    view.append(h("div", { class: "row" }, h("strong", {}, p.name), h("span", { class: "muted" }, p.role),
      safeHref(p.sourceUrl) && h("a", { href: safeHref(p.sourceUrl), target: "_blank", rel: "noopener noreferrer" }, "the page")));
  }
  const contacts = d.contacts || [];
  const noContact = d.events.find((ev) => ev.type === "no_contact_found");
  view.append(h("h2", {}, "Contacts"));
  if (!contacts.length) {
    view.append(h("div", { class: "muted" }, noContact
      ? `No verified contact found${noContact.detail && noContact.detail.detail ? ": " + noContact.detail.detail : ""}. Apply through the site.`
      : "None yet."));
  }
  for (const c of contacts) {
    view.append(h("div", { class: "card" }, h("div", { class: "row" },
      h("strong", {}, c.email), c.name && h("span", { class: "muted" }, c.name), c.role && h("span", { class: "muted" }, c.role),
      c.status === "bounced" && h("span", { class: "badge gap" }, "bounced"),
      c.verification === "pattern" && h("span", { class: "badge gap" }, "derived from the company's pattern"),
      c.browserEvidence && h("span", { class: "badge", title: c.browserEvidence.quote }, "read in a browser"),
      h("span", { class: "muted" }, c.addedBy === "user" ? "added by you" : "found on"),
      c.addedBy !== "user" && (safeHref(c.sourceUrl) ? h("a", { href: safeHref(c.sourceUrl), target: "_blank", rel: "noopener noreferrer" }, "the page") : null),
      c.status !== "bounced" && h("button", { class: "danger", onclick: act(() => api("POST", `/api/contacts/${c.id}/bounced`, {})) }, "Mark bounced"))));
  }
  const cEmail = h("input", { type: "email", placeholder: "email address" });
  const cName = h("input", { placeholder: "name (optional)" });
  view.append(h("details", { class: "my-sm" }, h("summary", { class: "muted" }, "Add a contact myself"),
    h("div", { class: "row" }, cEmail, cName,
      h("button", { class: "primary", onclick: act(() => api("POST", `/api/jobs/${id}/contacts`, { email: cEmail.value, name: cName.value })) }, "Add"))));
  if ((d.emails || []).length) {
    view.append(h("h2", {}, "Emails"));
    for (const e of d.emails) view.append(h("div", { class: "row" }, emailBadge(e.status), h("a", { href: `#/emails/${e.id}` }, `to ${e.contact.email}`)));
  }

  view.append(h("h2", {}, "Link checks"));
  view.append(d.verifications.length
    ? h("table", { class: "card-table" }, d.verifications.map((v) => h("tr", {}, h("td", {}, v.checked_at), h("td", {}, v.result), h("td", { class: "muted" }, v.evidence || ""))))
    : h("div", { class: "muted" }, "None yet."));

  view.append(h("h2", {}, "Documents"));
  if (!d.documents.length) view.append(h("div", { class: "muted" }, "None yet."));
  /** The ATS score of a CV, with what to fix. It appears once Claude has scored the CV (the tailoring does it). */
  const scoreBox = (docId) => {
    const box = h("div", { class: "hint" }, "Checking the ATS score...");
    api("GET", `/api/documents/${docId}/score`).then((r) => {
      if (r.score === null || r.score === undefined) { box.textContent = "Not scored yet. Run /tailor on this job and Claude scores the CV against the posting's keywords."; return; }
      const parts = r.parts;
      const kw = (r.keywords || []).map((k) => h("span", { class: `badge ${k.found ? "" : k.critical ? "bad" : "gap"}`, title: k.found ? `found ${k.count}x in ${k.where.join(", ")}` : "not on the CV" }, `${k.found ? "" : "missing: "}${k.term}`));
      box.className = "";
      box.replaceChildren(
        h("div", { class: "row" }, h("strong", {}, `ATS score ${r.score} / 100`),
          h("span", { class: "muted" }, `formatting ${parts.formatting}/30, keywords ${parts.keywords}/30 (${Math.round(r.coverage * 100)}% matched, target 80%), evidence ${parts.evidence}/20, summary ${parts.summary}/20`)),
        h("div", { class: "row" }, kw),
        r.issues && r.issues.length ? h("ul", { class: "muted" }, r.issues.map((i) => h("li", {}, i))) : null,
        (r.issues || []).some((i) => /carry a number/.test(i)) ? h("a", { href: "#/facts" }, "Add numbers to your bullets") : null);
    }).catch(() => { box.textContent = ""; });
    return box;
  };
  const docCard = (doc) => h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, `${doc.kind} v${doc.version}`), h("span", { class: "muted" }, doc.path),
      doc.path.toLowerCase().endsWith(".pdf") && h("a", { href: `/api/documents/${doc.id}/file`, target: "_blank", rel: "noopener noreferrer" }, "Open PDF"),
      confirmButton("Delete", "Click again: delete this and its file", () => api("DELETE", `/api/documents/${doc.id}`, {}))),
    doc.kind === "cv" ? scoreBox(doc.id) : null,
    doc.blocks.map((b) => h("p", { class: b.kind === "boilerplate" ? "muted" : "" }, b.text,
      b.factIds.length ? h("span", { class: "muted" }, `  [facts ${b.factIds.join(", ")}]`) : null)));
  // The newest version of each kind is shown; older versions are folded away so they do not look like repeats.
  const kinds = [...new Set(d.documents.map((x) => x.kind))];
  for (const kind of kinds) {
    const versions = d.documents.filter((x) => x.kind === kind).sort((a, b) => b.version - a.version);
    view.append(docCard(versions[0]));
    if (versions.length > 1) {
      view.append(h("details", {}, h("summary", { class: "muted" }, `Older ${kind} versions (${versions.length - 1})`),
        ...versions.slice(1).map(docCard)));
    }
  }

  view.append(h("h2", {}, "History"));
  view.append(h("table", { class: "card-table" }, d.events.map((e) => h("tr", {},
    h("td", { class: "muted" }, e.at), h("td", {}, e.actor), h("td", {}, label(e.type))))));
}

async function factsView() {
  const facts = await api("GET", "/api/facts");
  const kind = h("select", {}, ["experience", "skill", "achievement", "education", "cert"].map((k) => h("option", { value: k }, k)));
  const text = h("textarea", { placeholder: "A true statement about you. Include real numbers and dates." });
  const range = h("input", { placeholder: "dates (optional)" });
  const note = h("input", { placeholder: "where this is documented (optional)" });
  const metric = await api("GET", "/api/metric-gaps");
  view.replaceChildren(
    h("h1", {}, `Facts (${facts.length})`),
    metric.withoutNumber ? h("div", { class: "card" }, h("div", { class: "row" },
      h("div", { class: "grow" }, h("strong", {}, `${metric.withoutNumber} bullet${metric.withoutNumber === 1 ? "" : "s"} have no number`),
        h("div", { class: "hint" }, "A number on a bullet reads as proof and raises the CV's ATS score. You answer a few at a time in Needs you, under Gaps. Only numbers you can stand behind.")),
      h("button", { class: "primary", onclick: act(async () => { const r = await api("POST", "/api/metric-gaps", {}); showNote(`Added ${r.added} card${r.added === 1 ? "" : "s"} in Needs you, under Gaps.`); }) }, "Ask me for numbers"))) : null,
    h("div", { class: "card" }, h("div", { class: "row" }, kind, range, note), text,
      h("div", { class: "row mt" },
        h("button", { class: "primary", onclick: act(() => api("POST", "/api/facts", {
          kind: kind.value, text: text.value, dateRange: range.value || undefined, sourceNote: note.value || undefined,
        })) }, "Add fact"))));
  for (const f of facts) {
    view.append(h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, f.kind),
        f.jobId !== undefined && h("span", { class: "badge gap" }, `job ${f.jobId} only`),
        f.dateRange && h("span", { class: "muted" }, f.dateRange)),
      h("p", {}, f.text),
      f.sourceNote && h("div", { class: "muted" }, f.sourceNote),
      h("div", { class: "row" },
        f.jobId !== undefined && h("button", { onclick: act(() => api("POST", `/api/facts/${f.id}/make-general`, {})) }, "Make general"),
        confirmButton("Delete", "Click again to delete", () => api("DELETE", `/api/facts/${f.id}`, {})))));
  }
}



// ---------- CV ----------

const ENTRY_LABELS = {
  work: { add: "Add a job", title: "Job title", org: "Company", note: "Shown after the location, e.g. Contract, Part-time, Co-founder (optional)" },
  project: { add: "Add a project", title: "Project name", org: "Link or context (optional)", note: "One-line description (optional)" },
  education: { add: "Add education", title: "Degree", org: "School", note: "Notes, e.g. GPA (optional)" },
};

function dateText(e) {
  const end = e.isCurrent ? "Present" : e.endDate || "";
  return [e.startDate, end].filter(Boolean).join(" to ");
}

function entryForm(kind, e, submit) {
  const L = ENTRY_LABELS[kind];
  const f = {
    title: textField(L.title, e?.title),
    org: textField(L.org, e?.organization),
    where: textField("Location (optional)", e?.location),
    start: textField("Start (2022 or 2022-03)", e?.startDate),
    end: textField("End (leave empty if current)", e?.endDate),
    note: textField(L.note, e?.note),
  };
  const country = h("select", {}, [["", "Not set"], ...lists.countries.map((c) => [c, c])].map(([v, t]) => h("option", { value: v }, t)));
  country.value = e?.country || "";
  const current = h("input", { type: "checkbox" });
  current.checked = e?.isCurrent === true;
  const empType = h("select", {}, [["", "Not set"], ["full_time", "Full-time"], ["part_time", "Part-time"], ["contract", "Contract"], ["freelance", "Freelance"]].map(([v, t]) => h("option", { value: v }, t)));
  empType.value = e?.employmentType || "";
  const weight = h("select", {}, [["normal", "Let the agent decide"], ["always", "Always include"], ["lead", "Lead with this"]].map(([v, t]) => h("option", { value: v }, t)));
  weight.value = e?.weight || "normal";
  const body = () => ({
    kind, title: f.title.get(), organization: f.org.get(), location: f.where.get(),
    startDate: f.start.get(), endDate: f.end.get(), isCurrent: current.checked, note: f.note.get(), weight: weight.value, country: country.value, employmentType: empType.value,
  });
  const parts = [f.title.el, f.org.el, f.where.el];
  if (kind !== "project") parts.push(h("div", { class: "row" }, f.start.el, f.end.el, h("label", { class: "muted" }, current, " Current")));
  if (kind !== "education") parts.push(h("div", { class: "field" }, h("label", {}, "Country the work was for"), country));
  if (kind === "work") parts.push(h("div", { class: "field" }, h("label", {}, "Type of work"), empType));
  parts.push(f.note.el,
    h("div", { class: "field" }, h("label", {}, "On tailored CVs"), weight),
    h("button", { class: "primary", onclick: act(() => submit(body())) }, "Save"));
  return h("div", {}, parts);
}

function bulletRow(b) {
  const row = h("div", { class: "row-top" });
  const show = () => {
    row.replaceChildren(
      h("span", { class: "grow" }, "• " + b.text),
      h("button", { onclick: edit }, "Edit"),
      confirmButton("Delete", "Click again", () => api("DELETE", `/api/facts/${b.id}`, {})));
  };
  const edit = () => {
    const t = h("textarea", {});
    t.value = b.text;
    row.replaceChildren(t,
      h("button", { class: "primary", onclick: act(() => api("PUT", `/api/cv/bullets/${b.id}`, { text: t.value })) }, "Save"),
      h("button", { onclick: show }, "Cancel"));
  };
  show();
  return row;
}

function entryCard(e) {
  const meta = [e.organization, e.location, e.country && `country: ${e.country}`, e.employmentType && e.employmentType.replace("_", "-"), dateText(e)].filter(Boolean).join("  |  ");
  const card = h("div", { class: "card" },
    h("div", { class: "row" },
      h("strong", { class: "grow" }, e.title),
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/move`, { direction: "up" })) }, "↑"),
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/move`, { direction: "down" })) }, "↓"),
      confirmButton("Delete", "Click again to delete this and its bullets", () => api("DELETE", `/api/cv/entries/${e.id}`, {}))),
    meta && h("div", { class: "muted" }, meta),
    e.note && h("div", { class: "muted" }, e.note),
    !e.startDate && e.kind === "work" && h("div", { class: "muted warn" }, "No dates yet. Edit this entry to add them."),
    h("details", { class: "my" }, h("summary", { class: "muted" }, "Edit details"),
      entryForm(e.kind, e, (body) => api("PUT", `/api/cv/entries/${e.id}`, body))));
  if (e.kind !== "education") {
    for (const b of e.bullets) card.append(bulletRow(b));
    const t = h("textarea", { placeholder: "Add a bullet: one true statement, with real numbers" });
    card.append(h("div", { class: "mt-sm" }, t,
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/bullets`, { text: t.value })) }, "Add bullet")));
  }
  return card;
}

function skillGroupCard(g) {
  const input = h("input", { class: "grow grow-min" });
  input.value = g.skills.map((s) => (s.level ? `${s.text}:${s.level}` : s.text)).join(", ");
  return h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, g.group), input,
    h("button", { class: "primary", onclick: act(() => api("PUT", "/api/cv/skills", { group: g.group, items: input.value.split(",") })) }, "Save"),
    confirmButton("Remove group", "Click again to remove the group", () => api("PUT", "/api/cv/skills", { group: g.group, items: [] }))));
}

async function cvView() {
  const m = await api("GET", "/api/cv");
  view.replaceChildren(
    h("h1", {}, "CV"),
    h("p", { class: "muted" }, "Your jobs, projects, education and skills. Tailored CVs are built from these and nothing else, so keep them true and complete."),
    h("div", { class: "row" },
      h("a", { href: "/api/cv/preview.pdf", target: "_blank", rel: "noopener noreferrer" }, "Preview the whole CV as a PDF")));
  const sections = [["work", "Work experience"], ["project", "Projects"], ["education", "Education"]];
  for (const [kind, title] of sections) {
    view.append(h("h2", {}, title));
    view.append(h("details", { class: "card" }, h("summary", {}, ENTRY_LABELS[kind].add),
      entryForm(kind, null, (body) => api("POST", "/api/cv/entries", body))));
    for (const e of m.entries.filter((x) => x.kind === kind)) view.append(entryCard(e));
  }
  view.append(h("h2", {}, "Skills"), h("p", { class: "muted" }, "Add a level after a colon if you want sites that ask for one to get it: Python:advanced, Docker:intermediate. Levels are beginner, intermediate, advanced or expert. A skill with no level uses your default from Settings, or Claude asks you."));
  const gname = h("input", { placeholder: "Group, e.g. Backend" });
  const gitems = h("input", { placeholder: "Skills, comma separated. A level is optional: Python:advanced", class: "grow grow-min" });
  view.append(h("div", { class: "card" }, h("div", { class: "row" }, gname, gitems,
    h("button", { class: "primary", onclick: act(() => api("PUT", "/api/cv/skills", { group: gname.value, items: gitems.value.split(",") })) }, "Add group"))));
  for (const g of m.skills) view.append(skillGroupCard(g));
}


/** Pick items from a list and put them in order. Used where typing would cause silent mismatches. */
function orderedPicker(label, options, selected) {
  const known = new Set(options.map((o) => o[0]));
  const state = selected.filter((v) => known.has(v));
  const dropped = selected.filter((v) => !known.has(v));
  const text = (v) => (options.find((o) => o[0] === v) || [v, v])[1];
  const box = h("div", {});
  const add = h("select", {});
  const draw = () => {
    add.replaceChildren(h("option", { value: "" }, "Add one..."), ...options.filter((o) => !state.includes(o[0])).map((o) => h("option", { value: o[0] }, o[1])));
    box.replaceChildren(
      ...state.map((v, i) => h("div", { class: "row my-xs" },
        h("span", { class: "badge" }, String(i + 1)),
        h("span", { class: "grow" }, text(v)),
        h("button", { onclick: () => { if (i > 0) { [state[i - 1], state[i]] = [state[i], state[i - 1]]; draw(); } } }, "↑"),
        h("button", { onclick: () => { if (i < state.length - 1) { [state[i + 1], state[i]] = [state[i], state[i + 1]]; draw(); } } }, "↓"),
        h("button", { class: "danger", onclick: () => { state.splice(i, 1); draw(); } }, "Remove"))),
      h("div", { class: "row" }, add));
  };
  add.addEventListener("change", () => { if (add.value) { state.push(add.value); draw(); } });
  draw();
  return {
    el: h("div", { class: "field" }, h("label", {}, label), box,
      dropped.length > 0 && h("div", { class: "muted warn" }, `Not recognised and removed: ${dropped.join(", ")}. Save to keep the cleaned list.`)),
    get: () => [...state],
  };
}




// ---------- applications (forms) ----------

const statusBadge = (st) => h("span", { class: `badge${st === "prepared" ? " gap" : ""}` }, st === "prepared" ? "waiting for you" : st);

async function applicationsView() {
  const [list, room] = await Promise.all([api("GET", "/api/applications"), api("GET", "/api/application-count")]);
  const waiting = list.filter((a) => a.status === "prepared");
  const rest = list.filter((a) => a.status !== "prepared");
  view.replaceChildren(h("h1", {}, "Applications"),
    h("p", { class: "muted" }, "Forms the agent filled in and left open for you. Nothing is submitted until you click Submit on the site yourself."),
    h("div", { class: "card" }, h("div", { class: "row" },
      h("div", { class: "grow" }, h("strong", {}, `Today: ${room.used} of ${room.limit} applications used or waiting`),
        h("div", { class: "hint" }, room.remaining ? `Claude can start ${room.remaining} more today.` : "The limit is full, so Claude will not start another form.")),
      confirmButton("Reset today's count", "Click again: start the count from zero", () => api("POST", "/api/application-count/reset", {})))));
  const row = (a) => h("div", { class: "card" }, h("div", { class: "row" }, statusBadge(a.status),
    h("a", { href: `#/applications/${a.jobId}` }, a.jobTitle), a.company && h("span", { class: "muted" }, a.company), h("span", { class: "muted" }, a.route)));
  view.append(h("h2", {}, `Waiting for you (${waiting.length})`));
  if (!waiting.length) view.append(h("div", { class: "empty" }, "No forms waiting."));
  waiting.forEach((a) => view.append(row(a)));
  if (rest.length) { view.append(h("h2", {}, "Earlier")); rest.forEach((a) => view.append(row(a))); }
}

async function applicationView(jobId) {
  const a = await api("GET", `/api/applications/${jobId}`);
  const job = await api("GET", `/api/jobs/${jobId}`);
  const sensitive = a.answers.filter((x) => x.sensitive || x.kind === "policy" || x.kind === "consent");
  view.replaceChildren(
    h("p", {}, h("a", { href: "#/applications" }, "← applications")),
    h("h1", {}, job.job.title),
    h("div", { class: "row" }, statusBadge(a.status), job.job.company && h("span", { class: "muted" }, job.job.company), h("a", { href: `#/jobs/${jobId}` }, "job page")));

  if (a.status === "prepared") {
    view.append(h("div", { class: "card" },
      h("p", {}, "The agent filled this form in its browser tab and left it open. Check it there, fill what was left for you, then click Submit on the site yourself. Come back and press \"I submitted it\"."),
      safeHref(a.formUrl) && h("p", {}, h("a", { href: safeHref(a.formUrl), target: "_blank", rel: "noopener noreferrer" }, "Open the form in a new tab"), h("span", { class: "muted" }, "  (a new tab will not have the agent's entries; use its own tab)")),
      h("div", { class: "hint" }, "If the browser window was closed, the filled form is gone but your answers are saved here. Refill puts them back without writing anything again."),
      refillBox(jobId)));
  }
  if (a.salaryQuoted) {
    view.append(h("div", { class: "card" }, h("strong", {}, `Salary entered: ${a.salaryQuoted} per ${a.salaryPeriod}`), h("div", { class: "muted" }, a.salaryReason || "")));
  }
  const differ = a.answers.filter((x) => x.check === "differs");
  if (differ.length) {
    view.append(h("h2", {}, "These differ from your saved information"));
    differ.forEach((x) => view.append(h("div", { class: "card company discarded-flag" }, h("div", { class: "muted" }, x.question), h("div", {}, x.answer), h("div", { class: "warn" }, x.checkNote || "Differs from its source"))));
  }
  if (sensitive.length) {
    view.append(h("h2", {}, "Look at these first"));
    sensitive.forEach((x) => view.append(h("div", { class: "card" }, h("div", { class: "muted" }, x.question), h("div", {}, x.answer))));
  }
  view.append(h("h2", {}, `Everything entered (${a.answers.length})`));
  view.append(h("table", { class: "card-table" }, a.answers.map((x) => h("tr", {},
    h("td", { class: "muted w40" }, x.question),
    h("td", { class: "pre" }, x.answer.length > 400 ? `${x.answer.slice(0, 400)}...` : x.answer,
      x.documentId ? h("div", {}, h("a", { href: `/api/documents/${x.documentId}/file`, target: "_blank", rel: "noopener noreferrer" }, "Open the cover letter PDF")) : null),
    h("td", {}, h("span", { class: "badge" }, x.kind.replace("_", " ")),
      x.check === "verified" ? h("span", { class: "badge good", title: x.checkNote || "Follows from its source" }, "✓ checked")
        : x.check === "differs" ? h("span", { class: "badge gap", title: x.checkNote || "" }, "differs")
        : x.check === "unchecked" ? h("span", { class: "badge", title: x.checkNote || "Could not be checked" }, "not checked") : null)))));
  view.append(h("h2", {}, `Left for you (${a.leftBlank.length})`));
  if (!a.leftBlank.length) view.append(h("div", { class: "muted" }, "Nothing."));
  a.leftBlank.forEach((x) => view.append(h("div", { class: "card" }, h("div", {}, x.question), h("div", { class: "muted" }, x.why))));
  if (a.notes) view.append(h("p", { class: "muted" }, a.notes));

  if (a.status === "prepared") {
    let armed = false;
    const done = h("button", { class: "primary", onclick: async () => {
      if (!armed) { armed = true; done.textContent = "Click again: I submitted it on the site"; setTimeout(() => { armed = false; done.textContent = "I submitted it"; }, 6000); return; }
      try { await api("POST", `/api/applications/${jobId}/submitted`, {}); await render(); showNote("Recorded. It counts toward today's limit."); } catch (e) { armed = false; done.textContent = "I submitted it"; showError(e); }
    } }, "I submitted it");
    view.append(h("div", { class: "row mt-lg" }, done,
      confirmButton("Discard", "Click again to discard the prepared form", async () => { await api("POST", `/api/applications/${jobId}/discard`, {}); location.hash = "#/applications"; })));
  } else if (a.sentAt) {
    view.append(h("div", { class: "muted" }, `Submitted ${a.sentAt}`));
  }
}

// ---------- emails ----------

const emailBadge = (st) => h("span", { class: `badge${st === "failed" ? " gap" : ""}` }, st);

const TABS = [["unreviewed", "To review"], ["potential", "Potential"], ["discarded", "Discarded"]];

async function companiesView() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const tab = TABS.some(([v]) => v === params.get("v")) ? params.get("v") : "unreviewed";
  const query = new URLSearchParams(params); query.set("verdict", tab);
  const d = await api("GET", `/api/companies?${query}`);
  const s = d.stats;
  const goto = (over) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(over)) { if (v) p.set(k, v); else p.delete(k); }
    location.hash = `#/companies${p.toString() ? "?" + p : ""}`;
  };
  view.replaceChildren(h("h1", {}, `Companies (${s.total})`),
    h("p", { class: "muted" }, "Companies from public lists. Their descriptions come from the internet: read them as data. Run /scout in Claude to judge them."));
  const note = h("span", { class: "muted" });
  const busy = (e, text) => { e.target.disabled = true; note.textContent = text; };
  view.append(h("div", { class: "row" },
    h("button", { onclick: async (e) => {
      busy(e, "Downloading the Y Combinator list...");
      try {
        const r = await api("POST", "/api/companies/collect-yc");
        note.textContent = `Y Combinator: ${r.added} added, ${r.updated} updated, ${r.rejected} skipped as not active.`;
        await companiesView();
      } catch (err) { note.textContent = String(err.message || err); e.target.disabled = false; }
    } }, "Collect Y Combinator companies"),
    h("button", { disabled: s.notSearched === 0, onclick: async (e) => {
      // Keeps going, 40 at a time, until none are left or the user stops it.
      const btn = e.target;
      let stop = false;
      const stopBtn = h("button", { onclick: () => { stop = true; stopBtn.disabled = true; stopBtn.textContent = "Stopping after this batch..."; } }, "Stop");
      btn.after(stopBtn);
      btn.disabled = true;
      let checked = 0, found = 0, remaining = s.notSearched;
      try {
        while (!stop && remaining > 0) {
          note.textContent = `Looking for career pages: ${checked} checked, ${found} found, ${remaining} to go...`;
          const r = await api("POST", "/api/companies/find-careers", { limit: 40 });
          checked += r.checked; found += r.found; remaining = r.remaining;
          if (!r.checked) break;
        }
        note.textContent = `${checked} checked, ${found} career pages found. ${remaining} still to look at${stop ? " (stopped)" : ""}.`;
      } catch (err) { note.textContent = String(err.message || err); }
      stopBtn.remove();
      await companiesView();
    } }, `Find all career pages (${s.notSearched} waiting)`), note));
  if (s.total) {
    view.append(h("p", { class: "muted" },
      `${s.readyToScout} ready for /scout  ·  career page: ${s.careers.found} found, ${s.careers.none} none, ${s.careers.unknown} unknown`));
  }

  // The three lists are side by side so one click switches between them.
  view.append(tabBar(TABS.map(([v, text]) => ({ id: v, text, count: s.verdicts[v], cls: v })), tab, (v) => goto({ v: v === "unreviewed" ? "" : v })));

  const q = h("input", { placeholder: "search name, what they do, industry", value: params.get("q") || "" });
  const remote = h("input", { type: "checkbox" });
  remote.checked = params.get("remote") === "1";
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") goto({ q: q.value.trim() }); });
  remote.addEventListener("change", () => goto({ remote: remote.checked ? "1" : "" }));
  view.append(h("div", { class: "row" }, q, h("label", {}, remote, " remote-friendly only"), h("button", { onclick: () => goto({ q: q.value.trim() }) }, "Search")));

  if (!d.companies.length) {
    view.append(h("div", { class: "empty" }, s.total
      ? (tab === "unreviewed" ? "Nothing here to review." : tab === "potential" ? "No company is marked potential yet." : "No company is discarded.")
      : "No companies yet. Press the first button."));
    return;
  }
  const move = (c, to, text, cls) => h("button", { class: cls, onclick: async (e) => {
    e.target.disabled = true;
    await api("POST", `/api/companies/${c.id}/verdict`, { verdict: to, reason: to === "unreviewed" ? undefined : "Moved by you" });
    await companiesView();
  } }, text);
  view.append(...d.companies.map((c) => h("div", { class: `card company ${c.verdict}` },
    h("div", { class: "row" },
      safeHref(c.website) ? h("a", { href: safeHref(c.website), target: "_blank", rel: "noopener noreferrer" }, c.name) : h("span", {}, c.name),
      c.remoteHint === "fully" ? h("span", { class: "badge" }, "fully remote") : c.remoteHint === "partly" ? h("span", { class: "badge" }, "remote-friendly") : null,
      c.careersStatus === "found" && safeHref(c.careersUrl)
        ? h("a", { href: safeHref(c.careersUrl), target: "_blank", rel: "noopener noreferrer", class: "muted" }, (c.careersNote && c.careersNote.startsWith("YC jobs page") ? "jobs page on YC" : "career page"))
        : h("span", { class: "muted" }, c.careersStatus === "none" ? "no career link on its home page" : c.careersNote || "career page not looked at yet")),
    h("div", { class: "muted" }, [c.oneLiner, c.location, c.industry, c.teamSize ? `${c.teamSize} people` : ""].filter(Boolean).join(" · ")),
    c.verdict === "unreviewed" && c.scoutTriedAt && h("div", { class: "muted" }, "/scout looked at this one and gave no verdict (for example, the page would not load). It will try again after the others."),
    c.verdictReason && h("div", { class: "reason" }, (c.verdictBy === "user" ? (c.verdictReason === "Moved by you" ? c.verdictReason : `You: ${c.verdictReason}`) : `Claude: ${c.verdictReason}`)),
    h("div", { class: "row" },
      c.verdict !== "potential" && move(c, "potential", "Move to potential", "good"),
      c.verdict !== "discarded" && move(c, "discarded", "Move to discarded", "danger"),
      c.verdict !== "unreviewed" && move(c, "unreviewed", "Back to review")))));
  if (d.companies.length === 200) view.append(h("p", { class: "muted" }, "Showing the first 200. Narrow the search to see others."));
}

const REPLY_TABS = [["new", "New"], ["handled", "Handled"], ["ignored", "Not a reply"]];
const CATEGORY_TEXT = { reply: "reply", auto_reply: "automatic reply", bounce: "bounced", rejection: "looks like a rejection", interview: "looks like an interview", other: "other" };

function messageCard(m, refresh) {
  const category = h("select", {}, Object.entries(CATEGORY_TEXT).map(([v, t]) => h("option", { value: v }, t)));
  category.value = m.category;
  category.addEventListener("change", act(async () => { await api("POST", `/api/messages/${m.id}`, { category: category.value }); await refresh(); }));
  const outcome = (to, text) => h("button", { onclick: act(async () => { await api("POST", `/api/messages/${m.id}/outcome`, { to }); await refresh(); }) }, text);
  const setStatus = (status, text, cls) => h("button", { class: cls || "", onclick: act(async () => { await api("POST", `/api/messages/${m.id}`, { status }); await refresh(); }) }, text);
  return h("div", { class: `card message ${m.category}` },
    h("div", { class: "row" },
      h("span", { class: `badge${m.category === "bounce" ? " gap" : ""}` }, CATEGORY_TEXT[m.category]),
      m.matchedBy === "sender" ? h("span", { class: "badge", title: "It did not reply to your email directly. It is from someone at the company you wrote to." }, "possible match") : null,
      m.matchedBy === "domain" ? h("span", { class: "badge", title: "You applied through a form, so there is no email of yours to match. It comes from the company's own address." }, "from the company, possible match") : null,
      m.matchedBy === "platform" ? h("span", { class: "badge", title: "You applied through a form. It comes from a job platform and names both the company and this job's title, and it arrived after you applied." }, "from a job platform, check it is this job") : null,
      m.jobId ? h("a", { href: `#/jobs/${m.jobId}` }, `${m.jobTitle || "job"}${m.company ? `, ${m.company}` : ""}`) : null,
      h("span", { class: "muted" }, m.receivedAt.replace("T", " ").slice(0, 16))),
    h("div", {}, h("strong", {}, m.fromName ? `${m.fromName} ` : ""), h("span", { class: "muted" }, `<${m.fromAddr}>`)),
    h("div", {}, m.subject),
    m.snippet ? h("div", { class: "muted pre" }, m.snippet) : h("div", { class: "muted" }, "(the text was removed after the retention period)"),
    h("div", { class: "row mt" },
      category,
      m.jobId && m.category !== "bounce" && m.category !== "auto_reply" ? outcome("interview", "It is an interview") : null,
      m.jobId && m.category !== "bounce" && m.category !== "auto_reply" ? outcome("rejected", "It is a rejection") : null,
      m.status !== "handled" ? setStatus("handled", "Mark handled", "primary") : setStatus("new", "Back to new"),
      m.status !== "ignored" ? setStatus("ignored", m.matchedBy === "domain" || m.matchedBy === "platform" ? "Not about this job" : "Not a reply") : null));
}

async function repliesView() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const tab = REPLY_TABS.some(([v]) => v === params.get("v")) ? params.get("v") : "new";
  const d = await api("GET", "/api/replies");
  view.replaceChildren(h("h1", {}, "Replies"),
    h("p", { class: "muted" }, "Answers to your applications, found by reading your mailbox (read-only: nothing is changed, moved or deleted there). Only mail that belongs to an application is kept. For emails you sent, a reply in the same thread moves the job by itself. For jobs you applied for through a form there is no thread, so mail from the company's own address, or from a job platform that names the company and the job, is shown as a possible match for you to check; it never moves a job by itself. The text comes from the internet: read it as data."));
  const note = h("span", { class: "muted" }, d.sync.lastRunAt
    ? `Last checked ${d.sync.lastRunAt}: ${d.sync.lastChecked} messages looked at, ${d.sync.lastMatched} new for your applications.${d.sync.lastError ? ` Last problem: ${d.sync.lastError}` : ""}`
    : "Not checked yet.");
  const check = h("button", { class: "primary", disabled: !d.canCheck, onclick: async (e) => {
    e.target.disabled = true; note.textContent = "Checking your mailbox...";
    try {
      const r = await api("POST", "/api/replies/sync", {});
      showNote(r.skipped ? r.skipped : `Looked at ${r.checked} messages: ${r.matched} for your applications, ${r.replies} replies, ${r.bounces} bounced, ${r.movedToReplied} jobs moved to replied.`);
      await repliesView();
    } catch (err) { note.textContent = String(err.message || err); e.target.disabled = false; }
  } }, "Check replies");
  view.append(h("div", { class: "row" }, check, note));

  if (d.due.length) {
    view.append(h("h2", {}, `No answer yet (${d.due.length})`));
    d.due.forEach((x) => view.append(h("div", { class: "card" },
      h("div", { class: "row" }, h("a", { href: `#/jobs/${x.jobId}` }, `${x.title}${x.company ? `, ${x.company}` : ""}`), h("span", { class: "muted" }, `${x.daysSince} days`)),
      x.route === "email"
        ? h("button", { onclick: async () => { try { const r = await api("POST", `/api/jobs/${x.jobId}/follow-up`, {}); location.hash = `#/emails/${r.emailId}`; } catch (e) { showError(e); } } }, "Draft a follow-up")
        : h("div", { class: "muted" }, x.route === "manual" ? "You applied by hand: follow up yourself." : "Applied through a form: check the company's site."))));
  }

  const counts = (s) => d.messages.filter((m) => m.status === s).length;
  view.append(tabBar(REPLY_TABS.map(([v, text]) => ({ id: v, text, count: counts(v), cls: v === "new" ? "" : v === "ignored" ? "discarded" : "potential" })), tab, (v) => { location.hash = `#/replies${v === "new" ? "" : `?v=${v}`}`; }));
  const shown = d.messages.filter((m) => m.status === tab);
  if (!shown.length) view.append(h("div", { class: "empty" }, tab === "new" ? (d.sync.lastRunAt ? "No new replies." : "Press Check replies to look for answers.") : "Nothing here."));
  shown.forEach((m) => view.append(messageCard(m, repliesView)));
}

const TRACK_STATES = [["applied", "Applied"], ["replied", "Replied"], ["interview", "Interview"], ["offer", "Offer"], ["rejected", "Rejected"], ["no_response", "No response"]];

function manualApplicationForm(refresh) {
  const title = textField("Job title");
  const company = textField("Company");
  const url = textField("Link to the posting (optional)", "", { placeholder: "https://..." });
  const date = textField("Day you applied", new Date().toLocaleDateString("sv-SE"), { type: "date" });
  const how = h("select", {}, [["form", "Through a website or form"], ["email", "By email"]].map(([v, t]) => h("option", { value: v }, t)));
  const status = h("select", {}, TRACK_STATES.map(([v, t]) => h("option", { value: v }, t)));
  const contact = textField("Who it went to, if by email (optional)", "", { placeholder: "name@company.com" });
  const notes = textField("Notes (optional)", "", { placeholder: "e.g. referred by Sam, applied on their site" });
  return h("div", { class: "card" },
    h("h2", {}, "Add an application I made myself"),
    h("div", { class: "muted" }, "Record jobs you applied for by hand, for example before you used this tool. They are never found or applied for twice, and replies from the address you give are matched."),
    h("div", { class: "row" }, title.el, company.el),
    h("div", { class: "row" }, url.el, date.el),
    h("div", { class: "row" }, h("div", { class: "field" }, h("label", {}, "How you applied"), how), h("div", { class: "field" }, h("label", {}, "Where it stands now"), status), contact.el),
    notes.el,
    h("div", { class: "row mt" }, h("button", { class: "primary", onclick: act(async () => {
      await api("POST", "/api/tracker", { title: title.get(), company: company.get(), url: url.get(), appliedOn: date.get(), how: how.value, status: status.value, contactEmail: contact.get(), notes: notes.get() });
      showNote("Recorded.");
      await refresh();
    }) }, "Add to the tracker")));
}

// Two clicks: this deletes the saved password too, and the user may not be able to get back in without resetting it on the site.
function forgetButton(r) {
  let armed = false;
  const btn = h("button", { class: "danger", title: "Deletes the saved password together with the account", onclick: async () => {
    if (!armed) {
      armed = true;
      btn.textContent = `Click again: delete the saved password for ${r.site} too`;
      setTimeout(() => { armed = false; btn.textContent = "Forget this account and its password"; }, 6000);
      return;
    }
    try { await api("DELETE", `/api/accounts/${r.id}`, {}); await accountsView(); } catch (e) { armed = false; btn.textContent = "Forget this account and its password"; showError(e); }
  } }, "Forget this account and its password");
  return btn;
}

/** Which sites' candidate profiles are known to be finished. Claude skips the profile for those; "Not finished" makes it check again. */
function siteProfilesBox(profiles, redraw) {
  if (!profiles.length) return null;
  return h("div", { class: "card" }, h("h2", {}, "Site profiles"),
    h("div", { class: "hint" }, "A site's profile that is marked complete is not checked or asked for again. If clicking Apply on a site sends Claude back to the profile, it marks it not finished by itself."),
    h("table", { class: "card-table" }, profiles.map((x) => h("tr", {},
      h("td", {}, h("strong", {}, x.site)),
      h("td", { class: "muted" }, x.complete ? `complete (${x.source === "user" ? "you said so" : "Claude saw it"}), ${x.updatedAt.slice(0, 10)}` : `not finished, ${x.updatedAt.slice(0, 10)}`, x.evidence ? h("div", {}, x.evidence) : null),
      h("td", {}, h("button", { onclick: act(async () => { await api("POST", "/api/site-profiles", { site: x.site, complete: !x.complete }); await redraw(); }) }, x.complete ? "Not finished" : "Mark complete"))))));
}

async function accountsView() {
  const [rows, profiles] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/site-profiles")]);
  view.replaceChildren(h("h1", {}, `Accounts (${rows.length})`),
    h("p", { class: "muted" }, "Sites where you have an account made through this tool. The passwords are in your vault and are never shown: copy one when you need it. Passwords stay saved until you forget an account, which deletes its saved password too (the vault must be unlocked) and means you would reset it on the site to get back in."));
  const profilesBox = siteProfilesBox(profiles, accountsView);
  if (profilesBox) view.append(profilesBox);
  if (!rows.length) { view.append(h("div", { class: "empty" }, "No accounts yet. They appear when an application needs one.")); return; }
  view.append(h("table", { class: "card-table" }, rows.map((r) => h("tr", {},
    h("td", {}, h("strong", {}, r.site), h("div", { class: "muted" }, r.username)),
    h("td", { class: "muted" }, r.confirmedAt ? `created ${r.confirmedAt.slice(0, 10)}` : "password saved, account not confirmed", r.verifiedAt ? h("div", {}, "email verified") : null,
      !r.verifiedAt && r.status !== "disabled" ? h("div", {}, h("button", { onclick: async (e) => { e.target.disabled = true; try { const x = await api("POST", "/api/replies/sync", {}); showNote(x.verifications ? `Found ${x.verifications} verification email${x.verifications === 1 ? "" : "s"}: see Needs you.` : "No verification email yet. It can take a minute: try again."); await accountsView(); } catch (err) { e.target.disabled = false; showError(err); } } }, "Look for the verification email")) : null),
    h("td", {}, h("button", { onclick: async () => { try { await api("POST", `/api/accounts/${r.id}/copy`, { what: "username" }); showNote("Copied."); } catch (e) { showError(e); } } }, "Copy email"),
      h("button", { onclick: async () => { try { const x = await api("POST", `/api/accounts/${r.id}/copy`, { what: "password" }); showNote(`Password copied. It leaves the clipboard in ${x.clearsInSeconds} seconds.`); } catch (e) { showError(e); } } }, "Copy password")),
    h("td", {}, profileCommandBox(r.jobId), !r.verifiedAt ? h("button", { onclick: act(() => api("POST", `/api/accounts/${r.id}/verified`, {})) }, "Mark email verified") : null,
      forgetButton(r))))));
}

async function trackerView() {
  const rows = await api("GET", "/api/tracker");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const only = params.get("by") === "hand";
  view.replaceChildren(h("h1", {}, `Tracker (${rows.length})`),
    h("p", { class: "muted" }, "Every application that has gone out: sent by this tool, or recorded by you."),
    manualApplicationForm(trackerView));
  const count = (s) => rows.filter((r) => r.state === s).length;
  view.append(h("p", { class: "muted" }, TRACK_STATES.map(([v, t]) => `${t} ${count(v)}`).join("  ·  ")));
  const byHand = h("input", { type: "checkbox" });
  byHand.checked = only;
  byHand.addEventListener("change", () => { location.hash = `#/tracker${byHand.checked ? "?by=hand" : ""}`; });
  view.append(h("div", { class: "row" }, h("label", {}, byHand, " only the ones I applied for by hand")));
  const shown = rows.filter((r) => !only || r.manual);
  if (!shown.length) { view.append(h("div", { class: "empty" }, only ? "None recorded by hand yet." : "Nothing has gone out yet.")); return; }
  view.append(h("table", { class: "card-table" }, shown.map((r) => {
    const move = r.allowed.length ? h("select", {}, h("option", { value: "" }, "Change status..."), r.allowed.map((s) => h("option", { value: s }, label(s)))) : null;
    if (move) move.addEventListener("change", act(async () => { if (move.value) { await api("POST", `/api/jobs/${r.jobId}/transition`, { to: move.value }); await trackerView(); } }));
    return h("tr", {},
      h("td", {}, h("a", { href: `#/jobs/${r.jobId}` }, r.title), h("span", { class: "muted" }, `  #${r.jobId}`), h("div", { class: "muted" }, r.company || ""),
        r.notes && h("div", { class: "muted" }, r.notes)),
      h("td", { class: "muted" }, r.appliedAt.slice(0, 10), h("div", {}, `${r.daysSince} day${r.daysSince === 1 ? "" : "s"} ago`)),
      h("td", {}, h("span", { class: "badge" }, r.route === "email" ? "email" : "website"), r.manual ? h("span", { class: "badge" }, "by hand") : null),
      h("td", {}, h("span", { class: "badge" }, label(r.state)), r.newReplies ? h("a", { href: "#/replies" }, `  ${r.newReplies} new repl${r.newReplies === 1 ? "y" : "ies"}`) : null),
      h("td", {}, move));
  })));
}

async function emailsView() {
  const list = await api("GET", "/api/emails");
  const waiting = list.filter((e) => e.status === "draft" || e.status === "failed" || e.status === "sending");
  const rest = list.filter((e) => !waiting.includes(e));
  view.replaceChildren(h("h1", {}, "Emails"),
    h("p", { class: "muted" }, "The agent writes drafts. Nothing is sent until you press Send on a draft."));
  const row = (e) => h("div", { class: "card" }, h("div", { class: "row" }, emailBadge(e.status), e.kind === "follow_up" ? h("span", { class: "badge" }, "follow-up") : null,
    h("a", { href: `#/emails/${e.id}` }, e.jobTitle), h("span", { class: "muted" }, `to ${e.contact.email}`)));
  view.append(h("h2", {}, `Waiting for you (${waiting.length})`));
  if (!waiting.length) view.append(h("div", { class: "empty" }, "No drafts waiting."));
  waiting.forEach((e) => view.append(row(e)));
  if (rest.length) { view.append(h("h2", {}, "Earlier")); rest.forEach((e) => view.append(row(e))); }
}

async function emailView(id) {
  const e = await api("GET", `/api/emails/${id}`);
  const editable = e.status === "draft" || e.status === "failed";
  const c = e.contact;
  const subject = textField("Subject", e.subject);
  subject.input.disabled = !editable;
  const body = h("textarea", { class: "tall" });
  body.value = e.bodyText;
  body.disabled = !editable;
  const save = () => api("PUT", `/api/emails/${id}`, { subject: subject.get(), bodyText: body.value });

  let armed = false;
  const sendBtn = h("button", { class: "primary", onclick: async () => {
    if (!armed) {
      armed = true;
      sendBtn.textContent = `Click again to send to ${c.email}${c.verification === "pattern" ? " (derived address)" : ""}`;
      setTimeout(() => { armed = false; sendBtn.textContent = "Send"; }, 6000);
      return;
    }
    try {
      await save();
      const r = await api("POST", `/api/emails/${id}/send`, {});
      await render();
      showNote(r.dryRun ? "Dry run: the message was built and nothing was sent." : "Sent. A copy went to your own address.");
    } catch (err) { armed = false; sendBtn.textContent = "Send"; await render(); showError(err); }
  } }, "Send");

  view.replaceChildren(
    h("p", {}, h("a", { href: "#/emails" }, "← emails")),
    h("h1", {}, e.jobTitle),
    h("div", { class: "row" }, emailBadge(e.status), e.company && h("span", { class: "muted" }, e.company),
      h("a", { href: `#/jobs/${e.jobId}` }, "job page")));

  const where = safeHref(c.sourceUrl)
    ? h("span", {}, "found on ", h("a", { href: safeHref(c.sourceUrl), target: "_blank", rel: "noopener noreferrer" }, c.sourceUrl))
    : h("span", { class: "muted" }, c.sourceUrl);
  view.append(h("div", { class: "card" },
    h("div", {}, "To: ", h("strong", {}, c.email), c.name ? ` (${c.name}${c.role ? ", " + c.role : ""})` : ""),
    h("div", { class: "muted" }, where),
    e.domainMismatch && h("p", { class: "bad" }, `Check this address. It is on a different domain from ${e.company || "the company"}. Make sure it is really where the application should go.`),
    !e.domainMismatch && e.domainUnclear && h("p", { class: "warn" }, "This address could not be compared with the company's website (its domain is not recorded, or it is a free mail address). Check that it belongs to the right person."),
    c.status === "bounced" && h("p", { class: "bad" }, "This address bounced before. Do not send to it."),
    c.browserEvidence && h("p", { class: "warn" },
      c.browserEvidence.rule === "posting_page"
        ? "The agent read the job's own posting in a real browser (the page builds itself, so the server could not see the address) and quoted this line: "
        : "The server could not open the company's page (the site blocks automated requests), so the agent read it in a real browser and quoted this line: ",
      h("em", {}, `“${c.browserEvidence.quote}”`), " on ",
      safeHref(c.browserEvidence.pageUrl) ? h("a", { href: safeHref(c.browserEvidence.pageUrl), target: "_blank", rel: "noopener noreferrer" }, "this page") : "the page",
      ". Open it to check the address before you send."),
    c.verification === "pattern" && c.evidence && h("p", { class: "warn" },
      "This address was derived, not seen on a page. ",
      `The company's address for ${c.evidence.exampleName} is ${c.evidence.exampleEmail} (`,
      safeHref(c.evidence.exampleUrl) ? h("a", { href: safeHref(c.evidence.exampleUrl), target: "_blank", rel: "noopener noreferrer" }, "page") : "page",
      `), which follows the pattern ${c.evidence.pattern}, so the same pattern was applied to ${c.name || "this person"}. It may not exist. Sending is your confirmation.`)));

  if (e.status === "failed") view.append(h("div", { class: "card bad" }, `The last attempt failed: ${e.error || "unknown error"}`));
  view.append(subject.el, h("div", { class: "field" }, h("label", {}, "Message (this is exactly what will be sent)"), body));
  view.append(h("div", { class: "muted" },
    e.kind === "follow_up" ? "A follow-up in the same thread as your application. Nothing is attached." : e.attachment ? h("span", {}, "Attached: your CV for this job ", h("a", { href: `/api/documents/${e.attachment.documentId}/file`, target: "_blank", rel: "noopener noreferrer" }, "(open PDF)"),
      e.coverAttachment ? h("span", {}, "  and your cover letter ", h("a", { href: `/api/documents/${e.coverAttachment.documentId}/file`, target: "_blank", rel: "noopener noreferrer" }, "(open PDF)")) : "") : "No CV attached."));
  if (e.edited) view.append(h("div", { class: "muted" }, "You have edited the agent's draft."));

  const buttons = h("div", { class: "row mt-lg" });
  if (editable) {
    buttons.append(sendBtn,
      h("button", { onclick: act(save) }, "Save edits"),
      confirmButton("Discard", "Click again to discard the draft", async () => { await api("POST", `/api/emails/${id}/discard`, {}); location.hash = "#/emails"; }));
  } else if (e.status === "sent") {
    buttons.append(h("span", { class: "muted" }, `Sent ${e.sentAt || ""}`),
      c.status !== "bounced" && h("button", { class: "danger", title: "Only press this if a delivery-failure message came back for this email. It stops this address from being used again.", onclick: act(() => api("POST", `/api/contacts/${c.id}/bounced`, {})) }, "Mark this address as bounced"),
      c.status !== "bounced" && h("span", { class: "muted" }, "Use this only if you got a delivery-failure message for this email."));
  } else {
    buttons.append(h("span", { class: "muted" }, e.status));
  }
  view.append(buttons);
}

// ---------- vault ----------

const secretInput = (label, hint) => textField(label, "", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: hint || "" });

async function vaultView() {
  const [st, profile] = await Promise.all([api("GET", "/api/vault/status"), api("GET", "/api/profile")]);
  view.replaceChildren(
    h("h1", {}, "Vault"),
    h("p", { class: "muted" }, "Passwords you type here are encrypted with your passphrase. The agent can never read them, and this page never shows a saved password again."),
    h("div", { class: "card" }, h("strong", {}, "Never paste a password or passphrase into a chat with Claude. "), "Type it only into this page."));

  if (!st.exists) {
    const a = secretInput("Choose a passphrase (at least 12 characters)");
    const b = secretInput("Type it again");
    view.append(h("h2", {}, "Create your vault"),
      h("div", { class: "card" }, h("p", { class: "muted" }, "There is no way to recover a forgotten passphrase. If you forget it you delete the vault and enter your passwords again, which costs nothing but a few minutes."),
        a.el, b.el,
        h("button", { class: "primary", onclick: act(async () => {
          if (a.get() !== b.get()) throw new Error("The two passphrases are different");
          await api("POST", "/api/vault/create", { passphrase: a.get() });
        }) }, "Create vault")));
    return;
  }

  if (!st.unlocked) {
    const p = secretInput("Passphrase");
    view.append(h("h2", {}, "Locked"),
      h("div", { class: "card" }, h("p", { class: "muted" }, "The vault locks every time the dashboard restarts, and after 30 minutes without use."),
        p.el, h("button", { class: "primary", onclick: act(() => api("POST", "/api/vault/unlock", { passphrase: p.get() })) }, "Unlock")));
    return;
  }

  const mail = st.secrets.find((x) => x.name === "mail.smtp");
  const pw = secretInput("App password", "16 letters, with or without spaces");
  view.append(
    h("div", { class: "row" }, h("span", { class: "badge" }, "unlocked"),
      h("button", { onclick: act(() => api("POST", "/api/vault/lock", {})) }, "Lock now")),
    h("h2", {}, "Mail"),
    h("div", { class: "card" },
      h("p", {}, profile && profile.email ? `Emails are sent from ${profile.email}.` : "Set your email address in Settings (About you) first."),
      mail ? h("div", { class: "row" }, h("span", { class: "badge" }, "app password saved"), h("span", { class: "muted" }, `updated ${mail.updatedAt.slice(0, 16).replace("T", " ")}`),
        confirmButton("Remove", "Click again to remove the saved mail login", () => api("DELETE", "/api/vault/secrets/mail.smtp", {})))
        : h("p", { class: "muted" }, "No mail password saved yet."),
      h("details", { class: "my" }, h("summary", {}, "How to get a Gmail app password"),
        h("ol", { class: "muted" },
          h("li", {}, "Open your Google Account, then Security."),
          h("li", {}, "Turn on 2-Step Verification if it is off."),
          h("li", {}, "Open App passwords, name it jobhunt, and copy the 16 characters."),
          h("li", {}, "Paste them below. You can revoke it in Google at any time."))),
      pw.el,
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: act(() => api("PUT", "/api/vault/mail", { password: pw.get() })) }, mail ? "Replace app password" : "Save app password"),
        mail && h("button", { onclick: async () => {
          try {
            const r = await api("POST", "/api/vault/mail/test", {});
            showNote(r.dryRun ? `Dry run: a test message to ${r.sentTo} was built but nothing was sent.` : `Test message sent to ${r.sentTo}. Check your inbox (and spam).`);
          } catch (e) { showError(e); }
        } }, "Send test email to myself"))),
    h("h2", {}, "Passphrase"),
    h("details", { class: "card" }, h("summary", {}, "Change passphrase"), changePassphraseForm()));
}

function changePassphraseForm() {
  const o = secretInput("Current passphrase");
  const n = secretInput("New passphrase (at least 12 characters)");
  return h("div", {}, o.el, n.el,
    h("button", { class: "primary", onclick: act(() => api("POST", "/api/vault/change-passphrase", { old: o.get(), next: n.get() })) }, "Change"));
}

// ---------- settings ----------

/** A comma-separated list with an "Any" switch. Any is saved as an empty list. */
/** Choose any number of options from a fixed list: a dropdown to add one, and a chip to remove each. Nothing can be mistyped. */
function multiPicker(label, options, selected, emptyText) {
  const known = new Map(options);
  const state = [...new Set(selected.map((x) => String(x).toLowerCase()))];
  const box = h("div", { class: "row" });
  const add = h("select", {});
  const draw = () => {
    add.replaceChildren(h("option", { value: "" }, "Add one..."), ...options.filter(([v]) => !state.includes(v)).map(([v, t]) => h("option", { value: v }, t)));
    box.replaceChildren(...state.map((v, i) => h("span", { class: `badge ${known.has(v) ? "info" : "bad"}` },
      known.has(v) ? known.get(v) : `not a level: ${v}`, " ",
      h("button", { class: "close", type: "button", "aria-label": `Remove ${v}`, onclick: () => { state.splice(i, 1); draw(); } }, "×"))),
      ...(state.length ? [] : [h("span", { class: "muted" }, emptyText)]));
  };
  add.addEventListener("change", () => { if (add.value) { state.push(add.value); draw(); } });
  draw();
  return { el: h("div", { class: "field" }, h("label", {}, label), box, h("div", { class: "row mt" }, add)), get: () => state.filter((v) => known.has(v)) };
}

function anyList(label, hint, values) {
  const input = h("input", { placeholder: hint, class: "grow grow-min" });
  input.value = values.join(", ");
  const any = h("input", { type: "checkbox" });
  any.checked = values.length === 0;
  const sync = () => { input.disabled = any.checked; };
  any.addEventListener("change", sync);
  sync();
  return {
    el: h("div", { class: "field" }, h("label", {}, label),
      h("div", { class: "row" }, input, h("label", { class: "muted" }, any, " Any"))),
    get: () => (any.checked ? [] : input.value.split(",").map((x) => x.trim()).filter(Boolean)),
  };
}

function textField(label, value, attrs) {
  const input = h("input", attrs || {});
  input.value = value ?? "";
  return { el: h("div", { class: "field" }, h("label", {}, label), input), get: () => input.value, input };
}

async function settingsView() {
  const [prefs, profile, sources, budget, room] = await Promise.all([
    api("GET", "/api/preferences"), api("GET", "/api/profile"), api("GET", "/api/sources"), api("GET", "/api/budget"), api("GET", "/api/application-count"),
  ]);
  const p = prefs || { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 10 };

  const roles = anyList("Target roles", "Backend Engineer, Data Engineer", p.roles);
  const level = multiPicker("Levels I am looking for", lists.seniorityLevels.map((l) => [l.value, l.label]), p.seniority, "Any level. Pick one or more to narrow it down.");
  const where = anyList("Locations", "Addis Ababa, Remote", p.locations);
  const industries = anyList("Industries", "fintech, health", p.industries);
  const exclusions = textField("Exclude (companies or keywords, comma separated)", (p.exclusions || []).join(", "));
  const remote = h("select", {}, ["any", "remote", "hybrid", "onsite"].map((v) => h("option", { value: v }, v)));
  remote.value = p.remotePolicy;
  const salaryPeriod = h("select", {}, [["", "Per..."], ["month", "per month"], ["year", "per year"]].map(([v, t]) => h("option", { value: v }, t)));
  salaryPeriod.value = p.salaryPeriod || "";
  const floor = textField("Salary floor", p.salaryFloor, { type: "number", min: "0" });
  const target = textField("Target", p.salaryTarget, { type: "number", min: "0" });
  const ceiling = textField("Ceiling", p.salaryCeiling, { type: "number", min: "0" });
  const currency = textField("Currency", p.currency, { placeholder: "USD", size: "6" });
  const discovery = textField("Jobs to process per day", p.dailyDiscoveryLimit, { type: "number", min: "0", max: "200" });
  const applications = textField("Applications per day", p.dailyApplicationLimit, { type: "number", min: "0", max: "100" });

  const researchScore = textField("Search the company's own pages for decision makers when a job scores at least", p.researchMinScore ?? 7, { type: "number", min: "0", max: "10" });
  const researchScope = h("select", {}, [["all", "For every good match"], ["email_only", "Only for jobs that apply by email"], ["off", "Never"]].map(([v, t]) => h("option", { value: v }, t)));
  researchScope.value = p.researchScope || "all";
  const consentDefault = h("select", {}, [["none", "Tick no consent boxes"], ["privacy", "Tick the privacy consent only"], ["required", "Tick all boxes needed to submit"]].map(([v, t]) => h("option", { value: v }, t)));
  consentDefault.value = p.consentDefault || "none";
  const priorityMode = h("select", {}, [["remote_first", "Worldwide remote first"], ["sponsored_first", "Visa-sponsored first"], ["balanced", "Both count the same"]].map(([v, t]) => h("option", { value: v }, t)));
  priorityMode.value = p.priorityMode || "remote_first";
  const batch = textField("Jobs one /tailor or /email run may handle", p.batchSize ?? 10, { type: "number", min: "1", max: "20" });
  const bcc = h("input", { type: "checkbox" });
  bcc.checked = p.bccSelf !== false;
  const anySite = h("input", { type: "checkbox" });
  anySite.checked = p.searchAnySite !== false;

  const countries = orderedPicker("Country priority, best first (work for earlier countries is listed higher on a tailored CV)", lists.countries.map((c) => [c, c]), p.countryPriority || []);
  const employment = orderedPicker("Type of work priority, best first, used after country", lists.employmentTypes.map((t) => [t.value, t.label]), p.employmentPriority || []);
  const guidance = h("textarea", { placeholder: "e.g. Prefer international client work. Keep it to one page when possible. Always show my projects." });
  guidance.value = p.cvGuidance || "";

  const coverLetters = h("select", {}, [["auto", "On: for every email job, and when a form asks for one"], ["off", "Off: only when I ask"]].map(([v, t]) => h("option", { value: v }, t)));
  coverLetters.value = p.coverLetters || "auto";
  const coverGuidance = h("textarea", { placeholder: "e.g. Warm but direct. Lead with my payments work. Never longer than three paragraphs." });
  coverGuidance.value = p.coverGuidance || "";
  const writingStyle = h("textarea", { class: "tall-sm", placeholder: "e.g. Plain and warm, like a message to a colleague. Short sentences. No lists of tools. Start with what I like about their product, not with who I am." });
  writingStyle.value = p.writingStyle || "";

  const cookieBanners = h("select", {}, [["accept", "Accept all cookies, so pages are not blocked"], ["necessary", "Allow only the strictly necessary cookies"]].map(([v, t]) => h("option", { value: v }, t)));
  cookieBanners.value = p.cookieBanners || "accept";
  const skillLevel = h("select", {}, [["", "Ask me each time"], ["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"], ["expert", "Expert"]].map(([v, t]) => h("option", { value: v }, t)));
  skillLevel.value = p.defaultSkillLevel || "";
  const QMODE = [["batch", "Batch: all at the end, in the chat and as cards (recommended)"], ["chat", "Ask me in the chat right away"], ["cards", "Cards in Needs you only"]];
  const questionMode = h("select", {}, QMODE.map(([v, t]) => h("option", { value: v }, t)));
  questionMode.value = p.questionMode || "batch";
  const overrideSelects = lists.questionCategories.map((c) => {
    const sel = h("select", {}, h("option", { value: "" }, "Use my main choice"), QMODE.map(([v, t]) => h("option", { value: v }, t.split(":")[0].replace(" (recommended)", ""))), h("option", { value: "never" }, "Never ask"));
    sel.value = (p.questionOverrides || {})[c.value] || "";
    return { id: c.value, label: c.label, sel };
  });
  const autoReplied = h("input", { type: "checkbox" });
  autoReplied.checked = p.autoMarkReplied !== false;
  const followDays = textField("Suggest a follow-up after (days with no reply)", String(p.followUpDays ?? 7));
  const followMax = textField("Follow-ups per application (0 turns them off)", String(p.maxFollowUps ?? 1));
  const quietDays = textField("Mark as no response after (days, 0 never)", String(p.noResponseDays ?? 21));
  const keepDays = textField("Keep the text of replies for (days)", String(p.replySnippetDays ?? 90));
  const checkEvery = textField("Check for replies by itself every (minutes, 0 only when I press the button)", String(p.replyCheckMinutes ?? 0));

  const savePrefs = act(() => api("PUT", "/api/preferences", {
    searchAnySite: anySite.checked,
    bccSelf: bcc.checked,
    salaryPeriod: salaryPeriod.value || undefined,
    consentDefault: consentDefault.value,
    priorityMode: priorityMode.value,
    researchMinScore: researchScore.get(), researchScope: researchScope.value, batchSize: batch.get(),
    cvGuidance: guidance.value,
    coverLetters: coverLetters.value,
    coverGuidance: coverGuidance.value,
    writingStyle: writingStyle.value,
    cookieBanners: cookieBanners.value,
    defaultSkillLevel: skillLevel.value || undefined,
    questionMode: questionMode.value,
    questionOverrides: Object.fromEntries(overrideSelects.filter((o) => o.sel.value).map((o) => [o.id, o.sel.value])),
    autoMarkReplied: autoReplied.checked,
    followUpDays: Number(followDays.get()),
    maxFollowUps: Number(followMax.get()),
    noResponseDays: Number(quietDays.get()),
    replySnippetDays: Number(keepDays.get()),
    replyCheckMinutes: Number(checkEvery.get()),
    countryPriority: countries.get(),
    employmentPriority: employment.get(),
    roles: roles.get(), seniority: level.get(), locations: where.get(), industries: industries.get(),
    exclusions: exclusions.get().split(",").map((x) => x.trim()).filter(Boolean),
    remotePolicy: remote.value,
    salaryFloor: floor.get(), salaryTarget: target.get(), salaryCeiling: ceiling.get(), currency: currency.get(),
    dailyDiscoveryLimit: discovery.get(), dailyApplicationLimit: applications.get(),
  }));

  view.replaceChildren(
    h("h1", {}, "Settings"),
    h("h2", {}, "What you are looking for"),
    h("div", { class: "card" }, roles.el, level.el, where.el,
      h("div", { class: "field" }, h("label", {}, "Remote policy"), remote),
      industries.el, exclusions.el,
      h("div", { class: "field" }, h("label", {}, anySite, " Search any site: Google and company career pages, as well as the sites listed below. Untick to search only the listed sites.")),
      h("div", { class: "field" }, h("label", {}, bcc, " Send me a copy (BCC) of every email I send")),
      h("h2", {}, "Research and batches"),
      h("div", { class: "row" }, researchScore.el, h("div", { class: "field" }, h("label", {}, "Research"), researchScope), batch.el),
      h("div", { class: "field" }, h("label", {}, "Which jobs come first when tailoring, emailing and filling forms"), priorityMode,
        h("div", { class: "muted" }, "Remote only counts when the posting lets someone in your country work from there. Sponsorship counts more when the posting says it, less when only a sponsor register lists the company.")),
      h("div", { class: "field" }, h("label", {}, "When I press Apply on a job with a form, the choice starts as"), consentDefault,
        h("div", { class: "muted" }, "You can change it each time you press Apply. Optional boxes (marketing, talent pool, sharing your data) are never ticked.")),
      h("div", { class: "row" }, floor.el, target.el, ceiling.el, currency.el, h("div", { class: "field" }, h("label", {}, "Unit"), salaryPeriod)),
      countries.el, employment.el,
      h("div", { class: "field" }, h("label", {}, "How my CVs should be built (the agent follows this when tailoring)"), guidance),
      h("div", { class: "field" }, h("label", {}, "Cover letters"), coverLetters,
        h("div", { class: "muted" }, "When on, the agent writes one for each email job (attached with your CV) and for any form that has a cover letter field. Every claim must rest on your facts.")),
      h("div", { class: "field" }, h("label", {}, "How everything written for me should sound"), writingStyle,
        h("div", { class: "hint" }, "Used for emails, cover letters and free-text answers on forms. Claude also follows a built-in writing guide, and your words here come first.")),
      h("div", { class: "field" }, h("label", {}, "How my cover letters should read"), coverGuidance),
      h("div", { class: "field" }, h("label", {}, "Cookie banners on the sites the agent visits"), cookieBanners,
        h("div", { class: "muted" }, "Accepting cookies lets pages load without a banner in the way. This is only about cookies: it never ticks the consent boxes inside an application form.")),
      h("div", { class: "field" }, h("label", {}, "Skill level for a skill I have not given one, when a site asks for it"), skillLevel,
        h("div", { class: "muted" }, "You can set a level on each skill on the CV page. Choosing a default here means every skill without its own level is given that one. Leave it on Ask me if you would rather say each time.")),
      h("h2", {}, "When Claude needs an answer only I can give"),
      h("div", { class: "field" }, h("label", {}, "How it asks"), questionMode,
        h("div", { class: "hint" }, "Batch: Claude fills everything it can, then sends one message with every open question and also files them as cards. You answer once and it finishes while the page is still open. In a long run over several jobs, asking right away becomes one batch at the end.")),
      h("div", { class: "card" }, h("strong", {}, "A different way for one kind of question"),
        overrideSelects.map((o) => h("div", { class: "row my-sm" }, h("span", { class: "grow" }, o.label), o.sel)),
        h("div", { class: "hint" }, "Never ask: Claude uses your default if there is one (for skill levels) or leaves it blank and lists it.")),
      h("h2", {}, "Replies and follow-ups"),
      h("div", { class: "field" }, h("label", {}, autoReplied, " When someone answers an email of mine directly (same thread), move the job to replied by itself"),
        h("div", { class: "muted" }, "Other matches are only suggested. A rejection or an interview is always your decision.")),
      h("div", { class: "row" }, followDays.el, followMax.el, quietDays.el),
      h("div", { class: "row" }, keepDays.el, checkEvery.el),
      h("h2", {}, "Daily limits"),
      h("div", { class: "muted" }, `Today: ${budget.addedToday} of ${budget.limit} jobs added.`),
      h("div", { class: "row" }, discovery.el, applications.el),
      h("div", { class: "row" },
        h("div", { class: "muted grow" }, `Applications today: ${room.used} of ${room.limit} used or waiting. The count only stops Claude from starting a new form; a form already filled is always saved.`),
        confirmButton("Reset today's count", "Click again: start the count from zero", () => api("POST", "/api/application-count/reset", {}))),
      h("div", { class: "row mt-lg" }, h("button", { class: "primary", onclick: savePrefs }, "Save search settings"))));

  // sources
  const kind = h("select", {}, [["jobsite", "job site"], ["careers_page", "company careers page"], ["email_contact", "email contact"]].map(([v, t]) => h("option", { value: v }, t)));
  const name = h("input", { placeholder: "name, e.g. remoteok.com" });
  const url = h("input", { placeholder: "https://... (optional)", class: "grow grow-min" });
  view.append(
    h("h2", {}, "Sites to search"),
    h("div", { class: "muted" }, "Sites you list here are always searched when switched on. With \"Search any site\" ticked above, the agent also uses Google and company career pages. Sites it finds on its own show as agent-added and are not searched until you add them."),
    h("div", { class: "card" }, h("div", { class: "row" }, kind, name, url,
      h("button", { class: "primary", onclick: act(() => api("POST", "/api/sources", { kind: kind.value, name: name.value, url: url.value })) }, "Add"))),
    ...sources.map((src) => h("div", { class: "card" }, h("div", { class: "row" },
      h("span", { class: "badge" }, src.kind.replaceAll("_", " ")),
      h("strong", {}, src.name),
      src.addedBy === "agent" && h("span", { class: "badge gap" }, "agent-added"),
      safeHref(src.url) && h("a", { href: safeHref(src.url), target: "_blank", rel: "noopener noreferrer" }, "open"),
      h("button", { onclick: act(() => api("POST", `/api/sources/${src.id}/enabled`, { enabled: !src.enabled })) }, src.enabled ? "On: click to turn off" : "Off: click to turn on")))));


  // standard answers
  const sa = await api("GET", "/api/standard-answers");
  const saLabel = h("input", { placeholder: "question, e.g. How did you hear about us?", class: "grow grow-min" });
  const saAnswer = h("input", { placeholder: "your answer", class: "grow grow-min" });
  const quick = ["Equity preference", "Minimum salary: how firm is it?", "Preferred company size", "Job search status", "How did you hear about us?", "Gender", "Race or ethnicity", "Disability status", "Veteran status", "Are you willing to relocate?", "Are you legally authorized to work in the country of the job?"];
  view.append(h("h2", {}, "Standard answers"),
    h("div", { class: "muted" }, "Your own answers to questions forms keep asking, including demographic ones. The agent uses them word for word, and never guesses one for you. A question with no saved answer is left for you."),
    h("div", { class: "row" }, quick.map((q) => h("button", { onclick: () => { saLabel.value = q; saAnswer.focus(); } }, q))),
    h("div", { class: "card" }, h("div", { class: "row" }, saLabel, saAnswer,
      h("button", { class: "primary", onclick: act(() => api("PUT", "/api/standard-answers", { label: saLabel.value, answer: saAnswer.value })) }, "Save"))),
    ...sa.map((x) => h("div", { class: "card" }, h("div", { class: "row" }, h("strong", { class: "grow" }, x.label), h("span", {}, x.answer),
      confirmButton("Delete", "Click again to delete", () => api("DELETE", `/api/standard-answers/${x.id}`, {}))))));

  // profile
  const name2 = textField("Full name", profile?.fullName);
  const email = textField("Email", profile?.email, { type: "email" });
  const phone = textField("Phone", profile?.phone);
  const loc = textField("Where you live", profile?.location);
  const links = textField("Links (comma separated)", (profile?.links || []).join(", "));
  const auth = textField("Work authorization", profile?.workAuthorization, { placeholder: "e.g. citizen, needs sponsorship" });
  const sponsor = h("select", {}, [["", "Not said yet"], ["yes", "Yes, I need a visa sponsored"], ["no", "No, I do not"]].map(([v, t]) => h("option", { value: v }, t)));
  sponsor.value = profile?.requiresSponsorship === true ? "yes" : profile?.requiresSponsorship === false ? "no" : "";
  const notice = textField("Notice period", profile?.noticePeriod, { placeholder: "e.g. 1 month" });
  const langs = textField("Languages (comma separated)", (profile?.languages || []).join(", "));
  const list = (f) => f.get().split(",").map((x) => x.trim()).filter(Boolean);
  view.append(
    h("h2", {}, "About you"),
    h("div", { class: "card" }, name2.el, email.el, phone.el, loc.el, links.el, auth.el,
      h("div", { class: "field" }, h("label", {}, "Do you need a visa sponsored?"), sponsor,
        h("div", { class: "muted" }, profile?.inferredSponsorship
          ? `Not said yet, but your work authorization text says you ${profile.inferredSponsorship.value ? "need" : "do not need"} sponsorship, so forms are answered ${profile.inferredSponsorship.value ? "Yes" : "No"}. Pick it here to make it exact.`
          : "Forms ask this. The agent answers from this setting, and leaves the question blank if it is not said.")),
      notice.el, langs.el,
      h("div", { class: "row mt-lg" }, h("button", { class: "primary", onclick: act(() => api("PUT", "/api/profile", {
        fullName: name2.get(), email: email.get(), phone: phone.get(), location: loc.get(), links: list(links),
        workAuthorization: auth.get(), requiresSponsorship: sponsor.value === "yes" ? true : sponsor.value === "no" ? false : null, noticePeriod: notice.get(), languages: list(langs),
      })) }, "Save profile"))));
}

// ---------- routing ----------

let lists = null;
let currentPrefs = null;

async function render() {
  const [, page, arg] = location.hash.split("?")[0].split("/");
  view.classList.add("is-loading");
  view.setAttribute("aria-busy", "true");
  document.title = `${({ pipeline: "Pipeline", jobs: "Job", cv: "CV", facts: "Facts", applications: "Forms", emails: "Emails", replies: "Replies", tracker: "Tracker", accounts: "Accounts", companies: "Companies", vault: "Vault", settings: "Settings" })[page] || "Needs you"} · jobhunt`;
  let queueCount = 0;
  let repliesNew = 0;
  try {
    lists ||= await api("GET", "/api/lists");
    currentPrefs = await api("GET", "/api/preferences");
    if (page === "pipeline") await pipelineView();
    else if (page === "jobs") await jobView(Number(arg));
    else if (page === "cv") await cvView();
    else if (page === "facts") await factsView();
    else if (page === "applications") await (arg ? applicationView(Number(arg)) : applicationsView());
    else if (page === "emails") await (arg ? emailView(Number(arg)) : emailsView());
    else if (page === "replies") await repliesView();
    else if (page === "tracker") await trackerView();
    else if (page === "accounts") await accountsView();
    else if (page === "companies") await companiesView();
    else if (page === "vault") await vaultView();
    else if (page === "settings") await settingsView();
    else queueCount = await queueView();
    if (page) queueCount = (await api("GET", "/api/actions")).length;
    repliesNew = (await api("GET", "/api/replies")).newCount;
  } catch (e) {
    view.replaceChildren(h("div", { class: "error" }, String(e.message || e)));
  }
  const link = (href, text, active, count) => h("a", { href, class: `nav-link${active ? " active" : ""}`, "aria-current": active ? "page" : undefined },
    h("span", {}, text), count ? h("span", { class: "pill" }, String(count)) : null);
  const group = (title, ...links) => h("div", { class: "nav-group" }, title ? h("div", { class: "nav-title" }, title) : null, ...links);
  nav.replaceChildren(
    group("Work",
      link("#/", "Needs you", !page, queueCount),
      link("#/pipeline", "Pipeline", page === "pipeline" || page === "jobs"),
      link("#/tracker", "Tracker", page === "tracker")),
    group("Find", link("#/companies", "Companies", page === "companies")),
    group("Apply",
      link("#/applications", "Forms", page === "applications"),
      link("#/emails", "Emails", page === "emails"),
      link("#/replies", "Replies", page === "replies", repliesNew),
      link("#/accounts", "Accounts", page === "accounts")),
    group("Your material",
      link("#/cv", "CV", page === "cv"),
      link("#/facts", "Facts", page === "facts")),
    group("System",
      link("#/settings", "Settings", page === "settings"),
      link("#/vault", "Vault", page === "vault")));
  view.classList.remove("is-loading");
  view.removeAttribute("aria-busy");
}

window.addEventListener("hashchange", render);
render();
