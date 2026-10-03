"use strict";
// All data shown here can come from the internet (job titles, descriptions, URLs).
// Elements are built with textContent only, never innerHTML, so page text cannot run as script.

const view = document.getElementById("view");
const nav = document.getElementById("nav");

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
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
      h("td", {}, h("a", { href: `#/jobs/${j.id}` }, j.title), h("div", { class: "muted" }, j.company || "")),
      h("td", { class: "muted" }, j.matchScore !== undefined ? `${j.matchScore}` : ""),
      h("td", { class: "muted" }, j.source || "")))));
  }
}

async function jobView(id) {
  const d = await api("GET", `/api/jobs/${id}`);
  const j = d.job;
  view.replaceChildren(...[
    h("p", {}, h("a", { href: "#/pipeline" }, "← pipeline")),
    h("h1", {}, j.title),
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
  for (const doc of d.documents) {
    view.append(h("div", { class: "card" },
      h("div", { class: "row" }, h("span", { class: "badge" }, `${doc.kind} v${doc.version}`), h("span", { class: "muted" }, doc.path)),
      doc.blocks.map((b) => h("p", { class: b.kind === "boilerplate" ? "muted" : "" }, b.text,
        b.factIds.length ? h("span", { class: "muted" }, `  [facts ${b.factIds.join(", ")}]`) : null))));
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

  const savePrefs = act(() => api("PUT", "/api/preferences", {
    searchAnySite: anySite.checked,
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

async function render() {
  const [, page, arg] = location.hash.split("/");
  let queueCount = 0;
  try {
    if (page === "pipeline") await pipelineView();
    else if (page === "jobs") await jobView(Number(arg));
    else if (page === "facts") await factsView();
    else if (page === "settings") await settingsView();
    else queueCount = await queueView();
    if (page) queueCount = (await api("GET", "/api/actions")).length;
  } catch (e) {
    view.replaceChildren(h("div", { class: "error" }, String(e.message || e)));
  }
  nav.replaceChildren(
    h("a", { href: "#/", class: !page ? "active" : "" }, `Needs you${queueCount ? ` (${queueCount})` : ""}`),
    h("a", { href: "#/pipeline", class: page === "pipeline" || page === "jobs" ? "active" : "" }, "Pipeline"),
    h("a", { href: "#/facts", class: page === "facts" ? "active" : "" }, "Facts"),
    h("a", { href: "#/settings", class: page === "settings" ? "active" : "" }, "Settings"));
}

window.addEventListener("hashchange", render);
render();
