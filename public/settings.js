// The settings page (/settings): every control saves at once with PUT /api/settings (the whole object, validated by the server).
import { api } from "./api.js";
import { t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const DELAY_MIN = 30; // same limits as CODEX_DELAY_MIN_S / MAX_S in src/contract.ts
const DELAY_MAX = 3600;
const WT_RE = /\/\.herdr\/worktrees\/([^/]+)\/([^/]+)/; // same repo naming as app.js
const repoOfCwd = (cwd) => WT_RE.exec(cwd)?.[1] ?? (cwd.split("/").filter(Boolean).pop() || cwd);

let s = null; // the saved settings
let seen = []; // repo names from the current decisions and sessions
let idSeq = 0; // checkbox ids are stable across renders (the focused control keeps its focus)
let colorDraft = ""; // text of the "add a repository" box (kept across re-renders)

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

function fieldset(title, ...rows) {
  return el("fieldset", {}, el("legend", { text: title }), ...rows);
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

// ---- repository colours ----
const hueOf = (name) => (typeof s.repo_colors[name] === "number" ? s.repo_colors[name] : null);
// The default hue of a repo name: the same hash as repoSlot in app.js / src/tui/model.ts (FNV-1a -> 12 slots)
function hashHue(name) {
  let h = 0x811c9dc5;
  for (const ch of name) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return (238 + (h % 12) * 27) % 360;
}
function swatchStyle(name) {
  const o = Object.hasOwn(s.repo_colors, name) ? s.repo_colors[name] : undefined;
  return o === "grey" ? "--repo-hue:0;--repo-sat:0%" : `--repo-hue:${typeof o === "number" ? o : hashHue(name)}`;
}
function colorRow(name) {
  const custom = Object.hasOwn(s.repo_colors, name);
  const grey = s.repo_colors[name] === "grey";
  const swatch = el("span", { class: "color-swatch", style: swatchStyle(name), "data-swatch": name, "aria-hidden": "true" });
  const slider = el("input", { type: "range", min: "0", max: "359", step: "1", value: String(hueOf(name) ?? hashHue(name)), "aria-label": t("set_hue_for", { repo: name }), "data-hue": name, disabled: grey });
  // The swatch follows the slider while it moves; the value is saved when it is released
  slider.addEventListener("input", () => swatch.setAttribute("style", `--repo-hue:${slider.value}`));
  slider.addEventListener("change", () => save((n) => { n.repo_colors[name] = Number(slider.value); }));
  const greyBtn = el("button", { type: "button", "data-grey": name, "aria-pressed": String(grey), text: t("set_grey"), onclick: () => save((n) => { n.repo_colors[name] = "grey"; }) });
  const reset = el("button", { type: "button", "data-reset": name, disabled: !custom, text: t("set_reset"), onclick: () => save((n) => { delete n.repo_colors[name]; }) });
  const label = el("span", { class: "color-name", title: name }, name, custom ? el("span", { class: "tag", text: t("set_custom") }) : null);
  return el("div", { class: "color-row" }, swatch, label, slider, greyBtn, reset);
}
function colorSection() {
  const names = [...new Set([...seen, ...Object.keys(s.repo_colors)])].sort((a, b) => a.localeCompare(b));
  const add = el("input", { type: "text", id: "color-add-name", "aria-label": t("set_add_label"), placeholder: t("set_add_label"), maxlength: "200", value: colorDraft });
  add.addEventListener("input", () => { colorDraft = add.value; });
  const addBtn = el("button", { type: "button", id: "color-add-btn", text: t("set_add") });
  const doAdd = () => {
    const name = add.value.trim();
    if (!name) return;
    colorDraft = "";
    if (Object.hasOwn(s.repo_colors, name)) { render(); return; }
    save((n) => { n.repo_colors[name] = hashHue(name); });
  };
  addBtn.addEventListener("click", doAdd);
  add.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); doAdd(); } });
  return fieldset(t("set_g_colors"),
    el("p", { class: "set-help", text: t("set_colors_help") }),
    el("div", { id: "color-list" }, ...(names.length ? names.map(colorRow) : [el("p", { class: "muted", text: t("set_colors_empty") })])),
    el("div", { class: "color-add" }, add, addBtn));
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
    fieldset(t("set_g_display"),
      select(t("set_lang"), "lang", s.lang, [["en", "English"], ["ja", "日本語"]], (v) => save((n) => { n.lang = v; })),
      select(t("set_theme"), "theme", s.theme, [["system", t("set_theme_system")], ["light", t("set_theme_light")], ["dark", t("set_theme_dark")]], (v) => save((n) => { n.theme = v; })),
      toggle(t("set_hints"), "", () => s.hints, (n, v) => { n.hints = v; })),
    fieldset(t("set_g_checkpoints"),
      toggle(t("set_cp_enabled"), t("set_cp_enabled_help"), () => s.checkpoints.enabled, (n, v) => { n.checkpoints.enabled = v; }),
      el("div", { class: "set-row" }, el("label", { for: delayId, text: t("set_cp_delay") }), delay, el("p", { class: "set-help", text: t("set_cp_delay_help") }), delayErr),
      toggle(t("set_cp_terminal"), t("set_cp_terminal_help"), () => s.checkpoints.terminal_delivery, (n, v) => { n.checkpoints.terminal_delivery = v; })),
    fieldset(t("set_g_plans"),
      toggle(t("set_plans_auto"), t("set_plans_auto_help"), () => s.plans.auto_show, (n, v) => { n.plans.auto_show = v; })),
    fieldset(t("set_g_notify"),
      toggle(t("set_n_sound"), t("set_n_sound_help"), () => s.notify.sound, (n, v) => { n.notify.sound = v; }),
      toggle(t("set_n_browser"), t("set_n_browser_help"), () => s.notify.browser, (n, v) => { n.notify.browser = v; }, {
        before: browserToggle,
        note: () => el("p", { class: "set-help", id: "perm-state", text: permText() }),
      }),
      toggle(t("set_n_badge"), "", () => s.notify.title_badge, (n, v) => { n.notify.title_badge = v; })),
    colorSection());
  if (focused) $(focused)?.focus?.();
}

// ---- start ----
// The static chrome (back link, title) is filled before anything is fetched, so a failed load still has a way back
function chrome() {
  $("back").textContent = t("set_back");
  $("set-title").textContent = t("set_title");
  $("set-lede").textContent = t("set_lede");
  document.title = `ukagai · ${t("set_title")}`;
}

async function load() {
  s = await api("/api/settings");
  applyChrome();
  const [ds, ss] = await Promise.all([api("/api/decisions").catch(() => []), api("/api/sessions").catch(() => [])]);
  seen = [...new Set([...(Array.isArray(ds) ? ds : []).map((d) => d.session?.cwd), ...(Array.isArray(ss) ? ss : []).map((x) => x.cwd)].filter(Boolean).map(repoOfCwd))];
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
  if (a instanceof HTMLInputElement && (a.type === "text" || a.type === "number")) { a.blur(); return; }
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
