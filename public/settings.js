// The settings page (/settings): every control saves at once with PUT /api/settings (the whole object, validated by the server).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";
import { sanitize } from "./sanitize.js";

const $ = (id) => document.getElementById(id);
const DELAY_MIN = 30; // same limits as CODEX_DELAY_MIN_S / MAX_S in src/contract.ts
const DELAY_MAX = 3600;

let s = null; // the saved settings
// The sidebar panes, in sidebar order. `fieldset` panes show one fieldset of #form (matched by data-pane); the skill pane is its own section.
const PANES = [
  { id: "general", icon: "settings", label: "set_nav_general", lede: "set_lede_general" },
  { id: "notifications", icon: "bell", label: "set_nav_notifications", lede: "set_lede_notifications" },
  { id: "plans", icon: "file-text", label: "set_nav_plans", lede: "set_lede_plans" },
  { id: "checkpoints", icon: "clock", label: "set_nav_checkpoints", lede: "set_lede_checkpoints" },
  { group: "set_nav_agent" },
  { id: "skill", icon: "book-open", label: "set_nav_skill", lede: "set_lede_skill" },
];
const paneOf = (id) => PANES.find((p) => p.id === id);
/** The pane named by the URL hash; an empty or unknown hash is General. Kept outside the DOM: render() rebuilds #form on every save / SSE / reconnect */
const paneFromHash = () => (paneOf(location.hash.slice(1))?.id) ?? "general";
let pane = paneFromHash();

let idSeq = 0; // checkbox ids are stable across renders (the focused control keeps its focus)

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
}

// ---- status line ----
let statusTimer;
function status(msg, err = false) {
  const box = $("status");
  box.textContent = msg;
  box.classList.toggle("err", err);
  box.classList.add("on");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => box.classList.remove("on"), err ? 5000 : 1500);
}

// ---- theme / language apply ----
function applyChrome() {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme; else root.dataset.theme = s.theme;
  root.dataset.lang = s.lang;
  root.lang = s.lang;
  document.title = `ukagai · ${t("set_title")}`;
}

// ---- saving ----
/** Apply `change` to a copy of the settings and PUT it. `onError(message)` shows an inline message; the controls re-render from the saved state */
async function save(change, onError) {
  const next = structuredClone(s);
  change(next);
  const before = s;
  s = next; // the theme and the language apply at once; a failure rolls back below
  applyChrome();
  status(t("set_saving"));
  try {
    s = await api("/api/settings", { method: "PUT", body: JSON.stringify(next) });
    applyChrome();
    status(t("set_saved"));
  } catch (e) {
    s = before;
    applyChrome();
    const msg = e.issues?.length ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e.message;
    onError?.(msg);
    status(t("set_failed", { message: msg }), true);
  }
  render();
}

// ---- building blocks ----
function toggle(label, help, get, set, extra) {
  const id = `opt-${idSeq++}`;
  const box = el("input", { type: "checkbox", id });
  box.checked = get();
  const err = el("p", { class: "set-err", id: `${id}-err`, role: "alert" });
  box.addEventListener("change", () => {
    if (extra?.before) { extra.before(box, err); return; }
    err.textContent = "";
    save((n) => set(n, box.checked), (m) => { err.textContent = m; });
  });
  return el("div", { class: "set-row" }, el("label", { for: id }, box, " ", label), help ? el("p", { class: "set-help", text: help }) : null, extra?.note?.(), err);
}

function select(label, id, value, options, onChange) {
  const sel = el("select", { id }, ...options.map(([v, text]) => el("option", { value: v, text, selected: v === value })));
  sel.addEventListener("change", () => onChange(sel.value));
  return el("div", { class: "set-row" }, el("label", { for: id, text: label }), sel);
}

function fieldset(paneId, title, ...rows) {
  return el("fieldset", { "data-pane": paneId }, el("legend", { text: title }), ...rows);
}

// ---- instruction presets: one per line, saved when the box loses focus (the server trims, drops blank lines and checks the limits) ----
function presetsBox() {
  const id = "plan-presets";
  const box = el("textarea", { id, rows: "4", spellcheck: "false" });
  box.value = (s.plans.instruction_presets ?? []).join("\n");
  const err = el("p", { class: "set-err", role: "alert" });
  box.addEventListener("change", () => {
    err.textContent = "";
    const lines = box.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    save((n) => { n.plans.instruction_presets = lines; }, (m) => { err.textContent = m; });
  });
  return el("div", { class: "set-row" }, el("label", { for: id, text: t("set_plans_presets") }), box, el("p", { class: "set-help", text: t("set_plans_presets_help") }), err);
}

// ---- notifications ----
const permText = () => {
  if (typeof Notification === "undefined") return t("set_perm_unsupported");
  return t({ granted: "set_perm_granted", denied: "set_perm_denied" }[Notification.permission] ?? "set_perm_default");
};
async function browserToggle(box, err) {
  err.textContent = "";
  if (box.checked) {
    // Turning it on asks for permission; the toggle stays off unless it is granted
    let perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    if (perm === "default") {
      try { perm = await Notification.requestPermission(); } catch { perm = "denied"; }
    }
    if (perm !== "granted") {
      box.checked = false;
      err.textContent = permText();
      const note = $("perm-state");
      if (note) note.textContent = permText();
      return;
    }
  }
  save((n) => { n.notify.browser = box.checked; }, (m) => { err.textContent = m; });
}

// ---- the page ----
function render() {
  const focused = document.activeElement?.id;
  idSeq = 0;
  const form = $("form");
  chrome();

  const delayId = "cp-delay";
  const delay = el("input", { type: "number", id: delayId, min: String(DELAY_MIN), max: String(DELAY_MAX), step: "1", value: String(s.checkpoints.codex_delay_s), inputmode: "numeric" });
  const delayErr = el("p", { class: "set-err", role: "alert" });
  delay.addEventListener("change", () => {
    const v = Number(delay.value);
    if (delay.value.trim() === "" || !Number.isInteger(v) || v < DELAY_MIN || v > DELAY_MAX) { delayErr.textContent = t("set_cp_delay_err"); return; }
    delayErr.textContent = "";
    save((n) => { n.checkpoints.codex_delay_s = v; }, (m) => { delayErr.textContent = m; });
  });

  form.replaceChildren(
    fieldset("general", t("set_g_display"),
      select(t("set_lang"), "lang", s.lang, [["en", "English"], ["ja", "日本語"]], (v) => save((n) => { n.lang = v; })),
      select(t("set_theme"), "theme", s.theme, [["system", t("set_theme_system")], ["light", t("set_theme_light")], ["dark", t("set_theme_dark")]], (v) => save((n) => { n.theme = v; })),
      toggle(t("set_hints"), "", () => s.hints, (n, v) => { n.hints = v; })),
    fieldset("checkpoints", t("set_g_checkpoints"),
      toggle(t("set_cp_enabled"), t("set_cp_enabled_help"), () => s.checkpoints.enabled, (n, v) => { n.checkpoints.enabled = v; }),
      el("div", { class: "set-row" }, el("label", { for: delayId, text: t("set_cp_delay") }), delay, el("p", { class: "set-help", text: t("set_cp_delay_help") }), delayErr),
      toggle(t("set_cp_terminal"), t("set_cp_terminal_help"), () => s.checkpoints.terminal_delivery, (n, v) => { n.checkpoints.terminal_delivery = v; })),
    fieldset("plans", t("set_g_plans"),
      toggle(t("set_plans_auto"), t("set_plans_auto_help"), () => s.plans.auto_show, (n, v) => { n.plans.auto_show = v; }),
      presetsBox()),
    fieldset("notifications", t("set_g_notify"),
      toggle(t("set_n_sound"), t("set_n_sound_help"), () => s.notify.sound, (n, v) => { n.notify.sound = v; }),
      toggle(t("set_n_browser"), t("set_n_browser_help"), () => s.notify.browser, (n, v) => { n.notify.browser = v; }, {
        before: browserToggle,
        note: () => el("p", { class: "set-help", id: "perm-state", text: permText() }),
      }),
      toggle(t("set_n_badge"), "", () => s.notify.title_badge, (n, v) => { n.notify.title_badge = v; })));
  showPane();
  if (focused) $(focused)?.focus?.();
}

/** Text plus a copy in data-text: CSS reserves the bold width from it, so the active (bold) item or tab never changes its width */
function setLabel(e, text) {
  e.textContent = text;
  e.dataset.text = text;
}

/** Every pane's lede sits in one grid cell (only the active one is visible), so the head is as tall as the tallest lede and the first box never moves between panes */
function paintLedes() {
  const box = $("pane-lede");
  if (!box.childElementCount) box.append(...PANES.filter((p) => p.id).map((p) => el("p", { class: "set-pane-lede", "data-lede": p.id })));
  for (const l of box.children) l.textContent = t(paneOf(l.dataset.lede).lede);
}

/** The "changed from default" badge belongs to the Skill title only */
function paintBadge() {
  const badge = $("skill-badge");
  const changed = sk.view?.custom != null;
  badge.hidden = !(changed && pane === "skill");
  if (changed) badge.textContent = t("skill_badge", { n: sk.view.changed });
}

// ---- sidebar ----
// Built once (the links keep their focus across renders); chrome() only refreshes the labels
function buildNav() {
  const nav = $("set-nav");
  if (nav.childElementCount) return;
  nav.append(...PANES.map((p) => p.group
    ? el("div", { class: "set-nav-group", "data-label": p.group })
    : el("a", { class: "set-nav-item", href: `#${p.id}`, "data-pane": p.id }, icon(p.icon), el("span", { "data-label": p.label }))));
}

/** Show the active pane only: its fieldset (the others stay in the DOM, hidden), or the skill section; mark it in the sidebar */
function showPane() {
  const p = paneOf(pane);
  for (const f of document.querySelectorAll("#form fieldset")) f.hidden = f.dataset.pane !== pane;
  $("pane-skill").hidden = pane !== "skill";
  $("pane-title").textContent = t(p.label);
  for (const l of $("pane-lede").children) l.classList.toggle("on", l.dataset.lede === pane);
  paintBadge();
  for (const a of document.querySelectorAll("#set-nav .set-nav-item")) {
    if (a.dataset.pane === pane) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", () => {
  pane = paneFromHash();
  showPane();
});

// ---- the Skill pane ----
// Lives outside #form and outside render(): a save, an SSE settings.updated or a reconnect rebuilds #form, and must never touch the draft.
// `view` is the last GET /api/skill; `loaded` is the text the editor started from (the saved version, or the default when there is none); `draft` is the textarea.
const sk = { view: null, loaded: "", draft: "", tab: "edit", savedAt: null, newer: null, resetArmed: false, resetTimer: 0, built: false, loadError: null };
const SKILL_TABS = ["edit", "preview", "diff"];
const skillDirty = () => sk.view !== null && sk.draft !== sk.loaded;
const skillEditable = () => sk.view?.default != null;
const countLines = (text) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

function buildSkillPane() {
  if (sk.built) return;
  sk.built = true;
  const tabIcons = { edit: "square-pen", preview: "eye", diff: "git-compare" };
  const tabs = el("div", { class: "set-tabs", role: "tablist", id: "skill-tabs" },
    ...SKILL_TABS.map((id) => el("button", { type: "button", role: "tab", id: `skill-tab-${id}`, "aria-controls": `skill-view-${id}`, "data-tab": id }, icon(tabIcons[id]), el("span", { "data-l": `skill_tab_${id}` }))));
  tabs.addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); });
  tabs.addEventListener("keydown", (ev) => {
    const at = SKILL_TABS.indexOf(sk.tab);
    const to = { ArrowRight: (at + 1) % 3, ArrowLeft: (at + 2) % 3, Home: 0, End: 2 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    selectTab(SKILL_TABS[to]);
    $(`skill-tab-${SKILL_TABS[to]}`).focus();
  });
  const area = el("textarea", { id: "skill-text", class: "set-mono", spellcheck: "false", rows: "22" });
  area.addEventListener("input", () => { sk.draft = area.value; paintSkill(); });
  const diffNote = el("p", { class: "set-help", id: "skill-diff-note" });
  const save = el("button", { type: "button", id: "skill-save", class: "primary", onclick: saveSkill }, icon("save"), el("span", { "data-l": "skill_save" }));
  const discard = el("button", { type: "button", id: "skill-discard", onclick: discardSkill }, icon("undo-2"), el("span", { "data-l": "skill_discard" }));
  const reset = el("button", { type: "button", id: "skill-reset", class: "danger", onclick: resetSkillClick }, icon("rotate-ccw"), el("span", { id: "skill-reset-label" }));
  $("pane-skill").append(
    el("p", { class: "set-err", id: "skill-error", role: "alert" }),
    el("div", { class: "set-filebar", id: "skill-file" },
      el("code", { id: "skill-path" }),
      el("span", { id: "skill-lines" }),
      el("span", { id: "skill-saved" }),
      el("span", { class: "set-newer", id: "skill-newer" }, el("span", { "data-l": "skill_newer" }), " ", el("button", { type: "button", id: "skill-load-newer", onclick: () => { if (sk.newer) applySkill(sk.newer, true); } }, el("span", { "data-l": "skill_load_newer" })))),
    tabs,
    el("div", { class: "set-view", id: "skill-view-edit", role: "tabpanel", "aria-labelledby": "skill-tab-edit" }, area),
    el("div", { class: "set-view set-preview", id: "skill-view-preview", role: "tabpanel", "aria-labelledby": "skill-tab-preview", tabindex: "0" }),
    el("div", { class: "set-view", id: "skill-view-diff", role: "tabpanel", "aria-labelledby": "skill-tab-diff", tabindex: "0" }, diffNote, el("div", { class: "set-diff", id: "skill-diff" })),
    el("div", { class: "set-actions" }, el("span", { class: "set-unsaved", id: "skill-unsaved" }, el("span", { class: "set-dot", "aria-hidden": "true" }), el("span", { "data-l": "skill_unsaved" })), reset, discard, save));
}

function selectTab(id) {
  sk.tab = id;
  paintSkill();
}

/** Refresh everything around the textarea from `sk` (never the textarea's own value: that is set only when text is loaded) */
function paintSkill() {
  if (!sk.built) return;
  const lang = currentLocale();
  for (const e of document.querySelectorAll("#pane-skill [data-l]")) setLabel(e, t(e.dataset.l));
  const v = sk.view;
  paintBadge();
  $("skill-error").textContent = sk.loadError ? t("skill_load_failed", { message: sk.loadError }) : v && v.default === null ? t("skill_default_missing") : "";
  // The file line keeps its slots from the first paint (the path arrives with the fetch, "Last saved" after a save): empty or ghost text instead of missing elements
  const path = $("skill-path");
  path.textContent = v?.path ?? "";
  if (v?.path) path.title = v.path; else path.removeAttribute("title");
  $("skill-lines").textContent = t("skill_lines", { n: countLines(sk.draft) });
  const saved = $("skill-saved");
  saved.textContent = t("skill_saved_at", { time: (sk.savedAt ?? new Date(0)).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) });
  saved.classList.toggle("ghost", !sk.savedAt);
  for (const id of SKILL_TABS) {
    const tab = $(`skill-tab-${id}`);
    tab.setAttribute("aria-selected", String(id === sk.tab));
    tab.tabIndex = id === sk.tab ? 0 : -1;
    $(`skill-view-${id}`).hidden = id !== sk.tab;
  }
  $("skill-tabs").setAttribute("aria-label", t("skill_tabs"));
  $("skill-text").setAttribute("aria-label", t("skill_text_label"));
  $("skill-text").disabled = !skillEditable();
  if (sk.tab === "preview") paintPreview();
  if (sk.tab === "diff") paintDiff();
  const dirty = skillDirty();
  $("skill-unsaved").hidden = !dirty;
  $("skill-newer").hidden = !(sk.newer && dirty);
  $("skill-save").disabled = !skillEditable() || !dirty;
  $("skill-discard").disabled = !dirty;
  $("skill-reset").disabled = !skillEditable() || (v?.custom == null);
  const resetLabel = $("skill-reset-label");
  resetLabel.textContent = t(sk.resetArmed ? "skill_reset_confirm" : "skill_reset");
  resetLabel.dataset.text = t("skill_reset_confirm"); // the longer text: the button keeps the width of the armed state
  $("skill-reset").classList.toggle("armed", sk.resetArmed);
}

const currentLocale = () => document.documentElement.lang || "en";

function paintPreview() {
  const box = $("skill-view-preview");
  let html = "";
  try { html = window.marked ? window.marked.parse(sk.draft, { async: false }) : ""; } catch { html = ""; }
  box.innerHTML = sanitize(html);
  for (const img of box.querySelectorAll("img")) img.remove();
}

/** The saved diff, with two lines of context around each change and "…" for the runs in between */
function paintDiff() {
  $("skill-diff-note").textContent = t("skill_diff_note");
  const diff = sk.view?.diff ?? [];
  const box = $("skill-diff");
  if (!diff.some((d) => d.kind !== "same")) { box.replaceChildren(el("p", { class: "set-help", text: t("skill_no_diff") })); return; }
  const keep = new Set();
  diff.forEach((d, i) => { if (d.kind !== "same") for (let j = Math.max(0, i - 2); j <= Math.min(diff.length - 1, i + 2); j++) keep.add(j); });
  const rows = [];
  let gap = false;
  diff.forEach((d, i) => {
    if (!keep.has(i)) { gap = true; return; }
    if (gap && rows.length) rows.push(el("div", { class: "set-diff-gap", text: "…" }));
    gap = false;
    rows.push(el("div", { class: `set-diff-${d.kind}`, text: `${{ add: "+", del: "-", same: " " }[d.kind]} ${d.text}` }));
  });
  box.replaceChildren(...rows);
}

/** Take a server view. `force` (or a clean editor) replaces the draft; a dirty draft is kept and `newer` is remembered */
function applySkill(view, force = false) {
  // The same view again (the reconnect refetch, the echo of our own save): nothing new, so no "newer version" notice
  if (!force && JSON.stringify(view) === JSON.stringify(sk.view)) return;
  const clean = !skillDirty();
  if (!force && !clean) {
    sk.newer = view;
    paintSkill();
    return;
  }
  sk.view = view;
  sk.newer = null;
  sk.loadError = null;
  sk.loaded = view.custom ?? view.default ?? "";
  sk.draft = sk.loaded;
  $("skill-text").value = sk.draft;
  paintSkill();
}

async function loadSkill() {
  try {
    applySkill(await api("/api/skill"));
  } catch (e) {
    sk.loadError = String(e?.message ?? e);
    paintSkill();
  }
}

async function saveSkill() {
  if (!skillEditable() || !skillDirty()) return;
  status(t("set_saving"));
  const sent = sk.draft;
  try {
    const view = await api("/api/skill", { method: "PUT", body: JSON.stringify({ text: sent }) });
    sk.savedAt = new Date();
    if (sk.draft === sent) applySkill(view, true);
    else {
      // Typed while the request was in flight: the saved text becomes the baseline, the newer draft stays
      sk.view = view;
      sk.newer = null;
      sk.loadError = null;
      sk.loaded = view.custom ?? view.default ?? "";
      paintSkill();
    }
    status(t("set_saved"));
  } catch (e) {
    const msg = e.issues?.length ? e.issues.map((i) => i.message).join("; ") : e.message;
    $("skill-error").textContent = t("set_failed", { message: msg });
    status(t("set_failed", { message: msg }), true);
  }
}

function discardSkill() {
  sk.draft = sk.loaded;
  $("skill-text").value = sk.draft;
  paintSkill();
}

// The first click arms the button for 4 s; the second one resets (DELETE /api/skill)
async function resetSkillClick() {
  if (!sk.resetArmed) {
    sk.resetArmed = true;
    clearTimeout(sk.resetTimer);
    sk.resetTimer = setTimeout(() => { sk.resetArmed = false; paintSkill(); }, 4000);
    paintSkill();
    return;
  }
  clearTimeout(sk.resetTimer);
  sk.resetArmed = false;
  try {
    const view = await api("/api/skill", { method: "DELETE" });
    sk.savedAt = null;
    applySkill(view, true);
    status(t("set_saved"));
  } catch (e) {
    paintSkill();
    status(t("set_failed", { message: e.message }), true);
  }
}

window.addEventListener("beforeunload", (ev) => {
  if (!skillDirty()) return;
  ev.preventDefault();
  ev.returnValue = "";
});

document.addEventListener("keydown", (ev) => {
  if (pane !== "skill" || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.key.toLowerCase() !== "s") return;
  ev.preventDefault();
  saveSkill();
});

// ---- start ----
// The static chrome (back link, title) is filled before anything is fetched, so a failed load still has a way back
function chrome() {
  $("set-title").textContent = t("set_title");
  $("set-lede").textContent = t("set_lede");
  buildNav();
  $("set-nav").setAttribute("aria-label", t("set_nav_aria"));
  for (const e of document.querySelectorAll("#set-nav [data-label]")) setLabel(e, t(e.dataset.label));
  paintLedes();
  buildSkillPane();
  paintSkill();
  const back = $("back");
  back.replaceChildren(icon("chevron-left"), el("span", { text: t("set_back") }));
  showPane();
  document.title = `ukagai · ${t("set_title")}`;
}

async function load() {
  s = await api("/api/settings");
  applyChrome();
  render();
}

function loadFailed(e) {
  $("form").replaceChildren(
    el("p", { class: "set-err", role: "alert", id: "load-error", text: t("set_load_failed", { message: String(e?.message ?? e) }) }),
    el("button", { type: "button", id: "load-retry", text: t("set_retry"), onclick: () => start() }));
}

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
  const a = document.activeElement;
  // In a text or number box Esc only leaves the box (which commits what was typed); the next Esc goes back
  if ((a instanceof HTMLInputElement && (a.type === "text" || a.type === "number")) || a instanceof HTMLTextAreaElement) { a.blur(); return; }
  location.href = "/";
});

// Another tab (or the API) changed a setting
let es = null;
function connect() {
  es?.close();
  es = new EventSource("/api/stream");
  es.addEventListener("settings.updated", (e) => {
    const next = JSON.parse(e.data);
    if (JSON.stringify(next) === JSON.stringify(s)) return;
    s = next;
    applyChrome();
    render();
  });
  // Another tab saved or reset the skill: a clean editor follows, a dirty one keeps its draft and offers the newer version
  es.addEventListener("skill.updated", (e) => {
    const next = JSON.parse(e.data);
    if (JSON.stringify(next) === JSON.stringify(sk.view)) return;
    applySkill(next);
  });
  // A reconnect may have missed changes: a stale `s` would be written back by the next whole-object PUT
  es.addEventListener("open", () => { if (s) { load().catch(() => {}); loadSkill(); } });
  es.addEventListener("error", () => { es.close(); setTimeout(connect, 3000); });
}

// Same hygiene as app.js: no stream held open by a page that is gone or cached
window.addEventListener("pagehide", () => es?.close());
window.addEventListener("pageshow", (e) => { if (e.persisted) connect(); });

function start() {
  load().then(connect, loadFailed);
  loadSkill();
}
chrome();
document.body.classList.add("ready");
start();
