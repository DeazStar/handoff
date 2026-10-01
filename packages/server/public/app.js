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

// ---------- routing ----------

async function render() {
  const [, page, arg] = location.hash.split("/");
  let queueCount = 0;
  try {
    if (page === "pipeline") await pipelineView();
    else if (page === "jobs") await jobView(Number(arg));
    else if (page === "facts") await factsView();
    else queueCount = await queueView();
    if (page) queueCount = (await api("GET", "/api/actions")).length;
  } catch (e) {
    view.replaceChildren(h("div", { class: "error" }, String(e.message || e)));
  }
  nav.replaceChildren(
    h("a", { href: "#/", class: !page ? "active" : "" }, `Needs you${queueCount ? ` (${queueCount})` : ""}`),
    h("a", { href: "#/pipeline", class: page === "pipeline" || page === "jobs" ? "active" : "" }, "Pipeline"),
    h("a", { href: "#/facts", class: page === "facts" ? "active" : "" }, "Facts"));
}

window.addEventListener("hashchange", render);
render();
