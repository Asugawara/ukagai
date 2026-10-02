// ukagai GUI。ユーザー由来の文字列は textContent で入れる。innerHTML は marked / mermaid の出力だけ。
const MULTI_SELECT_SEPARATOR = ", "; // src/contract.ts と同じ値

const decisions = new Map();
const sessions = new Map();
const drafts = new Map(); // id -> { sel: Map<qIndex, Set<label>>, rejecting, reason }
let selectedId = null;

const $ = (id) => document.getElementById(id);

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

async function api(path, init) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (res.status === 401) {
    showBanner("ページを再読み込みしてください");
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

// ---- サニタイズ(marked の出力用) ----

function sanitize(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/?script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, "");
}

// ---- 表示補助 ----

function sessionTitle(d) {
  const s = d.session;
  return s.title || d.context?.ai_title || s.cwd.split("/").filter(Boolean).pop() || s.cwd;
}

function elapsed(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  return `${Math.floor(sec / 3600)}時間`;
}

function diffBlock(text) {
  const pre = el("pre", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    pre.append(el("span", { class: cls, text: line + "\n" }));
  }
  return pre;
}

// ---- 保留一覧 ----

function visibleDecisions() {
  return [...decisions.values()]
    .filter((d) => d.status === "pending" || d.id === selectedId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function renderList() {
  const list = $("pending-list");
  list.replaceChildren();
  const items = visibleDecisions();
  $("pending-count").textContent = `(${items.filter((d) => d.status === "pending").length})`;
  for (const d of items) {
    const meta = el("div", { class: "meta" },
      el("span", { text: d.kind === "approve_plan" ? "📋 計画" : "❓ 質問" }),
      el("span", { class: "age", "data-created": d.created_at, text: elapsed(d.created_at) }));
    if (d.session.agent_type) meta.append(el("span", { class: "badge", text: d.session.agent_type }));
    if (d.explanation?.attached_via === "none" || !d.explanation) meta.append(el("span", { class: "badge none", text: "説明なし" }));
    const row = el("button", {
      class: "row" + (d.id === selectedId ? " selected" : ""),
      onclick: () => select(d.id),
    }, el("div", { class: "title", text: sessionTitle(d) }), meta);
    list.append(el("li", {}, row));
  }
}

function select(id) {
  selectedId = id;
  renderList();
  renderDetail();
}

// ---- カード ----

function draftOf(d) {
  let dr = drafts.get(d.id);
  if (!dr) drafts.set(d.id, (dr = { sel: new Map(), rejecting: false, reason: "" }));
  return dr;
}

const STATUS_TEXT = {
  answer_submitted: "エージェントに届けています…",
  answered: "届きました",
  answer_lost: "ターミナルに落ちました(hook が切断)",
  hook_disconnected: "hook が切断されました",
  fallback: "ターミナルで答えます",
  cancelled: "キャンセルされました",
};

async function send(d, body, btn) {
  document.querySelectorAll("#card button").forEach((b) => (b.disabled = true));
  try {
    const updated = await post(`/api/decisions/${d.id}/answer`, body);
    decisions.set(updated.id, updated);
  } catch (e) {
    if (e.message !== "unauthorized") showBanner(`送信に失敗しました: ${e.message}`);
  }
  renderList();
  renderDetail();
}

function renderCard(d) {
  const card = el("div", { class: "panel" });
  const dr = draftOf(d);
  const closed = d.status !== "pending";
  if (STATUS_TEXT[d.status]) card.append(el("div", { class: "status", text: STATUS_TEXT[d.status] }));

  if (d.kind === "answer_question") {
    const qs = d.request.questions;
    qs.forEach((q, qi) => {
      const sel = dr.sel.get(qi) ?? dr.sel.set(qi, new Set()).get(qi);
      const box = el("div", { class: "q" },
        el("div", { class: "header", text: q.header }),
        el("div", { class: "question", text: q.question }));
      for (const o of q.options) {
        const input = el("input", {
          type: q.multiSelect ? "checkbox" : "radio",
          name: `q${qi}`,
          disabled: closed,
          checked: sel.has(o.label),
          onchange: (ev) => {
            if (q.multiSelect) ev.target.checked ? sel.add(o.label) : sel.delete(o.label);
            else { sel.clear(); sel.add(o.label); }
            updateSubmit();
          },
        });
        box.append(el("label", { class: "opt" }, input,
          el("span", {}, el("div", { text: o.label }), o.description ? el("div", { class: "desc", text: o.description }) : null)));
      }
      card.append(box);
    });
    const complete = () => qs.every((_, qi) => (dr.sel.get(qi)?.size ?? 0) > 0);
    const submit = el("button", {
      class: "btn primary", id: "submit", disabled: closed || !complete(),
      onclick: () => {
        const answers = {};
        qs.forEach((q, qi) => {
          const picked = q.options.map((o) => o.label).filter((l) => dr.sel.get(qi).has(l));
          answers[q.question] = picked.join(MULTI_SELECT_SEPARATOR);
        });
        send(d, { answers });
      },
      text: "回答する",
    });
    function updateSubmit() { submit.disabled = closed || !complete(); }
    card.append(el("div", { class: "actions" }, submit, terminalButton(d, closed)));
  } else {
    card.append(el("div", { class: "md", id: "plan-body" }));
    const actions = el("div", { class: "actions" },
      el("button", { class: "btn primary", disabled: closed, text: "承認", onclick: () => send(d, { approve: true, set_mode_auto: false }) }),
      el("button", { class: "btn", disabled: closed, text: "承認して auto", onclick: () => send(d, { approve: true, set_mode_auto: true }) }),
      el("button", { class: "btn danger", disabled: closed, text: "却下", onclick: () => { dr.rejecting = true; renderDetail(); } }),
      terminalButton(d, closed));
    card.append(actions);
    if (dr.rejecting && !closed) {
      const input = el("input", {
        type: "text", placeholder: "却下の理由(必須)", value: dr.reason,
        oninput: (ev) => { dr.reason = ev.target.value; confirm.disabled = !dr.reason.trim(); },
      });
      const confirm = el("button", {
        class: "btn danger", disabled: !dr.reason.trim(), text: "却下を送る",
        onclick: () => send(d, { approve: false, reason: dr.reason.trim() }),
      });
      card.append(input, el("div", { class: "actions" }, confirm));
    }
  }
  return card;
}

function terminalButton(d, closed) {
  return el("button", { class: "btn", disabled: closed, text: "ターミナルで答える", onclick: () => send(d, { fallback: true }) });
}

// ---- Markdown / Mermaid / diff ----

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
    if (!m) throw new Error("mermaid が読み込まれていません");
    const { svg } = await m.render(id, source);
    const box = el("div", { class: "mermaid-ok" });
    box.innerHTML = svg;
    pre.replaceWith(box);
  } catch (e) {
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
    const msg = String(e?.message ?? e).split("\n")[0];
    pre.before(el("div", { class: "mermaid-err", text: `Mermaid の描画に失敗しました: ${msg}` }));
    pre.textContent = source;
  }
}

function renderMarkdown(container, md) {
  const html = sanitize(window.marked.parse(md, { async: false }));
  container.innerHTML = html;
  for (const code of container.querySelectorAll("pre > code.language-diff")) {
    code.closest("pre").replaceWith(diffBlock(code.textContent ?? ""));
  }
  return Promise.all([...container.querySelectorAll("pre > code.language-mermaid")].map(renderMermaid));
}

function renderExplanation(d) {
  const root = $("explanation");
  root.replaceChildren();
  const ex = d.explanation;
  if (!ex || ex.attached_via === "none") {
    const reason = ex?.none_reason ?? "";
    root.append(el("div", { class: "panel muted", text: `エージェントは説明を書きませんでした${reason ? `(理由: ${reason})` : ""}` }));
    return;
  }
  const { fm, body } = parseFrontMatter(ex.markdown);
  const panel = el("div", { class: "panel" });
  const rev = fm.reversibility ?? ex.reversibility;
  if (rev === "irreversible" || rev === "costly") {
    panel.append(el("div", { class: `band ${rev}`, text: rev === "irreversible" ? "元に戻せない" : "戻すのにコストがかかる" }));
  }
  const table = el("table", { class: "fm" });
  for (const [label, val] of [["title", fm.title ?? ex.title], ["reversibility", rev], ["scope", fm.scope ?? ex.scope]]) {
    if (val) table.append(el("tr", {}, el("th", { text: label }), el("td", { text: val })));
  }
  panel.append(table);
  const md = el("div", { class: "md" });
  panel.append(md);
  root.append(panel);
  renderMarkdown(md, body);
}

// ---- 補助文脈 ----

function renderContext(d) {
  const body = $("context-body");
  body.replaceChildren();
  const c = d.context ?? {};
  if (c.last_assistant_text) body.append(el("h2", { text: "直前のエージェント発言" }), el("pre", { text: c.last_assistant_text }));
  if (c.recent_tools?.length) {
    const ul = el("ul");
    for (const t of c.recent_tools) ul.append(el("li", { text: `${t.name}: ${t.summary}` }));
    body.append(el("h2", { text: "直近のツール" }), ul);
  }
  if (c.branch || c.git_diff_stat) {
    body.append(el("h2", { text: `git${c.branch ? `(${c.branch})` : ""}` }));
    if (c.git_diff_stat) body.append(el("pre", { text: c.git_diff_stat }));
  }
  if (c.git_diff) body.append(el("h2", { text: "git diff" }), diffBlock(c.git_diff));
  if (!body.children.length) body.append(el("p", { class: "muted", text: "文脈はありません。" }));
}

function renderDetail() {
  const d = decisions.get(selectedId);
  if (!d) {
    $("card").replaceChildren(el("p", { class: "muted", text: "判断を選んでください。" }));
    $("explanation").replaceChildren();
    $("context-body").replaceChildren();
    return;
  }
  const card = renderCard(d);
  $("card").replaceChildren(card);
  if (d.kind === "approve_plan") renderMarkdown(card.querySelector("#plan-body"), d.request.plan);
  // 説明は判断ごとに 1 回描けばよい。状態更新のたびに描き直さない
  if ($("explanation").dataset.id !== d.id) {
    $("explanation").dataset.id = d.id;
    renderExplanation(d);
    renderContext(d);
  }
}

// ---- セッション / メトリクス ----

function renderSessions() {
  const ul = $("sessions-list");
  ul.replaceChildren();
  const items = [...sessions.values()].sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  if (!items.length) ul.append(el("li", { class: "muted", text: "セッションなし" }));
  for (const s of items) {
    const name = s.title || s.cwd.split("/").filter(Boolean).pop() || s.cwd;
    ul.append(el("li", {}, el("span", { class: `state ${s.state}` }), el("span", { text: `${name} (${s.state})` })));
  }
}

async function refreshMetrics() {
  try {
    const m = await api("/api/metrics");
    const pct = (r) => (r == null ? "-" : `${Math.round(r * 100)}%`);
    $("metrics").replaceChildren(
      el("span", { text: `GUI 回答率 ${pct(m.a.rate)} (${m.a.answered}/${m.a.total})` }),
      el("span", { text: `説明添付率 ${pct(m.d.attach_rate)} (${m.d.total - m.d.none}/${m.d.total})` }));
  } catch {}
}

// ---- 起動 ----

function upsert(d) {
  decisions.set(d.id, d);
  if (d.id === selectedId) renderDetail();
  if (selectedId == null && d.status === "pending") selectedId = d.id;
  renderList();
  if (d.id === selectedId) renderDetail();
}

async function loadAll() {
  const [ds, ss] = await Promise.all([api("/api/decisions?status=pending"), api("/api/sessions")]);
  for (const d of ds) decisions.set(d.id, d);
  for (const s of ss) sessions.set(s.session_id, s);
  if (selectedId == null && ds.length) selectedId = ds[0].id;
  renderList();
  renderDetail();
  renderSessions();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("decision.created", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("decision.updated", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("session.updated", (e) => {
    const s = JSON.parse(e.data);
    sessions.set(s.session_id, s);
    renderSessions();
  });
  es.addEventListener("open", () => loadAll().catch(() => {}));
}

$("sessions-panel").addEventListener("toggle", (e) => {
  if (!e.target.open) return;
  post("/api/events", {
    session_id: "gui", transcript_path: "gui", cwd: "gui",
    hook_event_name: "ukagai.session_panel_open",
    received_at: new Date().toISOString(),
  }).catch(() => {});
});

setInterval(() => {
  for (const e of document.querySelectorAll(".age")) e.textContent = elapsed(e.dataset.created);
}, 10000);
setInterval(refreshMetrics, 30000);

loadAll().catch(() => {});
refreshMetrics();
connect();
