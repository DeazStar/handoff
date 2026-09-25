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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    // The server accepts only JSON on anything that changes data, so a POST with nothing to say still sends {}.
    headers: method === "GET" && body === undefined ? {} : { "content-type": "application/json" },
    body: method === "GET" && body === undefined ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showNote(text) {
  const box = h("div", { class: "card" }, text);
  view.prepend(box);
  setTimeout(() => box.remove(), 12000);
}

function showError(e) {
  const box = h("div", { class: "error" }, String(e.message || e));
  view.prepend(box);
  setTimeout(() => box.remove(), 6000);
}

const act = (fn) => async () => {
  try { await fn(); await render(); } catch (e) { showError(e); }
};

const label = (s) => s.replaceAll("_", " ");


/** One click gets the right command onto the clipboard. A web page cannot start a Claude session itself. */
function goButton(job) {
  if (job.state !== "matched" && job.state !== "materials_ready") return null;
  const next = job.state === "matched"
    ? "tailor the CV, then draft the email or fill the form"
    : job.route === "email" ? "draft the email" : job.route === "form" ? "fill the form" : "nothing more to do";
  const forForm = job.route !== "email";
  const consent = h("select", { title: "What the agent may tick on the form for this run only. It never ticks optional boxes such as marketing." },
    [["none", "tick no consent boxes"], ["privacy", "tick the privacy consent only"], ["required", "tick all boxes needed to submit"]].map(([v, t]) => h("option", { value: v }, t)));
  consent.value = (currentPrefs && currentPrefs.consentDefault) || "none";
  const btn = h("button", { class: "primary", title: "Copies the command to paste into Claude", onclick: async () => {
    const word = !forForm || consent.value === "none" ? "" : consent.value === "privacy" ? " consent" : " consent all";
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

async function queueView() {
  const items = await api("GET", "/api/actions");
  view.replaceChildren(h("h1", {}, `Needs you (${items.length})`));
  if (items.length === 0) view.append(h("div", { class: "empty" }, "Nothing waiting. The agent has no open questions."));
  for (const a of items) view.append(a.kind === "gap" ? gapCard(a) : actionCard(a));
  return items.length;
}

function jobLink(a) {
  return a.jobId ? h("a", { href: `#/jobs/${a.jobId}` }, a.jobTitle || `Job ${a.jobId}`) : h("span", { class: "muted" }, "no job");
}

// The password is made and copied by the server. It is never shown here and never sent to Claude.
function signupCard(a) {
  const p = a.payload;
  const card = h("div", { class: "card" });
  const draw = async () => {
    const [accounts, profile] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/profile")]);
    const mine = accounts.find((x) => x.site === p.site);
    const login = p.mode === "login" || (mine && mine.confirmedAt);
    const copy = (id, what) => h("button", { onclick: async () => { try { const r = await api("POST", `/api/accounts/${id}/copy`, { what }); showNote(what === "password" ? `Password copied. It leaves the clipboard in ${r.clearsInSeconds} seconds.` : "Copied."); } catch (e) { showError(e); } } }, what === "password" ? "Copy password" : "Copy email");
    const rules = p.passwordRules ? [p.passwordRules.minLength && `at least ${p.passwordRules.minLength} characters`, p.passwordRules.maxLength && `at most ${p.passwordRules.maxLength}`, p.passwordRules.symbols === false && "no special characters"].filter(Boolean).join(", ") : "";
    const rows = [
      h("div", { class: "row" }, h("span", { class: "badge" }, login ? "log in" : "create an account"), a.jobId ? jobLink(a) : null, h("strong", {}, p.site),
        safeHref(p.applyUrl) ? h("a", { href: safeHref(p.applyUrl), target: "_blank", rel: "noopener noreferrer" }, "the page") : null),
      h("div", { class: "muted" }, login ? "Claude found the login page. It cannot type the password: you do." : "Claude stops here: it never creates accounts and never sees a password. You make it, then run the job again."),
      p.fields && p.fields.length ? h("div", { class: "muted" }, `The page asks for: ${p.fields.join(", ")}`) : null,
      rules ? h("div", { class: "muted" }, `Password rules on that page: ${rules}`) : null,
    ];
    if (!mine) {
      rows.push(h("div", { class: "row", style: "margin-top:8px" },
        h("button", { class: "primary", onclick: async () => { try { await api("POST", "/api/accounts/start", { site: p.site, pageUrl: p.applyUrl, passwordRules: p.passwordRules, jobId: a.jobId || undefined }); await draw(); } catch (e) { showError(e); } } }, "Make a password"),
        h("span", { class: "muted" }, `A random 20-character password is saved in your vault for ${p.site}. The account email is ${profile && profile.email ? profile.email : "(set your email in the profile)"}.`)));
    } else {
      rows.push(h("div", { class: "row", style: "margin-top:8px" }, copy(mine.id, "username"), copy(mine.id, "password"),
        h("span", { class: "muted" }, "Paste each into the form yourself, tick the terms, solve any CAPTCHA, and press the site's own button.")));
      rows.push(h("div", { class: "row", style: "margin-top:8px" },
        h("button", { class: "primary", onclick: act(async () => { if (login) await api("POST", `/api/actions/${a.id}/resolve`, { status: "done" }); else await api("POST", `/api/accounts/${mine.id}/confirm`, {}); }) }, login ? "I am logged in" : "I created the account"),
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
      h("div", { class: "row", style: "margin-top:8px" }, h("a", { href: `#/applications/${a.jobId}` }, "Review the application")));
  }
  if (a.kind === "approve_email" && a.payload && a.payload.emailId) {
    return h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, "approve email"), jobLink(a)),
      h("div", { class: "muted" }, `To: ${a.payload.to}`),
      h("div", { class: "muted" }, `Subject: ${a.payload.subject}`),
      h("div", { class: "row", style: "margin-top:8px" }, h("a", { href: `#/emails/${a.payload.emailId}` }, "Review the draft")));
  }
  if (a.kind === "signup_needed" && a.payload && a.payload.site) return signupCard(a);
  if (a.kind === "follow_up" && a.jobId) {
    const why = (a.payload || {}).reason;
    const dismiss = h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss");
    if (why === "no_reply") {
      return h("div", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "badge" }, "no reply yet"), jobLink(a)),
        h("div", { class: "muted" }, `Your email went out ${a.payload.days} days ago and nobody has answered.`),
        h("div", { class: "row", style: "margin-top:8px" },
          h("button", { class: "primary", onclick: async () => { try { const r = await api("POST", `/api/jobs/${a.jobId}/follow-up`, {}); location.hash = `#/emails/${r.emailId}`; } catch (e) { showError(e); } } }, "Draft a follow-up"), dismiss));
    }
    if (why === "bounce") {
      return h("div", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "badge gap" }, "email bounced"), jobLink(a)),
        h("div", { class: "muted" }, `Your email to ${a.payload.to} was not delivered. Find another contact for this company.`),
        h("div", { class: "row", style: "margin-top:8px" }, h("a", { href: `#/jobs/${a.jobId}` }, "Open the job"), dismiss));
    }
    return h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, "check the portal"), jobLink(a)),
      h("div", { class: "muted" }, `You applied ${a.payload.days} days ago${a.payload.byHand ? " by hand" : " through a form"} and nothing has come back. Look at the company's site or your email for news.`),
      h("div", { class: "row", style: "margin-top:8px" }, dismiss));
  }
  const details = Object.entries(a.payload || {}).map(([k, v]) =>
    h("div", { class: "muted" }, `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, label(a.kind)), jobLink(a)),
    details,
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "primary", onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "done" })) }, "Done"),
      h("button", { onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Dismiss")));
}

function gapCard(a) {
  const g = a.payload || {};
  const draft = g.suggestedFact || { kind: "skill", text: "" };
  const text = h("textarea", {}, draft.text || "");
  text.value = draft.text || "";
  const confirm = (scope) => act(() => api("POST", `/api/actions/${a.id}/confirm-gap`, {
    scope, fact: { kind: draft.kind, text: text.value, dateRange: draft.dateRange },
  }));
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge gap" }, "gap"), g.importance && h("span", { class: "badge" }, label(g.importance)), jobLink(a)),
    h("p", {}, `The job asks for: ${g.requirement || ""}`),
    g.detail && h("div", { class: "muted" }, g.detail),
    g.closestFactIds && g.closestFactIds.length > 0 && h("div", { class: "muted" }, `Closest facts: ${g.closestFactIds.join(", ")}`),
    h("p", { class: "muted" }, "If this is true, state it below (edit the wording and any numbers). Nothing is saved until you click."),
    text,
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "primary", onclick: confirm("job") }, "True: use for this job only"),
      h("button", { onclick: confirm("general") }, "True: add to my profile"),
      h("button", { class: "danger", onclick: act(() => api("POST", `/api/actions/${a.id}/resolve`, { status: "dismissed" })) }, "Skip this gap")));
}

const SCOPE_TEXT = { worldwide: "remote, worldwide", open_to_me: "remote, open to you" };
const SPONSOR_TEXT = { confirmed: "sponsors visas", likely: "on a sponsor register" };

function signalBadges(j) {
  return [
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
    h("div", { class: "row", style: "margin-top:8px" }, check, copy, h("label", {}, go, " also fill each application (it still stops for your review)")),
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
    view.append(h("table", {}, list.map((j) => h("tr", {},
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
  if (gaps.length) { view.append(h("h2", {}, "Gaps")); gaps.forEach((a) => view.append(gapCard(a))); }
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
        h("div", { style: "white-space:pre-wrap;margin-top:8px" }, posting.description)));
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
  view.append(h("details", { style: "margin:6px 0" }, h("summary", { class: "muted" }, "Add a contact myself"),
    h("div", { class: "row" }, cEmail, cName,
      h("button", { class: "primary", onclick: act(() => api("POST", `/api/jobs/${id}/contacts`, { email: cEmail.value, name: cName.value })) }, "Add"))));
  if ((d.emails || []).length) {
    view.append(h("h2", {}, "Emails"));
    for (const e of d.emails) view.append(h("div", { class: "row" }, emailBadge(e.status), h("a", { href: `#/emails/${e.id}` }, `to ${e.contact.email}`)));
  }

  view.append(h("h2", {}, "Link checks"));
  view.append(d.verifications.length
    ? h("table", {}, d.verifications.map((v) => h("tr", {}, h("td", {}, v.checked_at), h("td", {}, v.result), h("td", { class: "muted" }, v.evidence || ""))))
    : h("div", { class: "muted" }, "None yet."));

  view.append(h("h2", {}, "Documents"));
  if (!d.documents.length) view.append(h("div", { class: "muted" }, "None yet."));
  const docCard = (doc) => h("div", { class: "card" },
    h("div", { class: "row" }, h("span", { class: "badge" }, `${doc.kind} v${doc.version}`), h("span", { class: "muted" }, doc.path),
      doc.path.toLowerCase().endsWith(".pdf") && h("a", { href: `/api/documents/${doc.id}/file`, target: "_blank", rel: "noopener noreferrer" }, "Open PDF"),
      h("button", { class: "danger", onclick: act(async () => {
        if (!confirm(`Delete ${doc.kind} v${doc.version} and its file? This cannot be undone.`)) return;
        await api("DELETE", `/api/documents/${doc.id}`, {});
      }) }, "Delete")),
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
  view.append(h("table", {}, d.events.map((e) => h("tr", {},
    h("td", { class: "muted" }, e.at), h("td", {}, e.actor), h("td", {}, label(e.type))))));
}

async function factsView() {
  const facts = await api("GET", "/api/facts");
  const kind = h("select", {}, ["experience", "skill", "achievement", "education", "cert"].map((k) => h("option", { value: k }, k)));
  const text = h("textarea", { placeholder: "A true statement about you. Include real numbers and dates." });
  const range = h("input", { placeholder: "dates (optional)" });
  const note = h("input", { placeholder: "where this is documented (optional)" });
  view.replaceChildren(
    h("h1", {}, `Facts (${facts.length})`),
    h("div", { class: "card" }, h("div", { class: "row" }, kind, range, note), text,
      h("div", { class: "row", style: "margin-top:8px" },
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
        h("button", { class: "danger", onclick: act(() => api("DELETE", `/api/facts/${f.id}`, {})) }, "Delete"))));
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
  const row = h("div", { class: "row", style: "align-items:flex-start;margin:4px 0;flex-wrap:nowrap" });
  const show = () => {
    row.replaceChildren(
      h("span", { style: "flex:1" }, "• " + b.text),
      h("button", { onclick: edit }, "Edit"),
      h("button", { class: "danger", onclick: act(() => api("DELETE", `/api/facts/${b.id}`, {})) }, "Delete"));
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
      h("strong", { style: "flex:1" }, e.title),
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/move`, { direction: "up" })) }, "↑"),
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/move`, { direction: "down" })) }, "↓"),
      h("button", { class: "danger", onclick: act(() => api("DELETE", `/api/cv/entries/${e.id}`, {})) }, "Delete")),
    meta && h("div", { class: "muted" }, meta),
    e.note && h("div", { class: "muted" }, e.note),
    !e.startDate && e.kind === "work" && h("div", { class: "muted", style: "color:var(--warn)" }, "No dates yet. Edit this entry to add them."),
    h("details", { style: "margin:8px 0" }, h("summary", { class: "muted" }, "Edit details"),
      entryForm(e.kind, e, (body) => api("PUT", `/api/cv/entries/${e.id}`, body))));
  if (e.kind !== "education") {
    for (const b of e.bullets) card.append(bulletRow(b));
    const t = h("textarea", { placeholder: "Add a bullet: one true statement, with real numbers" });
    card.append(h("div", { style: "margin-top:6px" }, t,
      h("button", { onclick: act(() => api("POST", `/api/cv/entries/${e.id}/bullets`, { text: t.value })) }, "Add bullet")));
  }
  return card;
}

function skillGroupCard(g) {
  const input = h("input", { style: "flex:1;min-width:200px" });
  input.value = g.skills.map((s) => s.text).join(", ");
  return h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, g.group), input,
    h("button", { class: "primary", onclick: act(() => api("PUT", "/api/cv/skills", { group: g.group, items: input.value.split(",") })) }, "Save"),
    h("button", { class: "danger", onclick: act(() => api("PUT", "/api/cv/skills", { group: g.group, items: [] })) }, "Remove group")));
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
  view.append(h("h2", {}, "Skills"));
  const gname = h("input", { placeholder: "Group, e.g. Backend" });
  const gitems = h("input", { placeholder: "Skills, comma separated", style: "flex:1;min-width:200px" });
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
      ...state.map((v, i) => h("div", { class: "row", style: "margin:2px 0" },
        h("span", { class: "badge" }, String(i + 1)),
        h("span", { style: "flex:1" }, text(v)),
        h("button", { onclick: () => { if (i > 0) { [state[i - 1], state[i]] = [state[i], state[i - 1]]; draw(); } } }, "↑"),
        h("button", { onclick: () => { if (i < state.length - 1) { [state[i + 1], state[i]] = [state[i], state[i + 1]]; draw(); } } }, "↓"),
        h("button", { class: "danger", onclick: () => { state.splice(i, 1); draw(); } }, "Remove"))),
      h("div", { class: "row" }, add));
  };
  add.addEventListener("change", () => { if (add.value) { state.push(add.value); draw(); } });
  draw();
  return {
    el: h("div", { class: "field" }, h("label", {}, label), box,
      dropped.length > 0 && h("div", { class: "muted", style: "color:var(--warn)" }, `Not recognised and removed: ${dropped.join(", ")}. Save to keep the cleaned list.`)),
    get: () => [...state],
  };
}




// ---------- applications (forms) ----------

const statusBadge = (st) => h("span", { class: `badge${st === "prepared" ? " gap" : ""}` }, st === "prepared" ? "waiting for you" : st);

async function applicationsView() {
  const list = await api("GET", "/api/applications");
  const waiting = list.filter((a) => a.status === "prepared");
  const rest = list.filter((a) => a.status !== "prepared");
  view.replaceChildren(h("h1", {}, "Applications"),
    h("p", { class: "muted" }, "Forms the agent filled in and left open for you. Nothing is submitted until you click Submit on the site yourself."));
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
      safeHref(a.formUrl) && h("p", {}, h("a", { href: safeHref(a.formUrl), target: "_blank", rel: "noopener noreferrer" }, "Open the form in a new tab"), h("span", { class: "muted" }, "  (a new tab will not have the agent's entries; use its own tab)"))));
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
  view.append(h("table", {}, a.answers.map((x) => h("tr", {},
    h("td", { class: "muted", style: "width:40%" }, x.question),
    h("td", { style: "white-space:pre-wrap" }, x.answer.length > 400 ? `${x.answer.slice(0, 400)}...` : x.answer,
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
    view.append(h("div", { class: "row", style: "margin-top:12px" }, done,
      h("button", { class: "danger", onclick: act(async () => { await api("POST", `/api/applications/${jobId}/discard`, {}); location.hash = "#/applications"; }) }, "Discard")));
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
      busy(e, "Looking for career pages, a few at a time. This can take a minute...");
      try {
        const r = await api("POST", "/api/companies/find-careers", { limit: 40 });
        note.textContent = `Looked at ${r.checked}: ${r.found} career pages found, ${r.none} with none, ${r.needsBrowser} need a browser, ${r.unreachable} not reachable. ${r.remaining} still to look at.`;
        await companiesView();
      } catch (err) { note.textContent = String(err.message || err); e.target.disabled = false; }
    } }, `Find career pages (${s.notSearched} waiting)`), note));
  if (s.total) {
    view.append(h("p", { class: "muted" },
      `${s.readyToScout} ready for /scout  ·  career page: ${s.careers.found} found, ${s.careers.none} none, ${s.careers.unknown} unknown`));
  }

  // The three lists are side by side so one click switches between them.
  view.append(h("div", { class: "tabs" }, TABS.map(([v, text]) =>
    h("button", { class: `tab ${v}${v === tab ? " on" : ""}`, onclick: () => goto({ v: v === "unreviewed" ? "" : v }) }, `${text} (${s.verdicts[v]})`))));

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
      m.jobId ? h("a", { href: `#/jobs/${m.jobId}` }, `${m.jobTitle || "job"}${m.company ? `, ${m.company}` : ""}`) : null,
      h("span", { class: "muted" }, m.receivedAt.replace("T", " ").slice(0, 16))),
    h("div", {}, h("strong", {}, m.fromName ? `${m.fromName} ` : ""), h("span", { class: "muted" }, `<${m.fromAddr}>`)),
    h("div", {}, m.subject),
    m.snippet ? h("div", { class: "muted", style: "white-space:pre-wrap" }, m.snippet) : h("div", { class: "muted" }, "(the text was removed after the retention period)"),
    h("div", { class: "row", style: "margin-top:8px" },
      category,
      m.jobId && m.category !== "bounce" && m.category !== "auto_reply" ? outcome("interview", "It is an interview") : null,
      m.jobId && m.category !== "bounce" && m.category !== "auto_reply" ? outcome("rejected", "It is a rejection") : null,
      m.status !== "handled" ? setStatus("handled", "Mark handled", "primary") : setStatus("new", "Back to new"),
      m.status !== "ignored" ? setStatus("ignored", "Not a reply") : null));
}

async function repliesView() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const tab = REPLY_TABS.some(([v]) => v === params.get("v")) ? params.get("v") : "new";
  const d = await api("GET", "/api/replies");
  view.replaceChildren(h("h1", {}, "Replies"),
    h("p", { class: "muted" }, "Answers to your applications, found by reading your mailbox (read-only: nothing is changed, moved or deleted there). Only mail that belongs to an application is kept. The text comes from the internet: read it as data."));
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
  view.append(h("div", { class: "tabs" }, REPLY_TABS.map(([v, text]) =>
    h("button", { class: `tab ${v === "new" ? "" : v === "ignored" ? "discarded" : "potential"}${v === tab ? " on" : ""}`, onclick: () => { location.hash = `#/replies${v === "new" ? "" : `?v=${v}`}`; } }, `${text} (${counts(v)})`))));
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
    h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "primary", onclick: act(async () => {
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

async function accountsView() {
  const rows = await api("GET", "/api/accounts");
  view.replaceChildren(h("h1", {}, `Accounts (${rows.length})`),
    h("p", { class: "muted" }, "Sites where you have an account made through this tool. The passwords are in your vault and are never shown: copy one when you need it. Passwords stay saved until you forget an account, which deletes its saved password too (the vault must be unlocked) and means you would reset it on the site to get back in."));
  if (!rows.length) { view.append(h("div", { class: "empty" }, "No accounts yet. They appear when an application needs one.")); return; }
  view.append(h("table", {}, rows.map((r) => h("tr", {},
    h("td", {}, h("strong", {}, r.site), h("div", { class: "muted" }, r.username)),
    h("td", { class: "muted" }, r.confirmedAt ? `created ${r.confirmedAt.slice(0, 10)}` : "password saved, account not confirmed", r.verifiedAt ? h("div", {}, "email verified") : null),
    h("td", {}, h("button", { onclick: async () => { try { await api("POST", `/api/accounts/${r.id}/copy`, { what: "username" }); showNote("Copied."); } catch (e) { showError(e); } } }, "Copy email"),
      h("button", { onclick: async () => { try { const x = await api("POST", `/api/accounts/${r.id}/copy`, { what: "password" }); showNote(`Password copied. It leaves the clipboard in ${x.clearsInSeconds} seconds.`); } catch (e) { showError(e); } } }, "Copy password")),
    h("td", {}, !r.verifiedAt ? h("button", { onclick: act(() => api("POST", `/api/accounts/${r.id}/verified`, {})) }, "Mark email verified") : null,
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
  view.append(h("table", {}, shown.map((r) => {
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
  const body = h("textarea", { style: "min-height:340px" });
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
      "The server could not open the company's page (the site blocks automated requests), so the agent read it in a real browser and quoted this line: ",
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

  const buttons = h("div", { class: "row", style: "margin-top:12px" });
  if (editable) {
    buttons.append(sendBtn,
      h("button", { onclick: act(save) }, "Save edits"),
      h("button", { class: "danger", onclick: act(async () => { await api("POST", `/api/emails/${id}/discard`, {}); location.hash = "#/emails"; }) }, "Discard"));
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
        h("button", { class: "danger", onclick: act(() => api("DELETE", "/api/vault/secrets/mail.smtp", {})) }, "Remove"))
        : h("p", { class: "muted" }, "No mail password saved yet."),
      h("details", { style: "margin:8px 0" }, h("summary", {}, "How to get a Gmail app password"),
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
function anyList(label, hint, values) {
  const input = h("input", { placeholder: hint, style: "flex:1;min-width:200px" });
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
  const [prefs, profile, sources, budget] = await Promise.all([
    api("GET", "/api/preferences"), api("GET", "/api/profile"), api("GET", "/api/sources"), api("GET", "/api/budget"),
  ]);
  const p = prefs || { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 10 };

  const roles = anyList("Target roles", "Backend Engineer, Data Engineer", p.roles);
  const level = anyList("Level", "junior, mid, senior", p.seniority);
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

  const cookieBanners = h("select", {}, [["accept", "Accept all cookies, so pages are not blocked"], ["necessary", "Allow only the strictly necessary cookies"]].map(([v, t]) => h("option", { value: v }, t)));
  cookieBanners.value = p.cookieBanners || "accept";
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
    cookieBanners: cookieBanners.value,
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
      h("div", { class: "field" }, h("label", {}, "How my cover letters should read"), coverGuidance),
      h("div", { class: "field" }, h("label", {}, "Cookie banners on the sites the agent visits"), cookieBanners,
        h("div", { class: "muted" }, "Accepting cookies lets pages load without a banner in the way. This is only about cookies: it never ticks the consent boxes inside an application form.")),
      h("h2", {}, "Replies and follow-ups"),
      h("div", { class: "field" }, h("label", {}, autoReplied, " When someone answers an email of mine directly (same thread), move the job to replied by itself"),
        h("div", { class: "muted" }, "Other matches are only suggested. A rejection or an interview is always your decision.")),
      h("div", { class: "row" }, followDays.el, followMax.el, quietDays.el),
      h("div", { class: "row" }, keepDays.el, checkEvery.el),
      h("h2", {}, "Daily limits"),
      h("div", { class: "muted" }, `Today: ${budget.addedToday} of ${budget.limit} jobs added.`),
      h("div", { class: "row" }, discovery.el, applications.el),
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "primary", onclick: savePrefs }, "Save search settings"))));

  // sources
  const kind = h("select", {}, [["jobsite", "job site"], ["careers_page", "company careers page"], ["email_contact", "email contact"]].map(([v, t]) => h("option", { value: v }, t)));
  const name = h("input", { placeholder: "name, e.g. remoteok.com" });
  const url = h("input", { placeholder: "https://... (optional)", style: "flex:1;min-width:200px" });
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
  const saLabel = h("input", { placeholder: "question, e.g. How did you hear about us?", style: "flex:1;min-width:200px" });
  const saAnswer = h("input", { placeholder: "your answer", style: "flex:1;min-width:200px" });
  const quick = ["How did you hear about us?", "Gender", "Race or ethnicity", "Disability status", "Veteran status", "Are you willing to relocate?", "Are you legally authorized to work in the country of the job?"];
  view.append(h("h2", {}, "Standard answers"),
    h("div", { class: "muted" }, "Your own answers to questions forms keep asking, including demographic ones. The agent uses them word for word, and never guesses one for you. A question with no saved answer is left for you."),
    h("div", { class: "row" }, quick.map((q) => h("button", { onclick: () => { saLabel.value = q; saAnswer.focus(); } }, q))),
    h("div", { class: "card" }, h("div", { class: "row" }, saLabel, saAnswer,
      h("button", { class: "primary", onclick: act(() => api("PUT", "/api/standard-answers", { label: saLabel.value, answer: saAnswer.value })) }, "Save"))),
    ...sa.map((x) => h("div", { class: "card" }, h("div", { class: "row" }, h("strong", { style: "flex:1" }, x.label), h("span", {}, x.answer),
      h("button", { class: "danger", onclick: act(() => api("DELETE", `/api/standard-answers/${x.id}`, {})) }, "Delete")))));

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
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "primary", onclick: act(() => api("PUT", "/api/profile", {
        fullName: name2.get(), email: email.get(), phone: phone.get(), location: loc.get(), links: list(links),
        workAuthorization: auth.get(), requiresSponsorship: sponsor.value === "yes" ? true : sponsor.value === "no" ? false : null, noticePeriod: notice.get(), languages: list(langs),
      })) }, "Save profile"))));
}

// ---------- routing ----------

let lists = null;
let currentPrefs = null;

async function render() {
  const [, page, arg] = location.hash.split("?")[0].split("/");
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
  nav.replaceChildren(
    h("a", { href: "#/", class: !page ? "active" : "" }, `Needs you${queueCount ? ` (${queueCount})` : ""}`),
    h("a", { href: "#/pipeline", class: page === "pipeline" || page === "jobs" ? "active" : "" }, "Pipeline"),
    h("a", { href: "#/tracker", class: page === "tracker" ? "active" : "" }, "Tracker"),
    h("a", { href: "#/cv", class: page === "cv" ? "active" : "" }, "CV"),
    h("a", { href: "#/facts", class: page === "facts" ? "active" : "" }, "Facts"),
    h("a", { href: "#/companies", class: page === "companies" ? "active" : "" }, "Companies"),
    h("a", { href: "#/applications", class: page === "applications" ? "active" : "" }, "Forms"),
    h("a", { href: "#/emails", class: page === "emails" ? "active" : "" }, "Emails"),
    h("a", { href: "#/accounts", class: page === "accounts" ? "active" : "" }, "Accounts"),
    h("a", { href: "#/replies", class: page === "replies" ? "active" : "" }, `Replies${repliesNew ? ` (${repliesNew})` : ""}`),
    h("a", { href: "#/vault", class: page === "vault" ? "active" : "" }, "Vault"),
    h("a", { href: "#/settings", class: page === "settings" ? "active" : "" }, "Settings"));
}

window.addEventListener("hashchange", render);
render();
