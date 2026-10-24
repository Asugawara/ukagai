// The "Ask" panel: side questions about the pending decision, answered by a throwaway fork of the agent session (contract: GET/POST /api/sessions/:id/aside,
// DELETE /api/sessions/:id/aside/running, SSE `aside.updated`). The thread belongs to the session; nothing here ever goes into a decision's answer, comments or instruction.
// app.js owns the screen; this module gets what it needs through `host` (no import cycle):
//   t, el, icon, api, toast, setMarkdown(container, md)  - the GUI's own helpers
//   context()  - null (no item), or { sessionId (null: none), decisionId, title, kind: "question"|"plan", repo, options: [labels], recommended: label|null }
//   lang()     - the display language (the panel is rebuilt when it changes)
const OPEN_KEY = "ukagai.aside.open";
const TA_MAX = 176; // ~8 lines of the 14px / 1.5 textarea
const COPIED_MS = 3000;
const QUOTE_MAX = 1000;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export function createAside(host) {
  const { t, el, icon } = host;
  const panel = document.getElementById("aside");
  const btn = document.getElementById("ask-btn");
  const threads = new Map(); // session_id -> { entries: [], loaded, available, reason, agent, loading }
  const nodes = new Map(); // entry id -> { root, md, ... } (kept across updates so an open trace and a text selection survive)
  let open = safe(() => localStorage.getItem(OPEN_KEY) === "1", false);
  let quote = null; // the composer's quote preview: { source, text }
  let draft = ""; // the composer text, kept while the panel is closed or the shown item changes
  let sending = false;
  let pinned = null; // id of the turn that was just asked: it sits at the top of the viewport
  let lang = host.lang();
  let layoutKey = "";
  let emptyKey = "";
  let ui = null; // the panel's controls once built

  // ---- thread data ----

  const ctxNow = () => host.context();
  const sidOf = (ctx) => ctx?.sessionId ?? null;
  function thread(sid, make = true) {
    let th = threads.get(sid);
    if (!th && make) { th = { entries: [], loaded: false, available: true, reason: "", agent: "", loading: false }; threads.set(sid, th); }
    return th;
  }
  // Only the latest entry of each regenerate chain is shown (at the place of the chain's first entry)
  function visible(th) {
    const byId = new Map(th.entries.map((e) => [e.id, e]));
    const rootOf = (e) => { const seen = new Set(); let x = e; while (x.regenerate_of && byId.has(x.regenerate_of) && !seen.has(x.id)) { seen.add(x.id); x = byId.get(x.regenerate_of); } return x.id; };
    const groups = new Map();
    for (const e of th.entries) {
      const r = rootOf(e);
      const g = groups.get(r);
      if (g) g.latest = e; else groups.set(r, { first: e, latest: e });
    }
    return [...groups.values()].map((g) => g.latest);
  }
  const running = (th) => th?.entries.find((e) => e.status === "running") ?? null;

  async function load(sid, { force = false } = {}) {
    const th = thread(sid);
    if (th.loading || (th.loaded && !force)) return;
    th.loading = true;
    try {
      const data = await host.api(`/api/sessions/${encodeURIComponent(sid)}/aside`);
      th.entries = Array.isArray(data?.entries) ? data.entries : [];
      th.available = data?.available !== false;
      th.reason = data?.unavailable_reason ?? "";
      th.agent = data?.agent ?? "";
    } catch (e) {
      if (e?.message === "unauthorized") throw e;
      th.available = false;
      th.reason = e?.status === 404 ? "unknown session" : (e?.message ?? "");
    } finally {
      th.loading = false;
      th.loaded = true;
    }
    refresh();
  }

  function upsert(sid, entry) {
    if (!entry || typeof entry.id !== "string") return;
    const th = thread(sid);
    const i = th.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) th.entries[i] = entry; else th.entries.push(entry);
    if (th.entries.length > 50) th.entries.splice(0, th.entries.length - 50);
    th.loaded = true;
  }

  function onUpdated(data) {
    if (!data || typeof data.session_id !== "string") return;
    upsert(data.session_id, data.entry);
    if (data.session_id === sidOf(ctxNow())) refresh();
  }
  document.addEventListener("aside:updated", (e) => onUpdated(e.detail)); // the same entry point as the SSE event (the GUI tests drive it)

  // ---- open / close ----

  const canAsk = () => !!sidOf(ctxNow());
  const shown = () => open && canAsk();
  function remember() { safe(() => localStorage.setItem(OPEN_KEY, open ? "1" : "0")); }
  function setOpen(on, { focus = true } = {}) {
    if (on && !canAsk()) { host.toast(t("aside_no_session")); return; }
    open = on;
    remember();
    if (on) {
      const sid = sidOf(ctxNow());
      if (sid) load(sid, { force: true });
    } else if (panel.contains(document.activeElement)) document.activeElement.blur();
    refresh();
    if (on && focus) ui?.ta.focus();
  }
  const toggle = () => setOpen(!shown());

  // ---- sending ----

  async function post(body, sid) {
    if (sending) return false;
    const th = thread(sid);
    if (running(th)) { host.toast(t("aside_busy")); return false; }
    sending = true;
    refresh();
    try {
      const r = await host.api(`/api/sessions/${encodeURIComponent(sid)}/aside`, { method: "POST", body: JSON.stringify(body) });
      upsert(sid, r.entry);
      pinned = r.entry.id;
      layoutKey = "";
      return true;
    } catch (e) {
      if (e?.message === "unauthorized") throw e;
      if (e?.message === "running") host.toast(t("aside_busy"));
      else host.toast(t("aside_failed", { error: e?.message ?? String(e) }), { kind: "lost" });
      load(sid, { force: true });
      return false;
    } finally {
      sending = false;
      refresh();
    }
  }

  async function submit(question, fromComposer = false) {
    const ctx = ctxNow();
    const sid = sidOf(ctx);
    const q = question.trim().slice(0, 4000);
    if (!sid || !q) return;
    const body = { question: q, decision_id: ctx.decisionId };
    if (quote) body.quote = { source: quote.source, text: quote.text };
    if (await post(body, sid)) {
      quote = null;
      if (fromComposer) { draft = ""; if (ui) { ui.ta.value = ""; autosize(); } }
      refresh();
    }
  }
  const regenerate = (entry) => {
    const sid = sidOf(ctxNow());
    if (sid) post({ question: entry.question, ...(entry.quote ? { quote: entry.quote } : {}), decision_id: entry.decision_id, regenerate_of: entry.id }, sid);
  };
  async function stop() {
    const sid = sidOf(ctxNow());
    if (!sid) return;
    try {
      const r = await host.api(`/api/sessions/${encodeURIComponent(sid)}/aside/running`, { method: "DELETE" });
      if (r?.entry) upsert(sid, r.entry);
    } catch (e) {
      if (e?.message === "unauthorized") throw e;
      load(sid, { force: true });
    }
    refresh();
  }

  // Ask from the selection popover: open the panel with the selection as the quote
  function ask(q) {
    if (!canAsk()) { host.toast(t("aside_no_session")); return; }
    quote = { source: q.source, text: String(q.text).slice(0, QUOTE_MAX) };
    setOpen(true);
    refresh();
    ui?.ta.focus();
  }

  // ---- DOM: the panel chrome ----

  function build() {
    lang = host.lang();
    nodes.clear();
    layoutKey = "";
    emptyKey = "";
    const close = el("button", { class: "as-x", type: "button", "aria-label": t("aside_close"), title: t("aside_close"), onclick: () => setOpen(false) }, icon("x"));
    const viewport = el("div", { class: "as-viewport", role: "log", "aria-label": t("aside_thread_aria"), tabindex: "0" });
    const toBottom = el("button", { class: "as-s2b", type: "button", hidden: true, "aria-label": t("aside_to_bottom"), title: t("aside_to_bottom"), onclick: () => viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }) }, icon("arrow-down"));
    const qText = el("i");
    const qprev = el("div", { class: "as-qprev", hidden: true }, qText, el("button", { class: "as-qx", type: "button", "aria-label": t("aside_quote_remove"), title: t("aside_quote_remove"), onclick: () => { quote = null; refresh(); ta.focus(); } }, icon("x")));
    const ta = el("textarea", { class: "as-ta", rows: "1", maxlength: "4000", placeholder: t("aside_placeholder"), "aria-label": t("aside_composer_aria") });
    const hint = el("span", { class: "as-hint" });
    const send = el("button", { class: "as-send", type: "button", onclick: () => (running(thread(sidOf(ctxNow()))) ? stop() : submit(ta.value, true)) });
    const composer = el("div", { class: "as-composer" }, qprev, ta, el("div", { class: "as-crow" }, hint, send));
    ta.addEventListener("input", () => { draft = ta.value; autosize(); refresh(); });
    ta.addEventListener("focus", () => composer.classList.add("focus"));
    ta.addEventListener("blur", () => composer.classList.remove("focus"));
    ta.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      if (ta.value.trim() && !running(thread(sidOf(ctxNow()))) && !sending) submit(ta.value, true);
    });
    panel.replaceChildren(
      el("div", { class: "as-ph" }, el("b", { text: t("aside_title") }), el("span", { class: "as-note", text: t("aside_note") }), close),
      el("div", { class: "as-body" }, viewport, toBottom),
      el("div", { class: "as-foot" }, composer));
    panel.setAttribute("aria-label", t("aside_aria"));
    viewport.addEventListener("scroll", syncBottom, { passive: true });
    ui = { viewport, toBottom, qprev, qText, ta, hint, send, composer };
    ta.value = draft;
    autosize();
  }
  // Every key typed in the panel stays in the panel (the screen's own keys must not fire); Esc closes it, the answer keeps running
  panel.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape" && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); setOpen(false); }
  });

  function autosize() {
    if (!ui || safe(() => CSS.supports("field-sizing", "content"), false)) return;
    ui.ta.style.height = "auto";
    ui.ta.style.height = `${Math.min(ui.ta.scrollHeight, TA_MAX)}px`;
  }
  function syncBottom() {
    if (!ui) return;
    const v = ui.viewport;
    ui.toBottom.hidden = !(v.scrollHeight - v.scrollTop - v.clientHeight > 80);
  }

  // ---- DOM: turns ----

  const tokens = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`);
  const usageText = (u) => {
    if (!u) return "";
    const parts = [t("aside_tokens", { n: tokens((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) })];
    if (typeof u.cost_usd === "number") parts.push(u.cost_usd > 0 && u.cost_usd < 0.001 ? "<$0.001" : `$${u.cost_usd.toFixed(3)}`);
    return parts.join(" · ");
  };
  const KINDS = ["read", "search", "command", "tool"];
  function traceSummary(trace) {
    const parts = [];
    for (const k of KINDS) {
      const n = trace.filter((x) => x.kind === k).length;
      if (n) parts.push(t(n === 1 ? `aside_trace_${k}_1` : `aside_trace_${k}_n`, { n }));
    }
    return parts.join(", ");
  }

  function buildTurn(entry) {
    const bubble = el("div", { class: "as-bubble" });
    if (entry.quote) bubble.append(el("div", { class: "as-qb", text: entry.quote.text }));
    bubble.append(el("div", { class: "as-q", text: entry.question }));
    const n = {
      root: el("div", { class: "as-turn", "data-id": entry.id }),
      trace: el("div", { class: "as-trace-slot" }),
      md: el("div", { class: "as-md md" }),
      status: el("div", { class: "as-status" }),
      bar: null,
      traceKey: "",
      answer: null,
      entry,
    };
    n.am = el("div", { class: "as-am" }, n.trace, n.md, n.status);
    n.root.append(el("div", { class: "as-um" }, bubble), n.am);
    return n;
  }

  function buildBar(n) {
    const copy = el("button", { class: "as-act as-copy", type: "button", title: t("aside_copy"), "aria-label": t("aside_copy"), onclick: async () => {
      try { await navigator.clipboard.writeText(n.entry.answer); } catch { host.toast(t("copy_failed")); return; }
      copy.replaceChildren(icon("check"));
      copy.classList.add("done");
      copy.setAttribute("aria-label", t("aside_copied"));
      clearTimeout(copy._timer);
      copy._timer = setTimeout(() => { copy.replaceChildren(icon("copy")); copy.classList.remove("done"); copy.setAttribute("aria-label", t("aside_copy")); }, COPIED_MS);
    } }, icon("copy"));
    const again = el("button", { class: "as-act as-regen", type: "button", title: t("aside_regenerate"), "aria-label": t("aside_regenerate"), onclick: () => regenerate(n.entry) }, icon("rotate-ccw"));
    return { root: el("div", { class: "as-bar" }, copy, again, el("span", { class: "as-usage" })), again };
  }

  function patchTurn(n, entry, busy) {
    n.entry = entry;
    const live = entry.status === "running";
    n.root.classList.toggle("running", live);
    // trace line: "Thinking…" until text or a trace arrives, then the expandable list
    const tk = `${live}|${JSON.stringify(entry.trace ?? [])}|${entry.answer ? 1 : 0}`;
    if (tk !== n.traceKey) {
      n.traceKey = tk;
      const trace = entry.trace ?? [];
      if (trace.length) {
        let d = n.trace.querySelector("details");
        if (!d) {
          d = el("details", { class: "as-trace" }, el("summary", {}, el("span", { class: "as-dot" }), el("span", { class: "as-trace-text" })), el("ul"));
          n.trace.replaceChildren(d);
        }
        d.querySelector(".as-trace-text").textContent = traceSummary(trace);
        d.classList.toggle("live", live);
        d.querySelector("ul").replaceChildren(...trace.map((x) => el("li", {}, el("span", { class: "as-k", text: t(`aside_kind_${KINDS.includes(x.kind) ? x.kind : "tool"}`) }), el("code", { text: x.label }))));
      } else if (live && !entry.answer) {
        n.trace.replaceChildren(el("div", { class: "as-thinking" }, el("span", { class: "as-dot" }), t("aside_thinking")));
      } else n.trace.replaceChildren();
    }
    if (n.answer !== entry.answer) { n.answer = entry.answer; host.setMarkdown(n.md, entry.answer ?? ""); }
    n.md.hidden = !entry.answer;
    for (const c of n.md.querySelectorAll(".as-cursor")) c.remove();
    if (live && entry.answer) {
      let tail = n.md;
      while (tail.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE|DIV|DETAILS|P)$/.test(tail.lastElementChild.tagName)) tail = tail.lastElementChild;
      tail.append(el("span", { class: "as-cursor", "aria-hidden": "true" }));
    }
    // status: error with a retry, or "Stopped"
    if (entry.status === "error") {
      n.status.replaceChildren(el("div", { class: "as-err", role: "alert" },
        el("span", { class: "as-err-msg", text: entry.error || t("aside_error") }),
        el("button", { class: "btn as-retry", type: "button", disabled: busy, onclick: () => regenerate(n.entry) }, t("aside_try_again"))));
    } else if (entry.status === "cancelled") n.status.replaceChildren(el("div", { class: "as-stopped", text: t("aside_stopped") }));
    else n.status.replaceChildren();
    const retry = n.status.querySelector(".as-retry");
    if (retry) retry.disabled = busy;
    // action bar under a finished answer
    if (entry.status === "done") {
      if (!n.bar) { n.bar = buildBar(n); n.am.append(n.bar.root); }
      n.bar.root.querySelector(".as-usage").textContent = usageText(entry.usage);
      const u = entry.usage;
      n.bar.root.querySelector(".as-usage").title = u?.cache_read_tokens ? t("aside_cache", { n: tokens(u.cache_read_tokens) }) : "";
      n.bar.again.disabled = busy;
    } else if (n.bar) { n.bar.root.remove(); n.bar = null; }
  }

  // ---- DOM: render everything that depends on the data ----

  function greeting(ctx) {
    const labels = ctx.kind === "plan"
      ? [t("aside_sug_p_risk"), t("aside_sug_p_left"), t("aside_sug_p_verify")]
      : (() => {
        const other = ctx.options.find((o) => o !== ctx.recommended);
        return [t("aside_sug_q_why"), other ? t("aside_sug_q_pick", { label: other }) : t("aside_sug_q_pick_any"), t("aside_sug_q_change")];
      })();
    return el("div", { class: "as-greet-box" },
      el("div", { class: "as-greet", text: t("aside_greet", { repo: ctx.repo }) }),
      el("div", { class: "as-greet-sub", text: t("aside_greet_sub") }),
      el("div", { class: "as-sugs" }, ...labels.map((q) => el("button", { class: "as-sug", type: "button", onclick: () => submit(q) }, q))));
  }

  function render() {
    const ctx = ctxNow();
    const sid = sidOf(ctx);
    const on = !!sid && open;
    panel.hidden = !on;
    document.body.classList.toggle("aside-open", on);
    btn.setAttribute("aria-expanded", String(on));
    btn.classList.toggle("on", on);
    if (!ctx) { btn.hidden = true; return; }
    const th = sid ? thread(sid) : null;
    const vis = th ? visible(th) : [];
    // header button: label + the number of answers of this session; disabled (with the reason as its tooltip) when there is no session
    btn.hidden = false;
    btn.replaceChildren(el("span", { text: t("aside_btn") }));
    if (vis.length > 0) btn.append(el("span", { class: "ask-count", text: String(vis.length) }));
    btn.setAttribute("aria-disabled", String(!sid));
    btn.title = sid ? t("aside_btn_tip") : t("aside_no_session");
    if (!on) return;
    if (!ui || lang !== host.lang()) build();
    const busy = !!running(th) || sending;
    // thread
    const key = vis.map((e) => `${e.id}:${e.decision_id}`).join(",") + (vis.length ? "" : `|${ctx.repo}|${ctx.kind}|${ctx.options.join("\u0001")}|${ctx.recommended}`);
    ui.viewport.classList.toggle("empty", vis.length === 0);
    if (key !== layoutKey) {
      layoutKey = key;
      for (const id of [...nodes.keys()]) if (!th.entries.some((e) => e.id === id)) nodes.delete(id);
      if (!vis.length) ui.viewport.replaceChildren(greeting(ctx));
      else {
        const kids = [];
        vis.forEach((e, i) => {
          let n = nodes.get(e.id);
          if (!n) { n = buildTurn(e); nodes.set(e.id, n); }
          if (i > 0 && vis[i - 1].decision_id !== e.decision_id) kids.push(el("div", { class: "as-sep", role: "separator" }, el("span", { text: e.decision_title ?? "" })));
          kids.push(n.root);
        });
        ui.viewport.replaceChildren(...kids);
      }
    }
    vis.forEach((e, i) => {
      const n = nodes.get(e.id);
      patchTurn(n, e, busy);
      n.root.classList.toggle("last", i === vis.length - 1);
    });
    // a question just sent sits at the top of the viewport (room below it so it can)
    if (pinned) {
      const n = nodes.get(pinned);
      if (n?.root.isConnected) {
        for (const x of nodes.values()) if (x !== n) x.root.style.minHeight = "";
        n.root.style.minHeight = `${Math.max(0, ui.viewport.clientHeight - 24)}px`;
        ui.viewport.scrollTop = n.root.offsetTop - 12;
        pinned = null;
      }
    }
    // composer
    ui.qprev.hidden = !quote;
    if (quote) { ui.qText.textContent = quote.text; ui.qText.title = quote.text; }
    const unavailable = th && !th.available;
    ui.ta.disabled = !!unavailable;
    const isRun = !!running(th);
    ui.send.classList.toggle("stop", isRun);
    ui.send.replaceChildren(isRun ? el("i") : icon("arrow-up"));
    ui.send.setAttribute("aria-label", t(isRun ? "aside_stop" : "aside_send"));
    ui.send.title = t(isRun ? "aside_stop" : "aside_send");
    ui.send.disabled = isRun ? false : (!ui.ta.value.trim() || busy || !!unavailable);
    ui.hint.textContent = unavailable ? t("aside_unavailable", { reason: th.reason || "-" }) : t(isRun ? "aside_hint_running" : "aside_hint");
    ui.composer.classList.toggle("off", !!unavailable);
    syncBottom();
  }

  function refresh() { render(); }

  // The shown item changed (or the language did): fetch the session's thread once, then draw
  function sync() {
    const sid = sidOf(ctxNow());
    if (sid && !thread(sid).loaded) load(sid);
    refresh();
  }

  btn.addEventListener("click", () => { if (!canAsk()) { host.toast(t("aside_no_session")); return; } toggle(); });
  window.addEventListener("resize", () => { if (ui && shown()) syncBottom(); });
  return {
    toggle,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: shown,
    canAsk,
    sync,
    onUpdated,
    ask,
    // After an SSE reconnect: events may have been missed
    resync() { const sid = sidOf(ctxNow()); if (sid && shown()) load(sid, { force: true }); },
  };
}
