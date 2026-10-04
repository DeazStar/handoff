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
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

function actionCard(a) {
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

async function pipelineView() {
  const jobs = await api("GET", "/api/jobs");
  view.replaceChildren(h("h1", {}, `Pipeline (${jobs.length})`));
  if (jobs.length === 0) view.append(h("div", { class: "empty" }, "No jobs yet."));
  const byState = {};
  for (const j of jobs) (byState[j.state] ||= []).push(j);
  for (const [state, list] of Object.entries(byState)) {
    view.append(h("h2", {}, `${label(state)} (${list.length})`));
    view.append(h("table", {}, list.map((j) => h("tr", {},
      h("td", {}, h("a", { href: `#/jobs/${j.id}` }, j.title), h("span", { class: "muted" }, `  #${j.id}`), h("div", { class: "muted" }, j.company || "")),
      h("td", { class: "muted" }, j.matchScore !== undefined ? `${j.matchScore}` : ""),
      h("td", { class: "muted" }, j.source || "")))));
  }
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
    j.matchReason && h("p", {}, `Match ${j.matchScore ?? ""}: ${j.matchReason}`),
    j.stateReason && h("p", { class: "muted" }, `Last change: ${j.stateReason}`),
  ].filter(Boolean));

  const gaps = d.actions.filter((a) => a.kind === "gap");
  if (gaps.length) { view.append(h("h2", {}, "Gaps")); gaps.forEach((a) => view.append(gapCard(a))); }
  const others = d.actions.filter((a) => a.kind !== "gap");
  if (others.length) { view.append(h("h2", {}, "Waiting on you")); others.forEach((a) => view.append(actionCard(a))); }

  if (d.allowedTransitions.length) {
    view.append(h("h2", {}, "Move this job"),
      h("div", { class: "row" }, d.allowedTransitions.map((to) =>
        h("button", { onclick: act(() => api("POST", `/api/jobs/${id}/transition`, { to })) }, label(to)))));
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
      h("button", { class: "primary", onclick: act(() => api("PUT", "/api/vault/mail", { password: pw.get() })) }, mail ? "Replace app password" : "Save app password")),
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
  const floor = textField("Salary floor", p.salaryFloor, { type: "number", min: "0" });
  const target = textField("Target", p.salaryTarget, { type: "number", min: "0" });
  const ceiling = textField("Ceiling", p.salaryCeiling, { type: "number", min: "0" });
  const currency = textField("Currency", p.currency, { placeholder: "USD", size: "6" });
  const discovery = textField("Jobs to process per day", p.dailyDiscoveryLimit, { type: "number", min: "0", max: "200" });
  const applications = textField("Applications per day", p.dailyApplicationLimit, { type: "number", min: "0", max: "100" });

  const anySite = h("input", { type: "checkbox" });
  anySite.checked = p.searchAnySite !== false;

  const countries = orderedPicker("Country priority, best first (work for earlier countries is listed higher on a tailored CV)", lists.countries.map((c) => [c, c]), p.countryPriority || []);
  const employment = orderedPicker("Type of work priority, best first, used after country", lists.employmentTypes.map((t) => [t.value, t.label]), p.employmentPriority || []);
  const guidance = h("textarea", { placeholder: "e.g. Prefer international client work. Keep it to one page when possible. Always show my projects." });
  guidance.value = p.cvGuidance || "";

  const savePrefs = act(() => api("PUT", "/api/preferences", {
    searchAnySite: anySite.checked,
    cvGuidance: guidance.value,
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
      h("div", { class: "row" }, floor.el, target.el, ceiling.el, currency.el),
      countries.el, employment.el,
      h("div", { class: "field" }, h("label", {}, "How my CVs should be built (the agent follows this when tailoring)"), guidance),
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

  // profile
  const name2 = textField("Full name", profile?.fullName);
  const email = textField("Email", profile?.email, { type: "email" });
  const phone = textField("Phone", profile?.phone);
  const loc = textField("Where you live", profile?.location);
  const links = textField("Links (comma separated)", (profile?.links || []).join(", "));
  const auth = textField("Work authorization", profile?.workAuthorization, { placeholder: "e.g. citizen, needs sponsorship" });
  const notice = textField("Notice period", profile?.noticePeriod, { placeholder: "e.g. 1 month" });
  const langs = textField("Languages (comma separated)", (profile?.languages || []).join(", "));
  const list = (f) => f.get().split(",").map((x) => x.trim()).filter(Boolean);
  view.append(
    h("h2", {}, "About you"),
    h("div", { class: "card" }, name2.el, email.el, phone.el, loc.el, links.el, auth.el, notice.el, langs.el,
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "primary", onclick: act(() => api("PUT", "/api/profile", {
        fullName: name2.get(), email: email.get(), phone: phone.get(), location: loc.get(), links: list(links),
        workAuthorization: auth.get(), noticePeriod: notice.get(), languages: list(langs),
      })) }, "Save profile"))));
}

// ---------- routing ----------

let lists = null;

async function render() {
  const [, page, arg] = location.hash.split("/");
  let queueCount = 0;
  try {
    lists ||= await api("GET", "/api/lists");
    if (page === "pipeline") await pipelineView();
    else if (page === "jobs") await jobView(Number(arg));
    else if (page === "cv") await cvView();
    else if (page === "facts") await factsView();
    else if (page === "vault") await vaultView();
    else if (page === "settings") await settingsView();
    else queueCount = await queueView();
    if (page) queueCount = (await api("GET", "/api/actions")).length;
  } catch (e) {
    view.replaceChildren(h("div", { class: "error" }, String(e.message || e)));
  }
  nav.replaceChildren(
    h("a", { href: "#/", class: !page ? "active" : "" }, `Needs you${queueCount ? ` (${queueCount})` : ""}`),
    h("a", { href: "#/pipeline", class: page === "pipeline" || page === "jobs" ? "active" : "" }, "Pipeline"),
    h("a", { href: "#/cv", class: page === "cv" ? "active" : "" }, "CV"),
    h("a", { href: "#/facts", class: page === "facts" ? "active" : "" }, "Facts"),
    h("a", { href: "#/vault", class: page === "vault" ? "active" : "" }, "Vault"),
    h("a", { href: "#/settings", class: page === "settings" ? "active" : "" }, "Settings"));
}

window.addEventListener("hashchange", render);
render();
