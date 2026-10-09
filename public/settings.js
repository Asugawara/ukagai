// The settings page (/settings): every control saves at once with PUT /api/settings (the whole object, validated by the server).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";

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
  $("pane-head").hidden = pane === "skill";
  $("pane-title").textContent = t(p.label);
  $("pane-lede").textContent = t(p.lede);
  for (const a of document.querySelectorAll("#set-nav .set-nav-item")) {
    if (a.dataset.pane === pane) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", () => {
  pane = paneFromHash();
  showPane();
});

// ---- start ----
// The static chrome (back link, title) is filled before anything is fetched, so a failed load still has a way back
function chrome() {
  $("set-title").textContent = t("set_title");
  $("set-lede").textContent = t("set_lede");
  buildNav();
  $("set-nav").setAttribute("aria-label", t("set_nav_aria"));
  for (const e of document.querySelectorAll("#set-nav [data-label]")) e.textContent = t(e.dataset.label);
  $("skill-title").textContent = t("set_nav_skill");
  $("skill-lede").textContent = t("set_lede_skill");
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
  // A reconnect may have missed changes: a stale `s` would be written back by the next whole-object PUT
  es.addEventListener("open", () => { if (s) load().catch(() => {}); });
  es.addEventListener("error", () => { es.close(); setTimeout(connect, 3000); });
}

// Same hygiene as app.js: no stream held open by a page that is gone or cached
window.addEventListener("pagehide", () => es?.close());
window.addEventListener("pageshow", (e) => { if (e.persisted) connect(); });

function start() {
  load().then(connect, loadFailed);
}
chrome();
start();
