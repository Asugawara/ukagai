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
  terms: ["Terms", "用語"],
  unknowns: ["What only you know", "あなたにしか分からないこと"],
  assumptions: ["Assumptions", "前提"],
  against: ["Counterargument", "反論"],
  affects: ["Affected", "影響を受けるもの"],
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
// Words in a risk cell. Same lists as UNDO_BAD_WORDS / UNDO_WORDS in src/hook/explain.ts (N0): checked in that order, so
// "cannot be restored" is red only. English is matched at word boundaries, Japanese anywhere.
const UNDO_BAD_WORDS =
  /\b(cannot|can't|can not|couldn't|won't) be (undone|restored|reverted|recovered|rolled back)\b|\bno way back\b|\birreversibl[ey]\b|\bunrecoverable\b|\bpermanent(ly)?\b|戻せない|戻せません|元に戻らない|元に戻せない|復元できない|取り消せない|二度と/i;
const UNDO_WORDS =
  /\b(undo|undone|revert|reverted|roll ?back|rolled back|restore|restored|reinstall|recreate|re-run|rerun|git (checkout|revert|reset|stash)|delete the|remove the)\b|戻せ|戻る|戻す|元に戻|消せ|やり直|再実行|再作成|復元/i;
const hasBad = (s) => UNDO_BAD_WORDS.test(s ?? "");
// Option colors: --opt-0..3 in app.css; the recommended option uses the accent
const optColor = (i, recommended) => (recommended ? "var(--accent)" : `var(--opt-${i % 4})`);
// A weighty answer needs Enter twice within this time; everything else is POSTed at once
const CONFIRM_MS = 3000;
const NONE_TYPES = [
  ["Missing option", "none_missing"],
  ["Wrong premise", "none_premise"],
  ["Need more evidence", "none_evidence"],
  ["Ask me later", "none_later"],
];
const NONE_PREFIX = "None of these"; // the answer is `None of these — <type>: <text>`

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
    const cls = /^(diff |index |\+\+\+ |--- )/.test(line) ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
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

// Pending button: at the right end of the header's first row. Park it in body before #head is rebuilt so it is not destroyed
const pendingBtn = $("pending-btn");
const pendingCount = $("pending-count");
function stashPending() { if (pendingBtn.parentElement !== document.body) document.body.prepend(pendingBtn); }
function placePending() {
  const slot = document.querySelector("#head .hd-meta");
  if (slot) { if (pendingBtn.parentElement !== slot) slot.append(pendingBtn); } else stashPending();
}

function renderHeader() {
  const n = pendingList().length;
  pendingCount.textContent = String(n);
  pendingBtn.hidden = n < 2; // with one decision only the shown one exists, so hide it
  const blocked = pendingList().some(isBlocker);
  document.title = n > 0 ? `(${n}) ukagai${blocked ? ` · ${t("title_waiting")}` : ""}` : "ukagai";
}

// Header: repository / branch / worktree chips, reversibility, scope. branch is the only context field that may be rendered
const tildePath = (p) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

const WT_RE = /\/\.herdr\/worktrees\/([^/]+)\/([^/]+)/;
const repoOf = (d) => WT_RE.exec(d.session.cwd)?.[1] ?? cwdTail(d);
const worktreeOf = (d) => WT_RE.exec(d.session.cwd)?.[2];

// Where the decision comes from, as one line of dim text: `ukagai ⎇ main ⧉ worktree` (no boxes; the full working directory is the tooltip)
function whereLine(d, extra = []) {
  const parts = [repoOf(d)];
  if (d.context?.branch) parts.push(`⎇ ${d.context.branch}`);
  const wt = worktreeOf(d);
  if (wt) parts.push(`⧉ ${wt}`);
  const box = el("span", { class: "where", title: tildePath(d.session.cwd) }, parts.join(" "));
  for (const x of extra) if (x) box.append(" · ", x);
  return box;
}

function metaBox(d) {
  const box = el("div", { class: "hd-meta" });
  const scope = scopeOf(d);
  box.append(whereLine(d, [scope ? el("span", { text: scope }) : null, el("span", { class: "age", "data-created": d.created_at, text: elapsed(d.created_at) })]));
  // The only box in the header is the reversibility mark, and only when it is not "reversible"
  const rev = reversibilityOf(d);
  if (rev === "irreversible") box.append(el("span", { class: "badge irreversible", text: t("irreversible") }));
  else if (rev === "costly") box.append(el("span", { class: "badge costly", text: t("costly") }));
  else if (rev === "reversible") box.append(el("span", { class: "rev", text: t("reversible") }));
  return box;
}

// The header (full width, above both columns). Row 1: title + chips, reversibility, scope, pending pill. Row 2: the headline (the first
// sentence of the recommendation, or the raw question / the plan prompt). Both rows are one / two lines and end in … (click or `.` shows all)
function renderHead(d) {
  const head = $("head");
  stashPending();
  head.replaceChildren();
  head.hidden = !d;
  head.className = "hd";
  head.onclick = null;
  if (!d) return;
  const dr = draftOf(d);
  const title = titleOf(d);
  let line2;
  if (d.kind === "approve_plan") line2 = el("div", { class: "headline plain clampable", text: t("plan_question") });
  else if (d.request.questions.length === 1 && modelFor(d).v2) line2 = modelFor(d).v2.headline;
  else if (d.request.questions.length === 1 && title !== d.request.questions[0].question) line2 = el("div", { class: "headline plain clampable", text: d.request.questions[0].question });
  const blocker = isBlocker(d);
  head.classList.toggle("blocker", blocker);
  head.append(
    el("div", { class: "hd-top" },
      blocker ? el("span", { class: "blocker-band", text: t("blocker_band") }) : null,
      el("div", { class: "v2-title", text: title, title }),
      metaBox(d)),
    el("div", { class: "hd-line2" }, line2 ?? null, el("button", { class: "more-chip", type: "button", tabindex: "-1", hidden: true, onclick: () => toggleExpand(dr) }, t("show_all"))));
  head.onclick = (e) => { if (e.target.closest(".headline, .v2-title")) toggleExpand(dr); };
  head.classList.toggle("expanded", !!dr.expanded);
  placePending();
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
    // At most one dim mark per row: ● waiting for you, (no explanation), ▸ shown
    if (isBlocker(d)) meta.append(el("span", { class: "mark blocker", title: t("badge_action"), text: "●" }));
    else if (d.kind === "answer_question" && !hasExplanation(d)) meta.append(el("span", { class: "mark", text: `(${t("badge_no_explanation").toLowerCase()})` }));
    else if (d.id === shownId) meta.append(el("span", { class: "mark", title: t("badge_shown"), text: "▸" }));
    const row = el("button", {
      class: "row" + (d.id === shownId ? " current" : ""),
      type: "button",
      onclick: () => { show(d.id); setDrawer(false); },
    }, el("div", { class: "title", text: titleOf(d) }), whereLine(d), meta);
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

const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));

async function copyCode(pre) {
  try {
    await navigator.clipboard.writeText((pre.textContent ?? "").replace(/\n$/, ""));
    toast(t("copied"));
  } catch {
    toast(t("copy_failed"));
  }
}

// Scroll the cards area (only it, never the page or the top part) so that the card is fully in view
function revealCard(card) {
  const box = card?.closest(".q-cards");
  if (!box) return;
  const c = card.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (c.top < b.top + 2) box.scrollTop += c.top - b.top - 4;
  else if (c.bottom > b.bottom - 2) box.scrollTop += c.bottom - b.bottom + 4;
}

// Folding of long text: the headline and the card bodies are 2 lines (the card under the cursor shows everything), the plan's scope section 8.
// One text button in the header (shown only when something is folded) and `.` toggle everything; the state is per decision
function setExpanded(dr) {
  for (const root of [$("decision"), $("head")]) root.classList.toggle("expanded", !!dr.expanded);
  const chip = document.querySelector("#head .more-chip");
  if (chip) chip.textContent = dr.expanded ? t("collapse") : t("show_all");
}
function toggleExpand(dr) {
  dr.expanded = !dr.expanded;
  setExpanded(dr);
  updateMore(dr);
  revealCard($("decision").querySelector(".opt.cursor"));
}
// Show the "Show all" button only when something is folded (or while expanded, so that it can fold again)
function updateMore(dr) {
  const chip = document.querySelector("#head .more-chip");
  if (!chip) return;
  if (dr?.expanded) { chip.hidden = false; return; }
  chip.hidden = ![...document.querySelectorAll("#head .clampable, #decision .clampable")].some((c) => c.scrollHeight > c.clientHeight + 1);
}
function markClamps(root, dr) {
  for (const c of root.querySelectorAll(".impact .clampable")) c.parentElement.classList.toggle("has-more", c.scrollHeight > c.clientHeight + 1);
  setExpanded(dr);
  updateMore(dr);
}

function renderRight(d) {
  document.body.append(toastBox); // park it so replaceChildren does not remove it
  renderRightBody(d);
  placeToasts();
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
  return el("div", { class: "impact" }, el("div", { class: "impact-cap", text: t("sec_impact") }), body);
}

window.addEventListener("resize", () => {
  const d = decisions.get(shownId);
  if (d) updateMore(draftOf(d));
  refreshWide();
});

// ---- Weight (Enter twice) ----

function syncConfirm(dr) {
  const bar = document.querySelector("#decision .confirm-bar");
  if (bar) bar.hidden = !dr.confirmKey;
  document.querySelector("#decision .btn.primary")?.classList.toggle("confirming", !!dr.confirmKey);
}
function clearConfirm(dr) {
  clearTimeout(dr.confirmTimer);
  dr.confirmKey = null;
  syncConfirm(dr);
}
function armConfirm(d, dr, key) {
  clearTimeout(dr.confirmTimer);
  dr.confirmKey = key;
  dr.confirmTimer = setTimeout(() => { dr.confirmKey = null; if (shownId === d.id) syncConfirm(dr); }, CONFIRM_MS);
  syncConfirm(dr);
}

// Send an answer at once. A weighty one (irreversible, or a chosen option that cannot be undone) needs Enter twice within 3 seconds first
function attempt(d, dr, key, body, weighty) {
  if (weighty && dr.confirmKey !== key) { armConfirm(d, dr, key); return; }
  clearConfirm(dr);
  send(d, body);
}

const confirmBar = (dr) => el("div", { class: "confirm-bar", hidden: !dr.confirmKey, text: t("confirm_again") });

// ---- Tooltips (terms and footnotes), evidence jump, badge copy ----

const tip = el("div", { class: "tip", role: "tooltip", hidden: true });
document.body.append(tip);
let lastFn = null; // id of the footnote reference last hovered / focused
let fnCursor = -1;
let lastBadge = null;

function showTip(target) {
  const def = target.dataset.def;
  if (!def) return hideTip();
  tip.textContent = target.classList.contains("fn") ? `[${target.dataset.fn}] ${def}` : def;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = Math.min(360, innerWidth - 16);
  tip.style.maxWidth = `${w}px`;
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left));
  tip.style.left = `${left}px`;
  const below = r.bottom + 8 + tip.offsetHeight < innerHeight || r.top < tip.offsetHeight + 12;
  tip.style.top = `${below ? r.bottom + 6 : r.top - tip.offsetHeight - 6}px`;
}
function hideTip() { tip.hidden = true; }
function tipTarget(e) { return e.target instanceof Element ? e.target.closest(".term[data-def], .fn[data-def]") : null; }
document.addEventListener("mouseover", (e) => {
  const x = tipTarget(e);
  if (x) { if (x.classList.contains("fn")) { lastFn = x.dataset.fn; fnCursor = -1; } showTip(x); } else hideTip();
  const b = e.target instanceof Element ? e.target.closest(".cbadge") : null;
  if (b) lastBadge = b;
});
document.addEventListener("focusin", (e) => {
  const x = tipTarget(e);
  if (x) { if (x.classList.contains("fn")) { lastFn = x.dataset.fn; fnCursor = -1; } showTip(x); } else hideTip();
  const b = e.target instanceof Element ? e.target.closest(".cbadge") : null;
  if (b) lastBadge = b;
});
document.addEventListener("focusout", hideTip);
document.addEventListener("click", (e) => {
  const x = e.target instanceof Element ? e.target.closest(".fn[data-fn]") : null;
  if (x && !x.closest(".fn-def")) { lastFn = x.dataset.fn; jumpEvidence(); return; }
  const b = e.target instanceof Element ? e.target.closest(".cbadge") : null;
  if (b) copyBadge(b);
});

// `e`: scroll the left column to the evidence of the footnote last hovered / focused (else the next one), flashing it for 1 second
function jumpEvidence() {
  const defs = [...document.querySelectorAll("#background .fn-def")];
  if (!defs.length) return;
  let target = lastFn == null ? null : defs.find((x) => x.dataset.fn === lastFn);
  if (!target) { fnCursor = (fnCursor + 1) % defs.length; target = defs[fnCursor]; }
  lastFn = null;
  target.scrollIntoView({ block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1000);
}

async function copyBadge(badge) {
  const text = (badge ?? lastBadge ?? document.querySelector("#background .cbadge"))?.textContent ?? "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(t("badge_copied", { text: clip(text) }));
  } catch {
    toast(t("copy_failed"));
  }
}

// ---- Overlays: the term list (`?`) and the comparison table (`v`) ----

let overlay = null; // { kind, el, sel?, v2?, ui? }
function closeOverlay() {
  overlay?.el.remove();
  overlay = null;
}
function openOverlay(kind, title, body, extra = {}) {
  closeOverlay();
  const card = el("div", { class: `overlay-card ${kind}` }, el("div", { class: "overlay-title" }, el("span", { text: title })), body);
  const root = el("div", { class: `overlay ${kind}`, role: "dialog", "aria-label": title, onclick: (e) => { if (e.target === root) closeOverlay(); } }, card);
  document.body.append(root);
  overlay = { kind, el: root, ...extra };
}

function openTerms(v2) {
  if (!v2?.terms.length) return;
  const list = el("dl", { class: "terms-list" });
  for (const x of v2.terms) list.append(el("dt", { text: x.term }), el("dd", { text: x.def }));
  openOverlay("terms", t("terms_title"), list);
}

function openCompare(v2, ui) {
  if (!v2?.hasExtra) return;
  const names = [];
  for (const c of v2.cards) for (const col of c.cols) if (!names.includes(col.name)) names.push(col.name);
  const table = el("table", { class: "cmp" });
  const head = el("tr", {}, el("th"));
  v2.cards.forEach((c, i) => head.append(el("th", { class: "cmp-h" + (c.recommended ? " is-rec" : ""), "data-i": String(i), onclick: () => { overlay.sel = i; syncCompare(); } },
    el("span", { class: "opt-label", style: `--oc:${c.color}` }, el("i", { class: "dot" }), c.label))));
  table.append(el("thead", {}, head));
  const body = el("tbody");
  for (const name of names) {
    const tr = el("tr", {}, el("th", { class: "cmp-row", text: name }));
    v2.cards.forEach((c, i) => {
      const col = c.cols.find((x) => x.name === name);
      const td = el("td", { class: "cmp-c" + (c.recommended ? " is-rec" : ""), "data-i": String(i) });
      if (col?.cell) td.append(inlineClone(col.cell)); else td.append("—");
      decorate(td, { terms: v2.terms }, { risk: COLUMN_RISK.test(name) });
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(body);
  const wrap = el("div", {}, table, el("div", { class: "overlay-hint", text: t("compare_hint") }));
  openOverlay("compare", t("compare_title"), wrap, { sel: clamp(ui.cursor, v2.cards.length), v2, ui });
  syncCompare();
}
function syncCompare() {
  if (overlay?.kind !== "compare") return;
  for (const e of overlay.el.querySelectorAll("[data-i]")) e.classList.toggle("sel", Number(e.dataset.i) === overlay.sel);
}

function overlayKey(ev) {
  const key = logicalKey(ev);
  ev.preventDefault();
  if (key === "Escape" || key === "?" && overlay.kind === "terms" || key === "v" && overlay.kind === "compare") { closeOverlay(); return; }
  if (overlay.kind !== "compare") return;
  const n = overlay.v2.cards.length;
  if (key === "ArrowDown" || key === "ArrowRight" || key === "j" || key === "l") overlay.sel = clamp(overlay.sel + 1, n);
  else if (key === "ArrowUp" || key === "ArrowLeft" || key === "k" || key === "h") overlay.sel = clamp(overlay.sel - 1, n);
  else if (key === "Enter") {
    const { sel, ui } = overlay;
    closeOverlay();
    ui.setCursor(sel, true);
    if (ui.multi) return;
    if (!ui.submit.disabled) ui.submit.click();
    return;
  }
  syncCompare();
}

// ---- Left column lead: what to doubt (Recommendation body, You decide, Assumptions, Against, Affected) ----

// Affected: a folded row at the end of the left column ("Affected (N)"), a vertical list of `code` when opened
const affectsRow = (v2) => {
  if (!v2?.affects.length) return null;
  const list = el("ul", {});
  for (const a of v2.affects) list.append(el("li", {}, el("code", { text: a })));
  return el("details", { class: "affects" }, el("summary", { text: `${t("affected")} (${v2.affects.length})` }), list);
};

// You decide: always shown (1-3 bullets)
const unknownsRow = (v2) => {
  if (!v2?.unknowns.length) return null;
  const list = el("ul", {});
  for (const li of v2.unknowns) list.append(el("li", {}, ...[...li.cloneNode(true).childNodes]));
  return el("div", { class: "unknowns" }, el("b", { class: "unknowns-cap", text: t("you_decide") }), list);
};

function assumptionsBox(v2) {
  if (!v2?.assumptions.length) return null;
  const list = el("ul", {});
  for (const li of v2.assumptions) list.append(el("li", {}, ...[...li.cloneNode(true).childNodes]));
  return el("div", { class: "assumptions" },
    el("b", { class: "sect-cap", text: t("sec_assumptions") }),
    el("div", { class: "assumptions-hint", text: t("assumptions_hint") }), list);
}

function againstBox(v2) {
  if (!v2?.against) return null;
  return el("div", { class: "against" }, el("b", { class: "against-cap", text: t("against_cap") }), v2.against);
}

// The rest of the recommendation (the headline is in the header) with its callouts in the frame. null when the recommendation was one sentence
const recBox = (v2) => v2?.recBox ? el("div", { class: "rec" }, el("div", { class: "rec-cap", text: v2.recCap ?? t("sec_recommendation") }), el("div", { class: "rec-body" }, v2.recBox)) : null;

function renderRightBody(d) {
  const root = $("decision");
  root.classList.remove("split");
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
    let noneNote = null;
    const qsBox = el("div", { class: "qs" });
    root.classList.toggle("split", single); // one question: the top part stays, only the cards scroll
    qs.forEach((q, qi) => {
      const sel = dr.sel.get(qi) ?? dr.sel.set(qi, new Set()).get(qi);
      const free = dr.free.get(qi) ?? dr.free.set(qi, { on: false, text: "" }).get(qi);
      const box = el("div", { class: "q" + (single ? " split" : "") });
      // top = everything above the cards; cardsBox = the scrolling cards (with several questions both are the plain box)
      const top = single ? el("div", { class: "q-top" }) : box;
      const cardsBox = single ? el("div", { class: "q-cards" }) : box;
      if (single) box.append(top, cardsBox);
      let items;
      if (v2) {
        if (v2.todoBox) top.append(el("div", { class: "todo" }, el("div", { class: "todo-cap", text: v2.todoCap }), v2.todoBox));
        items = [
          ...v2.cards.map((c) => ({ label: c.label, value: c.option.label, lines: c.lines, badge: c.recommended, pref: c.recommended, color: c.color, risk: c.risk })),
          ...v2.extras.map(rawItem),
        ];
        // A blocker without a recommended row starts on the fixed "Done. Continue" option
        if (isBlocker(d) && !items.some((i) => i.pref)) {
          const done = items.find((i) => BLOCKER_LABELS.done.some((n) => sameLabel(i.value, n)));
          if (done) done.pref = true;
        }
      } else {
        // The header carries the title (and, for one question, the question under it). With several questions each one is headed here
        if (!single) box.append(el("div", { class: "header", text: q.header }), el("div", { class: "question", text: q.question }));
        items = q.options.map(rawItem);
      }
      if (single) {
        if (dr.cursor == null) dr.cursor = Math.max(0, items.findIndex((i) => i.pref));
        // For single select, moving = selecting. Pre-select the initial position (the recommended one, else the first)
        if (!closed && !q.multiSelect && sel.size === 0 && !free.on && items.length) sel.add(items[dr.cursor].value);
      }
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
        const labText = el("span", it.color ? { class: "opt-label", style: `--oc:${it.color}`, text: it.label } : { text: it.label });
        const lab = el("div", { class: "lab" }, labText, it.badge ? el("span", { class: "rec-badge", text: `★ ${t("recommended")}` }) : null);
        const descs = it.lines.map((l) => {
          const dd = el("div", { class: (l.muted ? "desc muted" : "desc") + (l.extra ? " extra" : "") + " clampable" },
            l.extra ? el("b", { class: "xcol", text: `${l.extra}: ` }) : null, l.cell ? inlineClone(l.cell) : l.text);
          if (v2) decorate(dd, { terms: v2.terms }, { risk: !!l.muted });
          return dd;
        });
        const card = el("label", { class: "opt" + (it.badge ? " recommended" : "") + (it.color ? " colored" : ""), style: it.color ? `--oc:${it.color}` : null }, input,
          el("span", { class: "grow" }, lab, ...descs));
        if (single) { const idx = cards.length; cards.push({ input, card, risk: it.risk ?? "" }); card.addEventListener("click", () => ui?.setCursor(idx, false)); }
        cardsBox.append(card);
      }
      if (single) {
        const none = dr.none;
        cardsBox.append(el("div", { class: "none-card" + (none ? " open" : ""), role: "button", tabindex: "-1", onclick: () => { if (!closed) openNone(d); } },
          el("span", { text: t("none_of_these") })));
        if (none && !closed) {
          const panel = el("div", { class: "none-panel" });
          NONE_TYPES.forEach(([type, key], k) => panel.append(el("div", {
            class: "none-type" + (k === none.cursor ? " cursor" : ""), "data-type": type,
            onclick: () => { none.cursor = k; syncNone(); ui?.submitNone(); },
          }, el("span", { text: t(key) }))));
          noneNote = el("input", {
            type: "text", class: "none-note", placeholder: t("none_note"), value: none.note,
            oninput: (ev) => { none.note = ev.target.value; },
          });
          panel.append(noneNote);
          cardsBox.append(panel);
        }
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
        el("span", { class: "grow" }, el("div", { class: "lab" }, el("span", { text: t("free_text") })), freeText));
      if (single) { const idx = cards.length; cards.push({ input: freeInput, card: freeCard }); freeTextEl = freeText; freeCard.addEventListener("click", () => ui?.setCursor(idx, false)); }
      cardsBox.append(freeCard);
      qsBox.append(box);
    });
    root.append(qsBox);
    const complete = () => qs.every((_, qi) => {
      const f = dr.free.get(qi);
      if (f.on) return f.text.trim() !== "";
      return (dr.sel.get(qi)?.size ?? 0) > 0;
    });
    // The answers as they stand, and whether sending them is weighty (an irreversible decision, or a chosen option whose risk cell says it cannot be undone)
    const collect = () => {
      const answers = {};
      let weighty = reversibilityOf(d) === "irreversible";
      qs.forEach((q, qi) => {
        const sel = dr.sel.get(qi);
        // Answer with the original option.label (not the table's rendering)
        const picked = q.options.map((o) => o.label).filter((l) => sel.has(l));
        const f = dr.free.get(qi);
        if (f.on && !q.multiSelect) picked.length = 0;
        if (f.on) picked.push(f.text.trim());
        if (single && v2) for (const l of picked) if (hasBad(v2.cards.find((c) => c.option.label === l)?.risk)) weighty = true;
        answers[q.question] = picked.join(MULTI_SELECT_SEPARATOR);
      });
      return { answers, weighty };
    };
    const submit = el("button", {
      class: "btn primary", type: "button", id: "submit", disabled: closed || !complete(),
      onclick: () => { const { answers, weighty } = collect(); attempt(d, dr, "submit", { answers }, weighty); },
    }, el("span", { text: t("answer") }));
    function updateSubmit() { submit.disabled = closed || !complete(); }
    const actions = el("div", { class: "actions" }, confirmBar(dr), submit);
    if (single) {
      const letters = [v2?.terms.length ? "?" : "", modelFor(d).fnCount ? "e" : "", v2?.hasExtra ? "v" : "", d.explanation && hasExplanation(d) ? "y" : "", "n"].filter(Boolean);
      const extraHints = [
        v2?.terms.length ? `? ${t("hint_terms")} · ` : "",
        modelFor(d).fnCount ? `e ${t("hint_evidence")} · ` : "",
        v2?.hasExtra ? `v ${t("hint_compare")} · ` : "",
        d.explanation && hasExplanation(d) ? `y ${t("hint_copy_badge")} · ` : "",
        `n ${t("hint_none")} · `,
      ].join("");
      // The full line, and a short one that CSS swaps in below 1100px / 800px so that the hint stays on one line
      const full = `↑↓ ${t("hint_move")} · ${qs[0].multiSelect ? `Space ${t("hint_toggle")} · ` : ""}Enter ${t("hint_answer")} · ${v2?.todoBox?.querySelector("pre") ? `c ${t("hint_copy")} · ` : ""}${extraHints}←→ ${t("hint_next")} · Esc ${t("hint_back")}`;
      const short = `↑↓ ${t("hint_short_move")} · ${qs[0].multiSelect ? `Space ${t("hint_short_toggle")} · ` : ""}Enter ${t("hint_short_answer")} · ${letters.join(" ")} ${t("hint_short_more")} · ←→ ${t("hint_short_next")} · Esc`;
      actions.append(el("div", { class: "hint" }, el("span", { class: "hint-full", text: full }), el("span", { class: "hint-short", text: short }), " ", buildTag()));
    }
    root.append(actions);
    const multi = !!qs[0].multiSelect && single;
    ui = {
      kind: "question", cards, multi, submit, closed, single, v2, freeText: freeTextEl, noneNote,
      copy: v2?.todoBox?.querySelector("pre") ? () => copyCode(v2.todoBox.querySelector("pre")) : null,
      setCursor(i, select) {
        if (!cards.length) return;
        i = clamp(i, cards.length);
        if (i !== dr.cursor) clearConfirm(dr);
        dr.cursor = i;
        cards.forEach((c, k) => c.card.classList.toggle("cursor", k === i));
        revealCard(cards[i].card);
        updateMore(dr);
        if (select && !multi && !closed) cards[i].input.click();
      },
      get cursor() { return dr.cursor ?? 0; },
      toggleExpand: () => toggleExpand(dr),
      submitNone() {
        if (!dr.none) return;
        const [type] = NONE_TYPES[dr.none.cursor];
        const note = dr.none.note.trim();
        attempt(d, dr, "none", { answers: { [qs[0].question]: `${NONE_PREFIX} — ${type}${note ? `: ${note}` : ""}` } }, false); // a type answer chooses nothing irreversible: no Enter twice
      },
    };
    if (single && !closed) ui.setCursor(dr.cursor, false);
    markClamps(root, dr);
    if (single && !closed) revealCard(cards[clamp(dr.cursor, cards.length)]?.card);
    return;
  }

  // approve_plan
  const qsBox = el("div", { class: "qs" });
  const impact = impactBox(d);
  if (impact) qsBox.append(impact);
  root.append(qsBox);
  const weighty = reversibilityOf(d) === "irreversible";
  const approve = el("button", { class: "btn primary", type: "button", disabled: closed, onclick: () => attempt(d, dr, "approve", { approve: true, set_mode_auto: false }, weighty) }, el("span", { text: t("approve") }));
  const auto = el("button", { class: "btn", type: "button", disabled: closed, onclick: () => attempt(d, dr, "auto", { approve: true, set_mode_auto: true }, weighty) }, el("span", { text: t("approve_auto") }));
  const reject = el("button", { class: "btn danger", type: "button", disabled: closed, onclick: () => startReject(d) }, el("span", { text: t("reject") }));
  const actions = el("div", { class: "actions" }, confirmBar(dr));
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
  actions.append(approve, auto, reject);
  actions.append(el("div", { class: "hint" }, `↑↓ ${t("hint_pick")} · Enter ${t("hint_decide")} · y ${t("approve")} · a ${t("approve_auto")} · n ${t("reject")} · ←→ ${t("hint_next")}`, " ", buildTag()));
  root.append(actions);
  const buttons = [approve, auto, reject];
  ui = {
    kind: "plan", buttons, closed, approve, auto,
    setCursor(i) {
      i = clamp(i, buttons.length);
      if (i !== dr.cursor) clearConfirm(dr);
      dr.cursor = i;
      buttons.forEach((b, k) => b.classList.toggle("cursor", k === i));
    },
    get cursor() { return dr.cursor ?? 0; },
    toggleExpand: () => toggleExpand(dr),
  };
  if (!closed) ui.setCursor(dr.cursor ?? 0);
  markClamps(root, dr);
}

// "None of these…": open the type picker under the card (the answer is `None of these — <type>: <note>`)
function openNone(d) {
  const dr = draftOf(d);
  dr.none = { cursor: 0, note: "" };
  renderRight(d);
}
function closeNone(d) {
  draftOf(d).none = null;
  renderRight(d);
}
function syncNone() {
  const d = decisions.get(shownId);
  const none = d && draftOf(d).none;
  if (!none) return;
  document.querySelectorAll("#decision .none-type").forEach((e, k) => e.classList.toggle("cursor", k === none.cursor));
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

// Color the diagram nodes whose text is an option label: shape stroke and text fill in the option's color
function colorMermaid(svg, opts) {
  if (!opts.length) return;
  for (const t of svg.querySelectorAll("text, .nodeLabel")) {
    const text = (t.textContent ?? "").trim();
    if (!text || t.closest(".optcolored")) continue;
    const o = opts.find((x) => sameLabel(x.label, text));
    if (!o) continue;
    t.classList.add("optcolored");
    if (t.tagName.toLowerCase() === "text") t.style.setProperty("fill", o.color, "important");
    else t.style.setProperty("color", o.color, "important");
    // Flowchart / state nodes: every shape of the node group. Sequence actors: the shapes next to the text
    const node = t.closest("g.node, g.cluster");
    let shapes = [];
    if (node) shapes = [...node.querySelectorAll("rect, polygon, path, circle, ellipse")].filter((x) => !x.closest(".label, foreignObject, text"));
    else {
      for (let g = t.parentElement; g && g !== svg && !shapes.length; g = g.parentElement) shapes = [...g.children].filter((c) => /^(rect|polygon|path|circle|ellipse)$/i.test(c.tagName));
    }
    for (const sh of shapes) { sh.style.setProperty("stroke", o.color, "important"); sh.style.setProperty("stroke-width", "3px", "important"); }
  }
}

async function renderMermaid(codeEl, opts = []) {
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
    if (el0) colorMermaid(el0, opts);
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
    if (wide && !chip) box.prepend(el("button", { class: "wide-chip", type: "button", tabindex: "-1", onclick: () => setFullwide(!document.body.classList.contains("fullwide")) }, t("full_width")));
    else if (!wide && chip) chip.remove();
    const svg = box.querySelector("svg");
    if (svg) {
      if (full && natural) { svg.style.width = `${natural}px`; svg.style.maxWidth = "none"; svg.style.maxHeight = "none"; }
      else { svg.style.removeProperty("width"); svg.style.removeProperty("max-width"); svg.style.removeProperty("max-height"); }
    }
    const c2 = box.querySelector(".wide-chip");
    if (c2) c2.textContent = full ? t("back") : t("full_width");
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
      } else if (tag === "sup" && c.classList.contains("fn")) out.append(c.cloneNode(true));
      else if (tag === "br") out.append(" ");
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


// ---- Rich text: wrap matches in text nodes (terms, option labels, risk words, numbers, footnotes) ----

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SKIP_RICH = "pre, .term, .optref, .fn, .fn-n, button, .risk-bad, .risk-undo, .num, .cbadge";

// Wrap every match of the global regex `re` in text nodes under root; make(m) returns the node to put in, or null to leave the text
function wrapText(root, re, make, skip = SKIP_RICH) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement?.closest(skip)) nodes.push(n);
  for (const n of nodes) {
    const text = n.textContent ?? "";
    re.lastIndex = 0;
    let last = 0;
    let frag = null;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] === "") { re.lastIndex++; continue; }
      const node = make(m);
      if (!node) continue;
      frag ??= document.createDocumentFragment();
      frag.append(text.slice(last, m.index), node);
      last = m.index + m[0].length;
    }
    if (frag) { frag.append(text.slice(last)); n.replaceWith(frag); }
  }
}

const wordEdge = (s) => (/^\w/.test(s) ? "(?<![\\w])" : "") + esc(s) + (/\w$/.test(s) ? "(?![\\w])" : "");

// Terms: longest match first, the first occurrence under each root only
function termMarks(root, terms) {
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const re = new RegExp(sorted.map((x) => wordEdge(x.term)).join("|"), "gi");
  const seen = new Set();
  wrapText(root, re, (m) => {
    const key = m[0].toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const def = sorted.find((x) => x.term.toLowerCase() === key)?.def;
    return def ? el("span", { class: "term", tabindex: "0", "data-def": def, text: m[0] }) : null;
  });
}

// Option labels: a <strong> / <code> that is exactly a label (any length); plain text for labels of 3+ characters
function optMarks(root, opts) {
  for (const e of root.querySelectorAll("strong, code")) {
    if (e.closest("pre, .optref")) continue;
    const o = opts.find((x) => sameLabel(x.label, e.textContent ?? ""));
    if (o) { e.classList.add("optref"); e.style.setProperty("--oc", o.color); }
  }
  const long = opts.filter((o) => o.label.length >= 3).sort((a, b) => b.label.length - a.label.length);
  if (!long.length) return;
  const re = new RegExp(long.map((o) => wordEdge(o.label)).join("|"), "g");
  wrapText(root, re, (m) => {
    const o = long.find((x) => x.label === m[0]);
    return o ? el("span", { class: "optref", style: `--oc:${o.color}`, text: m[0] }) : null;
  });
}

// Risk words: the "cannot be undone" family red, the "how to undo" family green with an underline
function riskMarks(root) {
  wrapText(root, new RegExp(UNDO_BAD_WORDS.source, "gi"), (m) => el("span", { class: "risk-bad", text: m[0] })); // .risk-bad is skipped by the next pass
  wrapText(root, new RegExp(UNDO_WORDS.source, "gi"), (m) => el("span", { class: "risk-undo", text: m[0] }));
}

// A number with a unit gets a light emphasis
const NUM_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?\s?(?:ms|s|sec|KB|MB|GB|%|件|行|個|倍|files?|lines?|tests?|errors?)(?![A-Za-z])/g;
function numMarks(root) {
  wrapText(root, new RegExp(NUM_RE.source, "g"), (m) => el("span", { class: "num", text: m[0] }), `${SKIP_RICH}, code`);
}

// ctx = { terms: [{term, def}], opts: [{label, color}] }
function decorate(root, ctx, o = {}) {
  if (ctx?.opts?.length) optMarks(root, ctx.opts);
  if (ctx?.terms?.length) termMarks(root, ctx.terms);
  if (o.risk) riskMarks(root);
  if (o.num) numMarks(root);
}

// Footnotes: pull `[^n]: text` out of the Markdown and turn `[^n]` (outside code) into a superscript whose tooltip is the evidence
function extractFootnotes(md) {
  const defs = new Map();
  let fence = false;
  const kept = [];
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const d = !fence && /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
    if (d) defs.set(d[1], d[2]);
    else kept.push(line);
  }
  if (!defs.size && !/\[\^[^\]\s]+\]/.test(md)) return { md, defs };
  fence = false;
  const out = kept.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/\[\^([^\]\s]+)\]/g, (_, id) =>
      `<sup class="fn" tabindex="0" data-fn="${escAttr(id)}" data-def="${escAttr(plainMd(defs.get(id) ?? ""))}">${escAttr(id)}</sup>`))).join("");
  });
  return { md: out.join("\n"), defs };
}

function footnoteDefs(defs) {
  const box = el("div", { class: "fn-defs" });
  for (const [id, text] of defs) {
    const body = el("span", { class: "fn-text" });
    body.innerHTML = sanitize(window.marked.parseInline(text, { async: false }));
    dropExternalImages(body);
    box.append(el("div", { class: "fn-def", "data-fn": id }, el("sup", { class: "fn-n", text: id }), body));
  }
  return box;
}

// Terms section: `- **term** — definition` (also `term: definition`)
function parseTerms(sec) {
  const out = [];
  for (const li of bulletsOf(sec)) {
    const text = (li.textContent ?? "").trim();
    const strong = li.firstElementChild?.tagName === "STRONG" ? li.firstElementChild : null;
    let term;
    let def;
    if (strong) {
      term = (strong.textContent ?? "").trim();
      def = text.slice(text.indexOf(term) + term.length);
    } else {
      const m = /^(.+?)(?:\s[—–-]\s|\s*[:：])\s*([\s\S]+)$/.exec(text);
      if (!m) continue;
      [, term, def] = m;
    }
    term = term.replace(/[:：]\s*$/, "").trim();
    def = def.replace(/^\s*[:：—–-]+\s*/, "").trim();
    if (term && def) out.push({ term, def });
  }
  return out;
}

// Top-level bullets of a section (elements holding the inline content)
const bulletsOf = (sec) => sec.nodes.flatMap((n) => [...(n.querySelectorAll?.(":scope > li") ?? [])]);

// Move the first sentence of the first paragraph out of the box into a new element (the headline), so the box does not repeat it.
// null when there is none (the box is left whole)
function splitHeadline(box) {
  const p = box.firstElementChild;
  if (!p || p.tagName !== "P") return null;
  const text = p.textContent ?? "";
  const end = /[。！？]|[.!?](?=\s|$)/.exec(text);
  const upTo = end ? end.index + 1 : text.length;
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let acc = 0;
  const range = document.createRange();
  range.setStart(p, 0);
  let placed = false;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const len = n.textContent.length;
    if (acc + len >= upTo) { range.setEnd(n, upTo - acc); placed = true; break; }
    acc += len;
  }
  if (!placed) range.setEnd(p, p.childNodes.length);
  if (!text.slice(0, upTo).trim()) return null;
  const head = el("div", { class: "headline clampable" });
  head.append(range.extractContents());
  // what is left of the paragraph starts at the next sentence
  const first = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
  if (first) first.textContent = first.textContent.replace(/^\s+/, "");
  if (!(p.textContent ?? "").trim() && !p.querySelector("img")) p.remove();
  return head;
}

// Apply pre folding, diff and mermaid together (safe to call repeatedly)
async function enhance(container, opts = []) {
  callouts(container);
  softHyphens(container);
  for (const code of container.querySelectorAll("pre > code.language-diff")) {
    code.closest("pre").replaceWith(diffBlock(code.textContent ?? ""));
  }
  highlightCode(container);
  await Promise.all([...container.querySelectorAll("pre > code.language-mermaid")].map((c) => renderMermaid(c, opts)));
  foldLongPre(container);
}

// highlight.js (cdnjs, optional): only fences that name a language. Without the script nothing changes
function highlightCode(container) {
  const hl = window.hljs;
  if (!hl) return;
  for (const code of container.querySelectorAll("pre > code[class*='language-']")) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
    if (!lang || lang === "mermaid" || lang === "diff" || !hl.getLanguage(lang)) continue;
    code.classList.add("hljs");
    hl.highlightElement(code);
  }
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
// Known sections are captioned in the display language (i18n keys sec_*) whichever language the file's heading is in; unknown ones stay as written
const isKnown = (sec, names) => names.map(normHeading).includes(sec.norm);
const KNOWN_HEADS = [
  [SECTION.recommendation, "sec_recommendation"], [SECTION.options, "sec_options"], [SECTION.checked, "sec_checked"], [SECTION.blockerTodo, "sec_todo"],
  [SECTION.impact, "sec_impact"], [SECTION.terms, "sec_terms"], [SECTION.assumptions, "sec_assumptions"], [SECTION.against, "sec_against"],
  [SECTION.affects, "sec_affects"], [SECTION.unknowns, "sec_unknowns"],
];
// A section whose heading the GUI does not know is never dropped: it is shown as written at the end of the left column
function keepUnknownSections(container) {
  const known = Object.values(SECTION).flat();
  for (const sec of sectionsOf(container)) {
    if (/^H1$/.test(sec.head.tagName) || isKnown(sec, known) || findSection([sec], known)) continue;
    for (const n of sec.nodes) if (n.parentElement === container) container.append(n);
  }
}

// Headings of the known sections that stay in the left column, in the display language
function localizeHeads(container) {
  for (const sec of sectionsOf(container)) {
    const known = KNOWN_HEADS.find(([names]) => isKnown(sec, names));
    if (known) sec.head.textContent = t(known[1]);
  }
}

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
function findSection(secs, names, exact = false) {
  const ns = names.map(normHeading);
  return secs.find((s) => ns.includes(s.norm)) ?? (exact ? undefined : secs.find((s) => ns.some((n) => s.norm.includes(n))));
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
  const fn = extractFootnotes(body);
  left.innerHTML = sanitize(window.marked.parse(fn.md, { async: false }));
  dropExternalImages(left);
  m.left = left;
  m.fnCount = fn.defs.size;
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
      // Optional sections (Terms / What only you know / Assumptions / Counterargument / Affected) leave the left column
      const takeSec = (names) => {
        const sec = findSection(secs, names, true);
        if (!sec || sec === optSec || sec === recSec) return null;
        return sec;
      };
      const termsSec = takeSec(SECTION.terms);
      const unknownsSec = takeSec(SECTION.unknowns);
      const assumptionsSec = takeSec(SECTION.assumptions);
      const againstSec = takeSec(SECTION.against);
      const affectsSec = takeSec(SECTION.affects);
      v2.terms = termsSec ? parseTerms(termsSec) : [];
      v2.unknowns = unknownsSec ? bulletsOf(unknownsSec) : [];
      v2.assumptions = assumptionsSec ? bulletsOf(assumptionsSec) : [];
      v2.affects = affectsSec ? bulletsOf(affectsSec).map((li) => (li.textContent ?? "").trim()).filter(Boolean) : [];
      if (againstSec) {
        const box = el("div", { class: "md" });
        for (const n of againstSec.nodes.slice(1)) box.append(n);
        if (box.children.length) v2.against = box;
      }
      for (const sec of [termsSec, unknownsSec, assumptionsSec, againstSec, affectsSec]) {
        if (!sec) continue;
        for (const n of sec.nodes) if (n.parentElement === left) n.remove();
      }
      v2.ctx = { terms: v2.terms, opts: v2.cards.map((c) => ({ label: c.label, color: c.color })) };
      const todoSec = (fm.type === "blocker" || d.explanation.type === "blocker") ? findSection(secs, SECTION.blockerTodo) : undefined;
      if (todoSec && todoSec !== optSec) {
        const todoBox = el("div", { class: "md" });
        v2.todoCap = t("sec_todo");
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
        v2.recCap = t("sec_recommendation");
        for (const n of recSec.nodes.slice(1)) recBox.append(n);
        recSec.head.remove();
        v2.headline = splitHeadline(recBox);
        if (recBox.children.length) { v2.recBox = recBox; enhance(recBox, v2.ctx.opts).catch(() => {}); }
      }
      // Footnote definitions go under What I checked (or at the end); path:line and `cmd` there become copyable badges
      const checkedSec = findSection(secs, SECTION.checked);
      if (fn.defs.size) {
        const defs = footnoteDefs(fn.defs);
        const at = checkedSec ? checkedSec.nodes.findLast((n) => n.parentElement === left) : null;
        if (at) at.after(defs); else left.append(defs);
      }
      if (checkedSec) {
        const hosts = [...checkedSec.nodes, ...left.querySelectorAll(".fn-defs")];
        for (const n of hosts) {
          for (const c of n.querySelectorAll?.("code") ?? []) if (!c.closest("pre")) { c.classList.add("cbadge"); c.tabIndex = 0; }
        }
      }
      // Decorate: option colors in the text, terms, risk words (cells are handled when the cards are built), numbers with units
      for (const e of [v2.recBox, v2.headline, v2.against, v2.todoBox, ...v2.unknowns, ...v2.assumptions].filter(Boolean)) decorate(e, v2.ctx);
      decorate(left, v2.ctx, { num: true });
      m.v2 = v2;
    }
  }
  if (m.v2) keepUnknownSections(left);
  localizeHeads(left);
  enhance(left, m.v2?.ctx.opts ?? []).catch(() => {});
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
    const extra = [];
    if (hi >= 0 && ri >= 0) {
      lines = [{ text: row[hi] ?? "", cell: tds[hi] }, { text: row[ri] ?? "", muted: true, cell: tds[ri] }];
      // Columns beyond label / happens / risk: a headed row on the card
      header.forEach((h, j) => { if (j > 0 && j !== hi && j !== ri && row[j]) extra.push({ name: h, text: row[j], cell: tds[j] }); });
      for (const x of extra) lines.push({ text: x.text, cell: x.cell, extra: x.name });
    } else lines = row.slice(1).map((s, j) => ({ text: s ? `${header[j + 1] ?? ""}: ${s}` : "" })); // old format
    lines = lines.filter((l) => l.text && !/^[-—ー]+$/.test(l.text));
    const cols = header.map((h, j) => ({ name: h, text: row[j] ?? "", cell: tds[j] })).slice(1).filter((c) => c.text);
    cards.push({ option: o, label: stripSuffix(row[0]), lines, cols, hasExtra: extra.length > 0, risk: ri >= 0 ? (row[ri] ?? "") : "", suffix: SUFFIX_RE.test(row[0]), recommended: false });
  }
  // Keep v2 even when no row matches (every option becomes a raw card)
  const want = fm.recommended ? fm.recommended : null;
  const byFm = want ? cards.filter((c) => sameLabel(c.option.label, want)) : [];
  for (const c of byFm.length ? byFm : cards.filter((c) => c.suffix)) c.recommended = true;
  cards.forEach((c, i) => { c.color = optColor(i, c.recommended); });
  const extras = options.filter((o) => !cards.some((c) => c.option === o));
  return { cards, extras, hasExtra: cards.some((c) => c.hasExtra) };
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
    const m = modelFor(d);
    const lead = m.v2 ? [recBox(m.v2), unknownsRow(m.v2), assumptionsBox(m.v2), againstBox(m.v2)].filter(Boolean) : [];
    if (lead.length) root.append(el("div", { class: "lead" }, ...lead));
    root.append(m.left);
    const aff = m.v2 ? affectsRow(m.v2) : null;
    if (aff) root.append(aff);
    return;
  }
  const code = ex?.none_reason ?? "";
  const reason = NONE_REASON_KEYS[code] ? t(NONE_REASON_KEYS[code]) : code;
  root.append(el("div", { class: "bg-note", text: reason ? t("no_explanation_reason", { reason }) : t("no_explanation") }));
}

// ---- Switching the view ----

function renderAll() {
  document.body.classList.remove("fullwide");
  closeOverlay();
  const d = decisions.get(shownId);
  $("main").hidden = !d;
  $("empty").hidden = !!d;
  renderHeader();
  renderList();
  const left = renderLeft(d);
  renderHead(d);
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
  KeyJ: "j", KeyK: "k", KeyH: "h", KeyL: "l", KeyB: "b", KeyI: "i", KeyG: "g", KeyC: "c", KeyY: "y", KeyA: "a", KeyN: "n", KeyF: "f", KeyE: "e", KeyV: "v", Slash: "/", Period: ".",
  Space: " ", Enter: "Enter", Escape: "Escape", Tab: "Tab",
};
function logicalKey(ev) {
  if (ev.key !== "Process" && ev.keyCode !== 229 && !ev.isComposing) return ev.key;
  const k = CODE_KEYS[ev.code];
  if (k === undefined) return ev.key;
  if (k === "/" && ev.shiftKey) return "?";
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
  if (overlay) { overlayKey(ev); return; }
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
    const dr = draftOf(decisions.get(shownId));
    if (dr.none) {
      // The "None of these" type picker
      const move = (step) => { dr.none.cursor = clamp(dr.none.cursor + step, NONE_TYPES.length); syncNone(); };
      if (typing && t === ui.noneNote) {
        if (key === "Enter") { ev.preventDefault(); ui.submitNone(); }
        else if (key === "Escape") { ev.preventDefault(); t.blur(); }
        else if (key === "ArrowUp" || key === "ArrowDown") { ev.preventDefault(); t.blur(); move(key === "ArrowDown" ? 1 : -1); }
        return;
      }
      if (key === "Enter" && isBtn) return;
      if (key === "ArrowDown" || key === "j") { ev.preventDefault(); move(1); }
      else if (key === "ArrowUp" || key === "k") { ev.preventDefault(); move(-1); }
      else if (key === "Enter") { ev.preventDefault(); ui.submitNone(); }
      else if (key === "i") { ev.preventDefault(); ui.noneNote?.focus(); }
      else if (key === "Escape" || key === "n") { ev.preventDefault(); closeNone(decisions.get(shownId)); }
      else if (typing) return;
      return;
    }
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
    } else if (key === "?") {
      if (!ui.v2?.terms.length) return;
      ev.preventDefault();
      openTerms(ui.v2);
    } else if (key === "e") {
      ev.preventDefault();
      jumpEvidence();
    } else if (key === "v") {
      if (!ui.v2?.hasExtra) return;
      ev.preventDefault();
      openCompare(ui.v2, ui);
    } else if (key === "y") {
      ev.preventDefault();
      copyBadge();
    } else if (key === "n") {
      if (!ui.single) return;
      ev.preventDefault();
      openNone(decisions.get(shownId));
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
function renderDrawerKeys() {
  $("drawer-keys").textContent = `↑↓ ${t("key_move")} · Enter ${t("key_show")} · Esc ← ${t("key_close")}`;
}
function applyLang() {
  applyStatic();
  renderDrawerKeys();
  renderEmptyText();
  if (connDown) showBanner(t("cannot_connect", { origin: location.origin }));
  models.clear(); // cached models hold localized DOM (copy button, callout labels, fold summaries)
  renderAll();
}
applyStatic();
renderDrawerKeys();
renderEmptyText();
new MutationObserver(applyLang).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lang"] });

loadAll().catch(() => {});
connect();
