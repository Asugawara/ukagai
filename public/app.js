// ukagai GUI. Strings that come from outside are inserted with textContent; innerHTML is only for marked / mermaid output.
// Display strings go through t() (i18n.js); the language is read from <html data-lang>.
import { t, applyStatic } from "./i18n.js";

const MULTI_SELECT_SEPARATOR = ", "; // same value as src/contract.ts
const FOLD_LINES = 9;

// Section headings, English first and Japanese alias second. Same content as SECTION in src/hook/explain.ts.
const SECTION = {
  why: ["Why this decision is needed now", "なぜ今この判断が要るか"],
  options: ["Options", "選択肢"],
  recommendation: ["Recommendation", "推奨"],
  diagram: ["Diagram", "図"],
  checked: ["What I checked", "確かめたこと"],
  diff: ["Related diff", "関係する差分"],
  blockerWhy: ["Why I stopped", "なぜ止まったか"],
  blockerTodo: ["What you need to do", "人にしてほしいこと"],
  impact: ["Scope and reversibility", "影響範囲と可逆性"],
};
// Fixed option labels of a blocker (a "(Recommended)" suffix is allowed on the first).
const BLOCKER_LABELS = {
  done: ["Done. Continue", "対応した。続けて"],
  skip: ["Skip this step and continue", "この手順は飛ばして続けて"],
  stop: ["Stop here", "ここで中断"],
};
// Table column detection (header cell text). The first column is always the option label.
const COLUMN_HAPPENS = /happens|outcome|起きること/i;
const COLUMN_RISK = /risk|リスク/i;

const decisions = new Map();
const drafts = new Map(); // id -> { sel: Map<qIndex, Set<label>>, free: Map<qIndex, {on, text}>, rejecting, reason }
let shownId = null;
let ui = null; // controls of the shown decision (for the keyboard)

const $ = (id) => document.getElementById(id);

// Show which build of app.js is running (index.html appends ?v=<version>)
const BUILD = (() => { try { return new URL(import.meta.url).searchParams.get("v") ?? "?"; } catch { return "?"; } })();
const buildTag = () => el("span", { class: "build", text: `build ${BUILD}` });

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---- API ----

function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = false;
}

// While the server is unreachable (SSE error): a red banner and the empty-state text say so; on recovery, a 2-second "Reconnected" toast
let connDown = false;
function renderEmptyText() {
  $("empty-title").textContent = connDown ? t("empty_title_down") : t("empty_title");
  $("empty-sub").textContent = connDown ? t("empty_sub_down", { origin: location.origin }) : t("empty_sub");
}
function setConnDown(down) {
  if (down === connDown) return;
  connDown = down;
  if (down) showBanner(t("cannot_connect", { origin: location.origin }));
  else { $("banner").hidden = true; toast(t("reconnected"), { kind: "ok" }); }
  renderEmptyText();
}

// When the cookie expires after a server restart, refetch GET / to renew it (once, even if called concurrently)
let refreshing = null;
function refreshAuth() {
  refreshing ??= fetch("/", { credentials: "same-origin", cache: "no-store" })
    .then((r) => r.ok, () => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function api(path, init) {
  const go = () => fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  let res = await go();
  if (res.status === 401 && (await refreshAuth())) res = await go();
  if (res.status === 401) {
    showBanner(t("reload_page"));
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

// ---- Sanitizing (for marked output) ----

function sanitize(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/?script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<img\b[^>]*?\ssrc\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]*)[^>]*>/gi, "")
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, "");
}

// Last line of defense after the HTML is materialized: drop every image except data: (including ones that slipped past the regex via entities)
function dropExternalImages(container) {
  for (const img of container.querySelectorAll("img")) {
    const src = (img.getAttribute("src") ?? "").trim();
    if (!/^data:/i.test(src)) img.remove(); // everything but data: (external, relative, same-origin) goes
  }
}

// ---- Display helpers ----

// Plain text for headings (Markdown marks removed)
const plainMd = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[ \t]*#+[ \t]*/, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
const NONE_REASON_KEYS = { loop_guard: "none_loop_guard", plan_mode: "none_plan_mode", not_required: "none_not_required" };

const hasExplanation = (d) => !!d.explanation && d.explanation.attached_via !== "none";

function cwdTail(d) {
  return d.session.cwd.split("/").filter(Boolean).pop() || d.session.cwd;
}

function titleOf(d) {
  const title = rawTitleOf(d);
  return d.kind === "approve_plan" ? plainMd(title) || t("plan_approval") : title;
}

function rawTitleOf(d) {
  let title = d.explanation?.title;
  if (!title && hasExplanation(d) && d.kind === "answer_question") title = parseFrontMatter(d.explanation.markdown).fm.title;
  if (title) return title;
  if (d.kind === "approve_plan") return /^#[ \t]+(.+?)[ \t]*$/m.exec(d.request.plan ?? "")?.[1] ?? t("plan_approval");
  return d.session.title || d.request.questions[0]?.question || t("question");
}

// A decision stopped on work only a human can do (auth, permissions...). explanation.type or the front matter type
function isBlocker(d) {
  const ex = d.explanation;
  if (!ex) return false;
  if (ex.type) return ex.type === "blocker";
  return d.kind === "answer_question" && hasExplanation(d) && parseFrontMatter(ex.markdown).fm.type === "blocker";
}

function reversibilityOf(d) {
  const ex = d.explanation;
  if (!ex) return undefined;
  if (ex.reversibility) return ex.reversibility;
  if (d.kind === "answer_question" && hasExplanation(d)) return parseFrontMatter(ex.markdown).fm.reversibility;
  return undefined;
}

function scopeOf(d) {
  const ex = d.explanation;
  if (!ex) return undefined;
  if (ex.scope) return ex.scope;
  if (d.kind === "answer_question" && hasExplanation(d)) return parseFrontMatter(ex.markdown).fm.scope;
  return undefined;
}

function elapsed(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return t("elapsed_s", { n: sec });
  if (sec < 3600) return t("elapsed_m", { n: Math.floor(sec / 60) });
  return t("elapsed_h", { n: Math.floor(sec / 3600) });
}

function diffBlock(text) {
  const pre = el("pre", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    pre.append(el("span", { class: cls, text: line + "\n" }));
  }
  return pre;
}

const pendingList = () =>
  [...decisions.values()].filter((d) => d.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));

const kindLabel = (d) => (d.kind === "approve_plan" ? t("kind_plan") : t("kind_question"));

// ---- Toasts ----
// Stacked vertically right above the submit button in the right column (on top of the .actions edge), at most 3. Bottom right when nothing is shown
const toastBox = el("div", { class: "toasts", role: "status" });
document.body.append(toastBox);
const TOAST_MAX = 3;
function toast(msg, { kind = "", ms = 2000 } = {}) {
  const box = el("div", { class: `toast ${kind}`.trim(), text: msg });
  toastBox.append(box);
  while (toastBox.children.length > TOAST_MAX) toastBox.firstElementChild.remove();
  setTimeout(() => box.remove(), ms);
}
function placeToasts() {
  const a = document.querySelector("#decision .actions");
  if (a) { if (toastBox.parentElement !== a) a.prepend(toastBox); } else if (toastBox.parentElement !== document.body) document.body.append(toastBox);
  toastBox.classList.toggle("floating", toastBox.parentElement === document.body);
}

const clip = (s, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);
const LOST_KEYS = { answer_lost: "lost_answer_lost", hook_disconnected: "lost_hook_disconnected", cancelled: "lost_cancelled", fallback: "lost_fallback" };
// When the status of a decision that is not shown changes
function notifyBackground(prev, d) {
  if (!prev || prev.status === d.status) return;
  const title = clip(titleOf(d));
  if (d.status === "cancelled" && prev.status === "pending") toast(t("cancelled_title", { title }), { kind: "lost", ms: 4000 });
  else if (LOST_KEYS[d.status]) toast(t(LOST_KEYS[d.status], { title }), { kind: "lost", ms: 4000 });
  else if (d.status === "answered") toast(t("delivered_title", { title }), { kind: "soft" });
}

// ---- Pending button / title ----

// Pending button: fixed top right at 1100px and up, inline at the right end of the right column heading below that
const narrowQuery = matchMedia("(max-width: 1099px)");
// Keep a reference and park it in body before #decision is rebuilt so it is not destroyed
const pendingBtn = $("pending-btn");
const pendingCount = $("pending-count");
function stashPending() { if (pendingBtn.parentElement !== document.body) document.body.prepend(pendingBtn); }
function placePending() {
  const slot = narrowQuery.matches ? document.querySelector("#decision .title-row") : null;
  if (slot) { if (pendingBtn.parentElement !== slot) slot.append(pendingBtn); } else stashPending();
}
narrowQuery.addEventListener("change", placePending);
const titleRow = (title) => el("div", { class: "title-row" }, title);

function renderHeader() {
  const n = pendingList().length;
  pendingCount.textContent = String(n);
  pendingBtn.hidden = n < 2; // with one decision only the shown one exists, so hide it
  document.body.classList.toggle("has-pending-btn", n >= 2);
  const blocked = pendingList().some(isBlocker);
  document.title = n > 0 ? `(${n}) ukagai${blocked ? ` · ${t("title_waiting")}` : ""}` : "ukagai";
}

// Right under the right column title: branch, working directory (full path), reversibility, scope, elapsed time
// branch is the only context field that may be rendered
const tildePath = (p) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

const WT_RE = /\/\.herdr\/worktrees\/([^/]+)\/([^/]+)/;
const repoOf = (d) => WT_RE.exec(d.session.cwd)?.[1] ?? cwdTail(d);
const worktreeOf = (d) => WT_RE.exec(d.session.cwd)?.[2];

// Repository (purple), branch (green), worktree (orange). The color is fixed per kind
function chips(d, cls = "") {
  const box = el("span", { class: `chips ${cls}`.trim() });
  box.append(el("span", { class: "chip repo", text: `◈ ${repoOf(d)}`, title: t("chip_repo") }));
  if (d.context?.branch) box.append(el("span", { class: "chip branch", text: `⎇ ${d.context.branch}`, title: t("chip_branch") }));
  const wt = worktreeOf(d);
  if (wt) box.append(el("span", { class: "chip worktree", text: `⧉ ${wt}`, title: t("chip_worktree") }));
  return box;
}

function metaLine(d) {
  const line = el("div", { class: "meta-line" });
  line.append(chips(d));
  line.append(el("span", { class: "cwd", text: tildePath(d.session.cwd), title: d.session.cwd }));
  const rev = reversibilityOf(d);
  if (rev === "irreversible") line.append(el("span", { class: "badge irreversible", text: t("irreversible") }));
  else if (rev === "costly") line.append(el("span", { class: "badge costly", text: t("costly") }));
  const scope = scopeOf(d);
  if (scope) line.append(el("span", { class: "badge", text: scope }));
  line.append(el("span", { class: "badge age", "data-created": d.created_at, text: elapsed(d.created_at) }));
  return line;
}

// ---- Drawer ----

let drawerIdx = 0;

function focusDrawerRow() {
  const rows = $("pending-list").querySelectorAll(".row");
  drawerIdx = clamp(drawerIdx, rows.length);
  rows[drawerIdx]?.focus();
}

function setDrawer(open) {
  if (open) drawerIdx = Math.max(0, pendingList().findIndex((d) => d.id === shownId));
  else if (drawerOpen()) document.activeElement?.blur?.();
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("backdrop").hidden = !open;
  pendingBtn.setAttribute("aria-expanded", String(open));
  if (!open && document.activeElement === pendingBtn) pendingBtn.blur(); // keep Enter from being swallowed by the pending button
  if (open) focusDrawerRow();
}

const drawerOpen = () => $("drawer").classList.contains("open");

function renderList() {
  const list = $("pending-list");
  list.replaceChildren();
  for (const d of pendingList()) {
    const meta = el("div", { class: "meta" },
      el("span", { text: kindLabel(d) }),
      el("span", { class: "age", "data-created": d.created_at, text: elapsed(d.created_at) }));
    if (isBlocker(d)) meta.append(el("span", { class: "badge blocker", text: t("badge_action") }));
    if (d.kind === "answer_question" && !hasExplanation(d)) meta.append(el("span", { class: "badge none", text: t("badge_no_explanation") }));
    if (d.id === shownId) meta.append(el("span", { class: "badge", text: t("badge_shown") }));
    const row = el("button", {
      class: "row" + (d.id === shownId ? " current" : ""),
      type: "button",
      onclick: () => { show(d.id); setDrawer(false); },
    }, el("div", { class: "title", text: titleOf(d) }), chips(d, "small"), meta);
    list.append(el("li", {}, row));
  }
  if (!list.children.length) list.append(el("li", { class: "muted", text: t("no_pending") }));
  else if (drawerOpen()) focusDrawerRow();
}

// ---- Right column: decision ----

function draftOf(d) {
  let dr = drafts.get(d.id);
  if (!dr) drafts.set(d.id, (dr = { sel: new Map(), free: new Map(), rejecting: false, reason: "", cursor: null }));
  return dr;
}

const STATUS_KEYS = {
  answer_submitted: "status_submitting",
  answered: "status_answered",
  answer_lost: "status_answer_lost",
  hook_disconnected: "status_hook_disconnected",
  fallback: "status_fallback",
  cancelled: "status_cancelled",
};
const statusText = (status, fallbackKey) => t(STATUS_KEYS[status] ?? fallbackKey);

async function send(d, body) {
  document.querySelectorAll("#decision button").forEach((b) => (b.disabled = true));
  try {
    const updated = await post(`/api/decisions/${d.id}/answer`, body);
    decisions.set(updated.id, updated);
    if (shownId === d.id) {
      toast(statusText(updated.status, "sent"));
      advance();
    } else {
      renderHeader();
      renderList();
    }
  } catch (e) {
    if (e.message !== "unauthorized") showBanner(t("send_failed", { message: e.message }));
    if (shownId === d.id) renderRight(decisions.get(d.id));
  }
}

// A raw option that has no row in the explanation table: strip the (Recommended) suffix and show a recommended badge. The answer value stays the original label
const rawItem = (o) => ({ label: stripSuffix(o.label), value: o.label, lines: o.description ? [{ text: o.description }] : [], badge: SUFFIX_RE.test(o.label), pref: SUFFIX_RE.test(o.label) });

const kbd = (t) => el("kbd", { class: "kbd", text: t });
const keyLine = (...parts) => el("div", { class: "keys" }, ...parts.flatMap(([ks, label]) => [...ks.map(kbd), el("span", { text: label })]));
const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));

async function copyCode(pre) {
  try {
    await navigator.clipboard.writeText((pre.textContent ?? "").replace(/\n$/, ""));
    toast(t("copied"));
  } catch {
    toast(t("copy_failed"));
  }
}

// Folding of long recommendations and card bodies (6 / 3 lines in CSS). Only elements that overflow get a "Show all ." chip.
// The expanded state lives in the per-decision draft; `.` or a chip click toggles everything
function toggleExpand(dr) {
  dr.expanded = !dr.expanded;
  const root = $("decision");
  root.classList.toggle("expanded", dr.expanded);
  for (const chip of root.querySelectorAll(".more-chip")) chip.firstChild.textContent = `${dr.expanded ? t("collapse") : t("show_all")} `;
}
function markClamps(root, dr) {
  root.classList.remove("expanded");
  for (const c of root.querySelectorAll(".clampable")) {
    if (c.scrollHeight <= c.clientHeight + 1) continue;
    const host = c.parentElement;
    host.classList.add("has-more");
    if (host.querySelector(".more-chip")) continue;
    host.append(el("button", { class: "more-chip", type: "button", tabindex: "-1", onclick: () => toggleExpand(dr) }, el("span", { text: `${t("show_all")} ` }), kbd(".")));
  }
  if (dr.expanded) { root.classList.add("expanded"); for (const chip of root.querySelectorAll(".more-chip")) chip.firstChild.textContent = `${t("collapse")} `; }
}

function renderRight(d) {
  document.body.append(toastBox); // park it so replaceChildren does not remove it
  renderRightBody(d);
  placeToasts();
  placePending();
  clampMeta();
}

// Show the "Scope and reversibility" section (matched by name, either language) of the plan body in the right column. null when absent.
// The caption is the heading as written in the file
function impactBox(d) {
  const tmp = el("div", { class: "md" });
  tmp.innerHTML = sanitize(window.marked.parse(d.request.plan ?? "", { async: false }));
  dropExternalImages(tmp);
  const sec = findSection(sectionsOf(tmp), SECTION.impact);
  const nodes = sec?.nodes.slice(1) ?? [];
  if (!nodes.some((n) => (n.textContent ?? "").trim())) return null;
  const body = el("div", { class: "clampable impact-body md" }, ...nodes);
  callouts(body);
  softHyphens(body);
  return el("div", { class: "impact" }, el("div", { class: "impact-cap", text: headingText(sec) }), body);
}

// The meta-line wraps. Rows from the third on are hidden and the end becomes …
function clampMeta() {
  for (const line of document.querySelectorAll("#decision .meta-line")) {
    line.querySelector(".meta-more")?.remove();
    const kids = [...line.children];
    for (const k of kids) k.hidden = false;
    const centers = kids.map((k) => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; });
    const rows = [];
    centers.forEach((c, i) => { if (!rows.length || c > centers[rows.at(-1)] + 8) rows.push(i); });
    if (rows.length <= 2) continue;
    let keep = rows[2];
    for (let i = keep; i < kids.length; i++) kids[i].hidden = true;
    const more = el("span", { class: "meta-more", text: "…" });
    line.append(more);
    const rowOf = (y) => rows.filter((r) => centers[r] <= y + 8).length;
    while (keep > 1) {
      const r = more.getBoundingClientRect();
      if (rowOf(r.top + r.height / 2) <= 2) break;
      kids[--keep].hidden = true;
    }
  }
}
window.addEventListener("resize", () => { clampMeta(); refreshWide(); });

function renderRightBody(d) {
  const root = $("decision");
  stashPending();
  root.classList.remove("expanded");
  if (!drawerOpen()) document.activeElement?.blur?.(); // return focus to body so keys are received on document
  root.replaceChildren();
  ui = null;
  if (!d) return;
  const dr = draftOf(d);
  const closed = d.status !== "pending";
  if (STATUS_KEYS[d.status]) root.append(el("div", { class: "status", text: statusText(d.status) }));

  if (d.kind === "answer_question") {
    const qs = d.request.questions;
    const single = qs.length === 1;
    const v2 = single ? modelFor(d).v2 : null;
    const cards = []; // { input, card } when there is one question (for the arrow keys)
    let freeTextEl = null;
    const qsBox = el("div", { class: "qs" });
    qs.forEach((q, qi) => {
      const sel = dr.sel.get(qi) ?? dr.sel.set(qi, new Set()).get(qi);
      const free = dr.free.get(qi) ?? dr.free.set(qi, { on: false, text: "" }).get(qi);
      const box = el("div", { class: "q" });
      let items;
      if (v2) {
        box.append(el("div", { class: "head" },
          isBlocker(d) ? el("div", { class: "blocker-band", text: t("blocker_band") }) : null,
          titleRow(el("div", { class: "v2-title", text: titleOf(d) })), metaLine(d)));
        if (v2.todoBox) box.append(el("div", { class: "todo" }, el("div", { class: "todo-cap", text: v2.todoCap }), v2.todoBox));
        if (v2.recBox) {
          // Callouts (CAUTION / WARNING ...) are exempt from folding. Show them inside the recommendation frame, right under the folded body
          const callouts = [...v2.recBox.querySelectorAll(".callout")].filter((c) => !c.parentElement.closest(".callout"));
          for (const c of callouts) c.remove();
          box.append(el("div", { class: "rec" }, el("div", { class: "rec-cap", text: v2.recCap }), el("div", { class: "rec-main" }, el("div", { class: "clampable rec-body" }, v2.recBox)), callouts.length ? el("div", { class: "md rec-callouts" }, ...callouts) : null));
        }
        items = [
          ...v2.cards.map((c) => ({ label: c.label, value: c.option.label, lines: c.lines, badge: c.recommended, pref: c.recommended })),
          ...v2.extras.map(rawItem),
        ];
        // A blocker without a recommended row starts on the fixed "Done. Continue" option
        if (isBlocker(d) && !items.some((i) => i.pref)) {
          const done = items.find((i) => BLOCKER_LABELS.done.some((n) => sameLabel(i.value, n)));
          if (done) done.pref = true;
        }
      } else {
        const title = titleOf(d);
        // Show title once when it equals the question. When they differ (session.title), show the question under the title
        box.append(el("div", { class: "head" },
          title === q.question ? el("div", { class: "header", text: q.header }) : null,
          titleRow(el("div", { class: "question", text: title })), metaLine(d)));
        if (title !== q.question) box.append(el("div", { class: "header", text: q.header }), el("div", { class: "question", text: q.question }));
        items = q.options.map(rawItem);
      }
      if (single) {
        if (dr.cursor == null) dr.cursor = Math.max(0, items.findIndex((i) => i.pref));
        // For single select, moving = selecting. Pre-select the initial position (the recommended one, else the first)
        if (!closed && !q.multiSelect && sel.size === 0 && !free.on && items.length) sel.add(items[dr.cursor].value);
      }
      if (single) box.append(keyLine([["↑", "↓"], t("hint_move")], [["Enter"], t("hint_answer")], ...(v2?.todoBox?.querySelector("pre") ? [[["c"], t("key_copy_command")]] : []), ...(q.multiSelect ? [[["Space"], t("hint_toggle")]] : [])));
      for (const it of items) {
        const input = el("input", {
          type: q.multiSelect ? "checkbox" : "radio",
          name: `q${qi}`,
          tabindex: "-1",
          disabled: closed,
          checked: sel.has(it.value),
          onchange: (ev) => {
            if (q.multiSelect) ev.target.checked ? sel.add(it.value) : sel.delete(it.value);
            else { sel.clear(); sel.add(it.value); free.on = false; }
            updateSubmit();
          },
        });
        const lab = el("div", { class: "lab" }, el("span", { text: it.label }), it.badge ? el("span", { class: "rec-badge", text: t("recommended") }) : null);
        const card = el("label", { class: "opt" + (it.badge ? " rec" : "") }, input,
          el("span", { class: "grow" }, lab, ...it.lines.map((l) => el("div", { class: (l.muted ? "desc muted" : "desc") + " clampable" }, l.cell ? inlineClone(l.cell) : l.text))));
        if (single) { const idx = cards.length; cards.push({ input, card }); card.addEventListener("click", () => ui?.setCursor(idx, false)); }
        box.append(card);
      }
      const freeInput = el("input", {
        type: q.multiSelect ? "checkbox" : "radio",
        name: `q${qi}`,
        tabindex: "-1",
        disabled: closed,
        checked: free.on,
        onchange: (ev) => {
          free.on = ev.target.checked;
          if (free.on && !q.multiSelect) sel.clear();
          updateSubmit();
        },
      });
      const freeText = el("input", {
        type: "text", class: "free-text", placeholder: t("free_text"), value: free.text, disabled: closed,
        onfocus: () => { if (!free.on) freeInput.click(); },
        oninput: (ev) => { free.text = ev.target.value; updateSubmit(); },
      });
      const freeCard = el("label", { class: "opt free" }, freeInput,
        el("span", { class: "grow" }, el("div", { class: "lab" }, el("span", { text: t("free_text") }), single ? kbd("Enter") : null), freeText));
      if (single) { const idx = cards.length; cards.push({ input: freeInput, card: freeCard }); freeTextEl = freeText; freeCard.addEventListener("click", () => ui?.setCursor(idx, false)); }
      box.append(freeCard);
      qsBox.append(box);
    });
    root.append(qsBox);
    const complete = () => qs.every((_, qi) => {
      const f = dr.free.get(qi);
      if (f.on) return f.text.trim() !== "";
      return (dr.sel.get(qi)?.size ?? 0) > 0;
    });
    const submit = el("button", {
      class: "btn primary", type: "button", id: "submit", disabled: closed || !complete(),
      onclick: () => {
        const answers = {};
        qs.forEach((q, qi) => {
          const sel = dr.sel.get(qi);
          // Answer with the original option.label (not the table's rendering)
          const picked = q.options.map((o) => o.label).filter((l) => sel.has(l));
          const f = dr.free.get(qi);
          if (f.on && !q.multiSelect) picked.length = 0;
          if (f.on) picked.push(f.text.trim());
          answers[q.question] = picked.join(MULTI_SELECT_SEPARATOR);
        });
        send(d, { answers });
      },
    }, el("span", { text: t("answer") }), kbd("Enter"));
    function updateSubmit() { submit.disabled = closed || !complete(); }
    const actions = el("div", { class: "actions" }, submit);
    if (single) {
      actions.append(el("div", { class: "hint" }, `↑↓ ${t("hint_move")} · ${qs[0].multiSelect ? `Space ${t("hint_toggle")} · ` : ""}Enter ${t("hint_answer")} · ${v2?.todoBox?.querySelector("pre") ? `c ${t("hint_copy")} · ` : ""}←→ ${t("hint_next")} · Esc ${t("hint_back")}`, " ", buildTag()));
    }
    root.append(actions);
    const multi = !!qs[0].multiSelect && single;
    ui = {
      kind: "question", cards, multi, submit, closed, freeText: freeTextEl,
      copy: v2?.todoBox?.querySelector("pre") ? () => copyCode(v2.todoBox.querySelector("pre")) : null,
      setCursor(i, select) {
        if (!cards.length) return;
        i = clamp(i, cards.length);
        dr.cursor = i;
        cards.forEach((c, k) => c.card.classList.toggle("cursor", k === i));
        cards[i].card.scrollIntoView({ block: "nearest" });
        if (select && !multi && !closed) cards[i].input.click();
      },
      get cursor() { return dr.cursor ?? 0; },
      toggleExpand: () => toggleExpand(dr),
    };
    if (single && !closed) ui.setCursor(dr.cursor, false);
    markClamps(root, dr);
    return;
  }

  // approve_plan
  const qsBox = el("div", { class: "qs" },
    el("div", { class: "head" }, titleRow(el("div", { class: "v2-title", text: titleOf(d) })), metaLine(d)),
    el("div", { class: "plan-q", text: t("plan_question") }));
  const impact = impactBox(d);
  if (impact) qsBox.append(impact);
  root.append(qsBox);
  const approve = el("button", { class: "btn primary", type: "button", disabled: closed, onclick: () => send(d, { approve: true, set_mode_auto: false }) }, el("span", { text: t("approve") }), kbd("y"));
  const auto = el("button", { class: "btn", type: "button", disabled: closed, onclick: () => send(d, { approve: true, set_mode_auto: true }) }, el("span", { text: t("approve_auto") }), kbd("a"));
  const reject = el("button", { class: "btn danger", type: "button", disabled: closed, onclick: () => startReject(d) }, el("span", { text: t("reject") }), kbd("n"));
  const actions = el("div", { class: "actions" });
  if (dr.rejecting && !closed) {
    const confirm = el("button", {
      class: "btn danger", type: "button", disabled: !dr.reason.trim(), text: t("send_rejection"),
      onclick: () => send(d, { approve: false, reason: dr.reason.trim() }),
    });
    const input = el("input", {
      type: "text", id: "reason", placeholder: t("reject_placeholder"), value: dr.reason,
      oninput: (ev) => { dr.reason = ev.target.value; confirm.disabled = !dr.reason.trim(); },
      onkeydown: (ev) => { if (ev.key === "Enter" && dr.reason.trim()) confirm.click(); },
    });
    actions.append(el("div", { class: "reject-box" }, input), confirm);
  }
  actions.append(approve, auto, reject, el("div", { class: "hint" }, `↑↓ ${t("hint_pick")} · Enter ${t("hint_decide")} · ←→ ${t("hint_next")}`, " ", buildTag()));
  root.append(actions);
  const buttons = [approve, auto, reject];
  ui = {
    kind: "plan", buttons, closed, approve, auto,
    setCursor(i) {
      i = clamp(i, buttons.length);
      dr.cursor = i;
      buttons.forEach((b, k) => b.classList.toggle("cursor", k === i));
    },
    get cursor() { return dr.cursor ?? 0; },
    toggleExpand: () => toggleExpand(dr),
  };
  if (!closed) ui.setCursor(dr.cursor ?? 0);
  markClamps(root, dr);
}

function startReject(d) {
  const dr = draftOf(d);
  dr.rejecting = true;
  dr.cursor = 2;
  renderRight(d);
  $("reason")?.focus();
}

// ---- Markdown / Mermaid / diff ----
// (headings and labels below are matched in both English and Japanese)

function parseFrontMatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { fm, body: md.slice(m[0].length) };
}

let mermaidReady = false;
let mermaidSeq = 0;
function getMermaid() {
  const m = window.mermaid?.default ?? window.mermaid;
  if (m && !mermaidReady) {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    });
    mermaidReady = true;
  }
  return m;
}

async function renderMermaid(codeEl) {
  const pre = codeEl.closest("pre") ?? codeEl;
  const source = codeEl.textContent ?? "";
  const id = `mmd-${++mermaidSeq}`;
  try {
    const m = getMermaid();
    if (!m) throw new Error(t("mermaid_missing"));
    const { svg } = await m.render(id, source);
    const box = el("div", { class: "mermaid-ok" });
    box.innerHTML = svg;
    const el0 = box.querySelector("svg");
    const natural = el0?.viewBox?.baseVal?.width || parseFloat(el0?.style.maxWidth) || 0;
    if (natural) box.dataset.natural = String(natural);
    pre.replaceWith(box);
    refreshWide();
  } catch (e) {
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
    const msg = String(e?.message ?? e).split("\n")[0];
    pre.before(el("div", { class: "mermaid-err", text: t("mermaid_failed", { message: msg }) }));
    pre.textContent = source;
  }
}

// When a diagram's natural width exceeds 1.5x the column width, show a "Full width f" chip above it
const WIDE_RATIO = 1.5;
function refreshWide() {
  const full = document.body.classList.contains("fullwide");
  for (const box of document.querySelectorAll("#background .mermaid-ok")) {
    const natural = Number(box.dataset.natural || 0);
    const wide = full || (natural > 0 && natural > box.clientWidth * WIDE_RATIO && box.clientWidth > 0);
    box.classList.toggle("wide", wide);
    const chip = box.querySelector(".wide-chip");
    if (wide && !chip) box.prepend(el("button", { class: "wide-chip", type: "button", tabindex: "-1", onclick: () => setFullwide(!document.body.classList.contains("fullwide")) }, el("span", { text: `${t("full_width")} ` }), kbd("f")));
    else if (!wide && chip) chip.remove();
    const svg = box.querySelector("svg");
    if (svg) {
      if (full && natural) { svg.style.width = `${natural}px`; svg.style.maxWidth = "none"; svg.style.maxHeight = "none"; }
      else { svg.style.removeProperty("width"); svg.style.removeProperty("max-width"); svg.style.removeProperty("max-height"); }
    }
    const c2 = box.querySelector(".wide-chip");
    if (c2) c2.firstChild.textContent = `${full ? t("back") : t("full_width")} `;
  }
}

// Full-width view (hide the decision column and widen the background). Enter is disabled to prevent accidental submits
const hasWide = () => !!document.querySelector("#background .mermaid-ok.wide");
function setFullwide(on) {
  if (on && !hasWide()) return;
  document.body.classList.toggle("fullwide", on);
  document.activeElement?.blur?.();
  refreshWide();
}

// Fold a pre longer than 9 lines into <details>
function foldLongPre(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.parentElement?.tagName === "DETAILS" && pre.parentElement.classList.contains("fold")) continue;
    const lines = (pre.textContent ?? "").replace(/\n$/, "").split("\n").length;
    if (lines <= FOLD_LINES) continue;
    const det = el("details", { class: "fold" }, el("summary", { text: t("show_code", { n: lines }) }));
    pre.replaceWith(det);
    det.append(pre);
  }
}

// Turn GitHub-style alerts (a blockquote starting with [!NOTE] etc.) into colored boxes. Safe to call repeatedly
const CALLOUTS = { NOTE: ["callout_note", "note"], TIP: ["callout_tip", "tip"], WARNING: ["callout_warning", "warning"], CAUTION: ["callout_caution", "caution"] };
function callouts(container) {
  for (const bq of container.querySelectorAll("blockquote:not(.callout)")) {
    const p = bq.firstElementChild;
    const first = p?.firstChild;
    if (!p || p.tagName !== "P" || first?.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\s*\[!(NOTE|TIP|WARNING|CAUTION)\][ \t]*\n?/i.exec(first.textContent ?? "");
    if (!m) continue;
    const [labelKey, cls] = CALLOUTS[m[1].toUpperCase()];
    first.textContent = first.textContent.slice(m[0].length);
    if (p.firstChild?.nodeName === "BR") p.firstChild.remove();
    if (!p.textContent.trim() && !p.children.length) p.remove();
    bq.classList.add("callout", cls);
    bq.prepend(el("div", { class: "callout-label", text: t(labelKey) }));
  }
}

// Clone a table cell keeping only the decoration (strong / em / code). Other elements keep just their contents
function inlineClone(node) {
  const out = document.createDocumentFragment();
  for (const c of node.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) out.append(c.textContent ?? "");
    else if (c.nodeType === Node.ELEMENT_NODE) {
      const tag = c.tagName.toLowerCase();
      if (tag === "strong" || tag === "em" || tag === "code") {
        const e = document.createElement(tag);
        e.append(inlineClone(c));
        if (tag === "code") hyphenText(e);
        out.append(e);
      } else if (tag === "br") out.append(" ");
      else out.append(inlineClone(c));
    }
  }
  return out;
}

// Words containing `-` in inline code (`--port` etc.) are not broken in the middle. Wrap each in a nowrap span and put <wbr> between words
// (long paths and commands wrap at the column width via overflow-wrap:anywhere). Code inside pre (the copy target) is left alone. textContent is unchanged
function hyphenText(node) {
  const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.includes("-") && !n.parentElement.closest(".nb")) targets.push(n);
  for (const n of targets) {
    const parts = n.textContent.split(/(?<=[^-])(?=-)/);
    if (parts.length < 2 && !parts[0].includes("-")) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((t, i) => {
      if (i > 0) frag.append(document.createElement("wbr"));
      if (t.includes("-")) frag.append(el("span", { class: "nb" }, t));
      else frag.append(t);
    });
    n.replaceWith(frag);
  }
}
// Keep the control character U+2060 out of copied selections (a remnant of earlier rendering; protects the paste target)
document.addEventListener("copy", (e) => {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !e.clipboardData) return;
  const text = sel.toString();
  if (!text.includes("\u2060")) return;
  e.clipboardData.setData("text/plain", text.replaceAll("\u2060", ""));
  e.preventDefault();
});
function softHyphens(root) {
  for (const code of root.querySelectorAll("code")) if (!code.closest("pre")) hyphenText(code);
}

// Apply pre folding, diff and mermaid together (safe to call repeatedly)
async function enhance(container) {
  callouts(container);
  softHyphens(container);
  for (const code of container.querySelectorAll("pre > code.language-diff")) {
    code.closest("pre").replaceWith(diffBlock(code.textContent ?? ""));
  }
  await Promise.all([...container.querySelectorAll("pre > code.language-mermaid")].map(renderMermaid));
  foldLongPre(container);
}

async function renderMarkdown(container, md) {
  container.innerHTML = sanitize(window.marked.parse(md, { async: false }));
  dropExternalImages(container);
  await enhance(container);
}

// ---- Build the decision screen from the v2 explanation file ----

const SUFFIX_RE = /\s*[(（]\s*(recommended|推奨)\s*[)）]\s*$/i;
const stripSuffix = (s) => s.replace(SUFFIX_RE, "");
const normLabel = (s) => stripSuffix(s.normalize("NFKC")).replace(/\s/g, "").toLowerCase();
// Convert the label to text first so a label containing HTML can be compared with a table cell (textContent). DOMParser runs and loads nothing
const labelText = (s) => new DOMParser().parseFromString(s, "text/html").body.textContent ?? s;
const sameLabel = (a, b) => normLabel(a) === normLabel(b) || normLabel(labelText(a)) === normLabel(b);
const normHeading = (s) => s.normalize("NFKC").replace(/\s/g, "").replace(/[と・]/g, "").toLowerCase();
// A section's heading text as written in the file (shown as is in the right column)
const headingText = (sec) => (sec.head.textContent ?? "").trim();

// Split into sections at h1-h3. A section runs up to just before the next heading of the same or shallower level
function sectionsOf(container) {
  const kids = [...container.children];
  const level = (n) => { const m = /^H([1-3])$/.exec(n.tagName); return m ? Number(m[1]) : 0; };
  const secs = [];
  kids.forEach((k, i) => {
    const lv = level(k);
    if (!lv) return;
    let j = i + 1;
    while (j < kids.length && !(level(kids[j]) && level(kids[j]) <= lv)) j++;
    secs.push({ head: k, nodes: kids.slice(i, j), norm: normHeading(k.textContent ?? "") });
  });
  return secs;
}

// names: English first, Japanese alias second. Exact match against all names first, then partial match against all names
function findSection(secs, names) {
  const ns = names.map(normHeading);
  return secs.find((s) => ns.includes(s.norm)) ?? secs.find((s) => ns.some((n) => s.norm.includes(n)));
}

const models = new Map(); // id -> { left, v2 }
const modelFor = (d) => {
  let m = models.get(d.id);
  if (!m) models.set(d.id, (m = buildModel(d)));
  return m;
};

function buildModel(d) {
  const m = { left: null, v2: null };
  if (d.kind !== "answer_question" || !hasExplanation(d)) return m;
  const { fm, body } = parseFrontMatter(d.explanation.markdown);
  const left = el("div", { class: "md" });
  left.innerHTML = sanitize(window.marked.parse(body, { async: false }));
  dropExternalImages(left);
  m.left = left;
  const qs = d.request.questions;
  if (qs.length === 1) {
    const secs = sectionsOf(left);
    const optSec = findSection(secs, SECTION.options);
    let recSec = findSection(secs, SECTION.recommendation);
    if (recSec === optSec) recSec = undefined;
    const table = optSec?.nodes.find((n) => n.tagName === "TABLE") ?? optSec?.nodes.map((n) => n.querySelector?.("table")).find(Boolean);
    const v2 = table ? parseOptionsTable(table, qs[0].options, fm) : null;
    if (v2) {
      if (v2.cards.length) for (const n of optSec.nodes) n.remove(); // if no row matched, leave the table in the left column
      const todoSec = (fm.type === "blocker" || d.explanation.type === "blocker") ? findSection(secs, SECTION.blockerTodo) : undefined;
      if (todoSec && todoSec !== optSec) {
        const todoBox = el("div", { class: "md" });
        v2.todoCap = headingText(todoSec);
        for (const n of todoSec.nodes.slice(1)) todoBox.append(n);
        todoSec.head.remove();
        for (const pre of todoBox.querySelectorAll("pre")) {
          const wrap = el("div", { class: "codewrap" });
          pre.replaceWith(wrap);
          wrap.append(pre, el("button", { class: "copy-btn", type: "button", tabindex: "-1", text: t("copy"), onclick: () => copyCode(pre) }));
        }
        if (todoBox.children.length) { v2.todoBox = todoBox; enhance(todoBox).catch(() => {}); }
      }
      if (recSec) {
        const recBox = el("div", { class: "md" });
        v2.recCap = headingText(recSec);
        for (const n of recSec.nodes.slice(1)) recBox.append(n);
        recSec.head.remove();
        if (recBox.children.length) { v2.recBox = recBox; enhance(recBox).catch(() => {}); }
      }
      m.v2 = v2;
    }
  }
  enhance(left).catch(() => {});
  return m;
}

// Map a table (first column = label) onto options. null when no row matches
function parseOptionsTable(table, options, fm) {
  const trs = [...table.querySelectorAll("tr")];
  if (trs.length < 2) return null;
  const cells = (tr) => [...tr.children].map((c) => (c.textContent ?? "").trim());
  const header = cells(trs[0]);
  const hi = header.findIndex((h) => COLUMN_HAPPENS.test(h));
  const ri = header.findIndex((h) => COLUMN_RISK.test(h));
  const cards = [];
  for (const tr of trs.slice(1)) {
    const row = cells(tr);
    const tds = [...tr.children];
    const o = options.find((o) => sameLabel(o.label, row[0] ?? ""));
    if (!o || cards.some((c) => c.option === o)) continue;
    let lines;
    if (hi >= 0 && ri >= 0) lines = [{ text: row[hi] ?? "", cell: tds[hi] }, { text: row[ri] ?? "", muted: true, cell: tds[ri] }];
    else lines = row.slice(1).map((s, j) => ({ text: s ? `${header[j + 1] ?? ""}: ${s}` : "" })); // old format
    lines = lines.filter((l) => l.text && !/^[-—ー]+$/.test(l.text));
    cards.push({ option: o, label: stripSuffix(row[0]), lines, suffix: SUFFIX_RE.test(row[0]), recommended: false });
  }
  // Keep v2 even when no row matches (every option becomes a raw card)
  const want = fm.recommended ? fm.recommended : null;
  const byFm = want ? cards.filter((c) => sameLabel(c.option.label, want)) : [];
  for (const c of byFm.length ? byFm : cards.filter((c) => c.suffix)) c.recommended = true;
  const extras = options.filter((o) => !cards.some((c) => c.option === o));
  return { cards, extras };
}

// ---- Left column: background ----

function renderLeft(d) {
  const root = $("background");
  root.replaceChildren();
  root.scrollTop = 0;
  if (!d) return;
  const ex = d.explanation;

  if (d.kind === "approve_plan") {
    const plan = el("div", { class: "md" });
    root.append(plan);
    const jobs = [renderMarkdown(plan, d.request.plan ?? "")];
    // The hook puts the plan body into explanation.markdown, so continue only when it differs from the plan
    if (hasExplanation(d) && ex.markdown.trim() !== (d.request.plan ?? "").trim()) {
      const md = el("div", { class: "md" });
      root.append(el("hr"), md);
      jobs.push(renderMarkdown(md, parseFrontMatter(ex.markdown).body));
    }
    return Promise.all(jobs).catch(() => {});
  }
  if (hasExplanation(d)) {
    root.append(modelFor(d).left);
    return;
  }
  const code = ex?.none_reason ?? "";
  const reason = NONE_REASON_KEYS[code] ? t(NONE_REASON_KEYS[code]) : code;
  root.append(el("div", { class: "bg-note", text: reason ? t("no_explanation_reason", { reason }) : t("no_explanation") }));
}

// ---- Switching the view ----

function renderAll() {
  document.body.classList.remove("fullwide");
  const d = decisions.get(shownId);
  $("main").hidden = !d;
  $("empty").hidden = !!d;
  renderHeader();
  renderList();
  const left = renderLeft(d);
  renderRight(d);
  refreshWide();
  left?.then?.(refreshWide);
}

function show(id) {
  shownId = id;
  renderAll();
}

function advance() {
  shownId = pendingList()[0]?.id ?? null;
  renderAll();
}

function upsert(d) {
  const prev = decisions.get(d.id);
  decisions.set(d.id, d);
  if (d.id !== shownId) notifyBackground(prev, d);
  if (d.id === shownId) {
    if (d.status !== "pending") {
      toast(statusText(d.status, "updated"));
      advance();
    } else if (!prev || prev.status !== d.status) {
      renderAll();
    }
    return;
  }
  if (shownId == null && d.status === "pending") {
    show(d.id);
    return;
  }
  renderHeader();
  renderList();
}

async function loadAll() {
  const ds = await api("/api/decisions?status=pending");
  const seen = new Set();
  for (const d of ds) {
    seen.add(d.id);
    if (decisions.has(d.id) && decisions.get(d.id).status !== d.status) upsert(d);
    else decisions.set(d.id, d);
  }
  // Refetch decisions that are still pending locally but changed or vanished (missed SSE events, server restart)
  for (const d of [...decisions.values()]) {
    if (d.status === "pending" && !seen.has(d.id)) {
      try { upsert(await api(`/api/decisions/${d.id}`)); }
      catch (e) {
        if (e.message === "unauthorized") throw e;
        decisions.delete(d.id); // cannot fetch (404 etc.) = gone
        models.delete(d.id);
        drafts.delete(d.id);
      }
    }
  }
  const cur = decisions.get(shownId);
  if (!cur || cur.status !== "pending") advance();
  else { renderHeader(); renderList(); }
}

// SSE. When it drops, renew the cookie and reconnect after 2 s (then doubling, capped at 5 s); sync pending decisions on open
let es = null;
let retryMs = 2000;
let retryTimer = null;
function connect() {
  clearTimeout(retryTimer);
  es?.close();
  es = new EventSource("/api/stream");
  es.addEventListener("decision.created", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("decision.updated", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("open", () => {
    retryMs = 2000;
    if (connDown) setConnDown(false);
    else $("banner").hidden = true;
    loadAll().catch(() => {});
  });
  es.addEventListener("error", () => {
    es.close();
    setConnDown(true);
    const wait = retryMs;
    retryMs = Math.min(5000, retryMs * 2);
    retryTimer = setTimeout(async () => { await refreshAuth(); connect(); }, wait);
  });
}

// ---- Keyboard ----

let lastG = 0; // time of the first g of gg

function cycle(step) {
  const list = pendingList();
  if (list.length < 2) return;
  const i = list.findIndex((d) => d.id === shownId);
  show(list[(i + step + list.length) % list.length].id);
}

// With an IME enabled, keydown has key "Process" and keyCode 229, so the character is lost.
// Outside text fields, decide the bound key from the physical key (code)
const CODE_KEYS = {
  KeyJ: "j", KeyK: "k", KeyH: "h", KeyL: "l", KeyB: "b", KeyI: "i", KeyG: "g", KeyC: "c", KeyY: "y", KeyA: "a", KeyN: "n", KeyF: "f", Period: ".",
  Space: " ", Enter: "Enter", Escape: "Escape", Tab: "Tab",
};
function logicalKey(ev) {
  if (ev.key !== "Process" && ev.keyCode !== 229 && !ev.isComposing) return ev.key;
  const k = CODE_KEYS[ev.code];
  if (k === undefined) return ev.key;
  return k === "g" && ev.shiftKey ? "G" : k;
}

function drawerKey(ev) {
  const key = logicalKey(ev);
  const list = pendingList();
  if (key === "Escape" || key === "b" || key === "ArrowLeft") { ev.preventDefault(); setDrawer(false); }
  else if (key === "ArrowDown" || key === "ArrowUp" || key === "j" || key === "k") {
    ev.preventDefault();
    drawerIdx += key === "ArrowDown" || key === "j" ? 1 : -1;
    focusDrawerRow();
  } else if (key === "Enter") {
    ev.preventDefault();
    const d = list[clamp(drawerIdx, list.length)];
    if (d) show(d.id);
    setDrawer(false);
  } else if (key === "Tab") ev.preventDefault();
}

function cancelReject() {
  const d = decisions.get(shownId);
  draftOf(d).rejecting = false;
  renderRight(d);
}

document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  const typing = t instanceof HTMLInputElement && t.type === "text";
  // Keys during IME composition in a text field go to the input. Outside fields, judge by the physical key even with an IME on (logicalKey)
  if (typing && (ev.isComposing || ev.keyCode === 229)) return;
  if (document.body.classList.contains("fullwide")) {
    const k = logicalKey(ev);
    if (k === "Escape" || k === "f" || k === "Tab") { ev.preventDefault(); setFullwide(false); }
    else if (k === "Enter") ev.preventDefault(); // no submit while full width
    return;
  }
  if (drawerOpen()) { drawerKey(ev); return; }
  const key = logicalKey(ev);
  if (!typing && key === "f" && hasWide()) { ev.preventDefault(); setFullwide(true); return; }
  if (key === "Tab") { ev.preventDefault(); cycle(ev.shiftKey ? -1 : 1); return; }
  if (!typing && (key === "h" || key === "l" || key === "ArrowLeft" || key === "ArrowRight")) {
    ev.preventDefault();
    cycle(key === "l" || key === "ArrowRight" ? 1 : -1);
    return;
  }
  if (!typing && key === "b" && pendingList().length) { ev.preventDefault(); setDrawer(true); return; }
  if (!ui || ui.closed) return;
  const isBtn = t instanceof HTMLButtonElement;

  if (ui.kind === "question") {
    const n = ui.cards.length;
    if (typing) {
      if (key === "Enter") { ev.preventDefault(); if (!ui.submit.disabled) ui.submit.click(); }
      else if (key === "Escape") { ev.preventDefault(); t.blur(); }
      else if (n && (key === "ArrowUp" || key === "ArrowDown")) {
        ev.preventDefault();
        t.blur();
        ui.setCursor(ui.cursor + (key === "ArrowDown" ? 1 : -1), true);
      }
      return;
    }
    if (key === "Enter" && isBtn && t !== ui.submit) return; // leave it to the button's default action
    if (key === " " && isBtn) return;
    if (t instanceof HTMLInputElement) t.blur(); // avoid doubling with the native selection
    const onFree = n > 0 && ui.cursor === n - 1;
    const now = Date.now();
    const gg = key === "g" && now - lastG < 1000;
    lastG = key === "g" && !gg ? now : 0;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "j" || key === "k") {
      if (!n) return;
      ev.preventDefault();
      ui.setCursor(ui.cursor + (key === "ArrowDown" || key === "j" ? 1 : -1), true);
    } else if (gg || key === "G" || key === "Home" || key === "End") {
      if (!n) return;
      ev.preventDefault();
      ui.setCursor(gg || key === "Home" ? 0 : n - 1, true);
    } else if (key === ".") {
      ev.preventDefault();
      ui.toggleExpand();
    } else if (key === "c") {
      if (!ui.copy) return;
      ev.preventDefault();
      ui.copy();
    } else if (key === "i") {
      if (!ui.freeText) return;
      ev.preventDefault();
      ui.setCursor(n - 1, false);
      ui.freeText.focus();
    } else if (key === " ") {
      if (!ui.multi) return;
      ev.preventDefault();
      ui.cards[ui.cursor].input.click();
    } else if (key === "Enter") {
      ev.preventDefault();
      if (onFree && ui.freeText.value.trim() === "") ui.freeText.focus();
      else if (!ui.submit.disabled) ui.submit.click();
    }
    return;
  }

  // Plan
  if (typing) {
    if (key === "Escape") { ev.preventDefault(); cancelReject(); }
    return;
  }
  if (key === "Enter" && isBtn) return;
  if (key === ".") { ev.preventDefault(); ui.toggleExpand(); }
  else if (key === "Escape" && draftOf(decisions.get(shownId)).rejecting) { ev.preventDefault(); cancelReject(); }
  else if (key === "ArrowUp" || key === "k") { ev.preventDefault(); ui.setCursor(ui.cursor - 1); }
  else if (key === "ArrowDown" || key === "j") { ev.preventDefault(); ui.setCursor(ui.cursor + 1); }
  else if (key === "Enter") { ev.preventDefault(); ui.buttons[ui.cursor].click(); }
  else if (key === "y") { ev.preventDefault(); ui.approve.click(); }
  else if (key === "a") { ev.preventDefault(); ui.auto.click(); }
  else if (key === "n") { ev.preventDefault(); startReject(decisions.get(shownId)); }
});

pendingBtn.addEventListener("click", () => setDrawer(!drawerOpen()));
$("backdrop").addEventListener("click", () => setDrawer(false));

setInterval(() => {
  for (const e of document.querySelectorAll(".age")) e.textContent = elapsed(e.dataset.created);
}, 10000);

$("empty").append(el("div", { class: "build empty-build", text: `build ${BUILD}` }));

// Apply the display language: static text in index.html, then everything rendered from decisions.
// The language is read from <html data-lang>; changing it later (tests do) re-renders in place.
function applyLang() {
  applyStatic();
  renderEmptyText();
  if (connDown) showBanner(t("cannot_connect", { origin: location.origin }));
  models.clear(); // cached models hold localized DOM (copy button, callout labels, fold summaries)
  renderAll();
}
applyStatic();
renderEmptyText();
new MutationObserver(applyLang).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lang"] });

loadAll().catch(() => {});
connect();
