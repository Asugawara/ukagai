// ukagai GUI。ユーザー由来の文字列は textContent で入れる。innerHTML は marked / mermaid の出力だけ。
const MULTI_SELECT_SEPARATOR = ", "; // src/contract.ts と同じ値
const FOLD_LINES = 9;

const decisions = new Map();
const drafts = new Map(); // id -> { sel: Map<qIndex, Set<label>>, free: Map<qIndex, {on, text}>, rejecting, reason }
let shownId = null;
let ui = null; // 表示中の判断の操作(キーボード用)

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

const hasExplanation = (d) => !!d.explanation && d.explanation.attached_via !== "none";

function cwdTail(d) {
  return d.session.cwd.split("/").filter(Boolean).pop() || d.session.cwd;
}

function titleOf(d) {
  let t = d.explanation?.title;
  if (!t && d.kind === "answer_question" && hasExplanation(d)) t = parseFrontMatter(d.explanation.markdown).fm.title;
  return t || d.session.title || cwdTail(d);
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

const pendingList = () =>
  [...decisions.values()].filter((d) => d.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));

const kindLabel = (d) => (d.kind === "approve_plan" ? "📋 計画" : "❓ 質問");

// ---- トースト ----

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}

// ---- header ----

function renderHeader() {
  const d = decisions.get(shownId);
  const n = pendingList().length;
  $("pending-count").textContent = String(n);
  $("pending-btn").classList.toggle("hot", n >= 2);
  document.title = n > 0 ? `(${n}) ukagai` : "ukagai";
  const badges = $("badges");
  badges.replaceChildren();
  if (!d) {
    $("kind-icon").textContent = "";
    $("title").textContent = "";
    return;
  }
  $("kind-icon").textContent = d.kind === "approve_plan" ? "📋" : "❓";
  $("title").textContent = titleOf(d);
  $("title").title = titleOf(d);
  const rev = reversibilityOf(d);
  if (rev === "irreversible") badges.append(el("span", { class: "badge irreversible", text: "元に戻せない" }));
  else if (rev === "costly") badges.append(el("span", { class: "badge costly", text: "戻すのにコストがかかる" }));
  else if (rev === "reversible") badges.append(el("span", { class: "badge reversible", text: "戻せる" }));
  const scope = scopeOf(d);
  if (scope) badges.append(el("span", { class: "badge", text: scope }));
  badges.append(el("span", { class: "badge", text: cwdTail(d), title: d.session.cwd }));
  badges.append(el("span", { class: "badge age", "data-created": d.created_at, text: elapsed(d.created_at) }));
}

// ---- ドロワー ----

function setDrawer(open) {
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("backdrop").hidden = !open;
  $("pending-btn").setAttribute("aria-expanded", String(open));
  if (open) refreshMetrics();
  else if (document.activeElement === $("pending-btn")) $("pending-btn").blur(); // Enter が保留ボタンに吸われないように
}

const drawerOpen = () => $("drawer").classList.contains("open");

function renderList() {
  const list = $("pending-list");
  list.replaceChildren();
  for (const d of pendingList()) {
    const meta = el("div", { class: "meta" },
      el("span", { text: kindLabel(d) }),
      el("span", { class: "age", "data-created": d.created_at, text: elapsed(d.created_at) }));
    if (d.kind === "answer_question" && !hasExplanation(d)) meta.append(el("span", { class: "badge none", text: "説明なし" }));
    if (d.id === shownId) meta.append(el("span", { class: "badge", text: "表示中" }));
    const row = el("button", {
      class: "row" + (d.id === shownId ? " current" : ""),
      type: "button",
      onclick: () => { show(d.id); setDrawer(false); },
    }, el("div", { class: "title", text: titleOf(d) }), meta);
    list.append(el("li", {}, row));
  }
  if (!list.children.length) list.append(el("li", { class: "muted", text: "保留はありません" }));
}

// ---- 右列: 判断 ----

function draftOf(d) {
  let dr = drafts.get(d.id);
  if (!dr) drafts.set(d.id, (dr = { sel: new Map(), free: new Map(), rejecting: false, reason: "", cursor: null }));
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

async function send(d, body) {
  document.querySelectorAll("#decision button").forEach((b) => (b.disabled = true));
  try {
    const updated = await post(`/api/decisions/${d.id}/answer`, body);
    decisions.set(updated.id, updated);
    if (shownId === d.id) {
      toast(STATUS_TEXT[updated.status] ?? "送信しました");
      advance();
    } else {
      renderHeader();
      renderList();
    }
  } catch (e) {
    if (e.message !== "unauthorized") showBanner(`送信に失敗しました: ${e.message}`);
    if (shownId === d.id) renderRight(decisions.get(d.id));
  }
}

function terminalButton(d, closed) {
  return el("button", { class: "link", type: "button", disabled: closed, text: "ターミナルで答える", onclick: () => send(d, { fallback: true }) });
}

const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));

function renderRight(d) {
  const root = $("decision");
  root.replaceChildren();
  ui = null;
  if (!d) return;
  const dr = draftOf(d);
  const closed = d.status !== "pending";
  if (STATUS_TEXT[d.status]) root.append(el("div", { class: "status", text: STATUS_TEXT[d.status] }));

  if (d.kind === "answer_question") {
    const qs = d.request.questions;
    const single = qs.length === 1;
    const v2 = single ? modelFor(d).v2 : null;
    const cards = []; // 質問が 1 つのときの { input, card }(矢印キー用)
    let freeTextEl = null;
    const qsBox = el("div", { class: "qs" });
    qs.forEach((q, qi) => {
      const sel = dr.sel.get(qi) ?? dr.sel.set(qi, new Set()).get(qi);
      const free = dr.free.get(qi) ?? dr.free.set(qi, { on: false, text: "" }).get(qi);
      const box = el("div", { class: "q" });
      let items;
      if (v2) {
        box.append(el("div", { class: "v2-title", text: v2.title }));
        if (v2.recBox) box.append(el("div", { class: "rec" }, el("div", { class: "rec-cap", text: "推奨" }), v2.recBox));
        items = [
          ...v2.cards.map((c) => ({ label: c.label, value: c.option.label, lines: c.lines, badge: c.recommended, pref: c.recommended })),
          ...v2.extras.map((o) => ({ label: o.label, value: o.label, lines: o.description ? [{ text: o.description }] : [], badge: false, pref: SUFFIX_RE.test(o.label) })),
        ];
      } else {
        box.append(el("div", { class: "header", text: q.header }), el("div", { class: "question", text: q.question }));
        items = q.options.map((o) => ({ label: o.label, value: o.label, lines: o.description ? [{ text: o.description }] : [], badge: false, pref: SUFFIX_RE.test(o.label) }));
      }
      if (single) {
        if (dr.cursor == null) dr.cursor = Math.max(0, items.findIndex((i) => i.pref));
        // 単一選択は移動 = 選択。初期位置(推奨、無ければ先頭)を選んでおく
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
        const lab = el("div", { class: "lab" }, el("span", { text: it.label }), it.badge ? el("span", { class: "rec-badge", text: "推奨" }) : null);
        const card = el("label", { class: "opt" + (it.badge ? " rec" : "") }, input,
          el("span", { class: "grow" }, lab, ...it.lines.map((l) => el("div", { class: l.muted ? "desc muted" : "desc", text: l.text }))));
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
        type: "text", class: "free-text", placeholder: "自由記述", value: free.text, disabled: closed,
        onfocus: () => { if (!free.on) freeInput.click(); },
        oninput: (ev) => { free.text = ev.target.value; updateSubmit(); },
      });
      const freeCard = el("label", { class: "opt free" }, freeInput,
        el("span", { class: "grow" }, el("div", { class: "lab", text: "自由記述" }), freeText));
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
      title: "キー: Enter",
      onclick: () => {
        const answers = {};
        qs.forEach((q, qi) => {
          const sel = dr.sel.get(qi);
          // 回答は元の option.label(表の見た目ではなく)で返す
          const picked = q.options.map((o) => o.label).filter((l) => sel.has(l));
          const f = dr.free.get(qi);
          if (f.on && !q.multiSelect) picked.length = 0;
          if (f.on) picked.push(f.text.trim());
          answers[q.question] = picked.join(MULTI_SELECT_SEPARATOR);
        });
        send(d, { answers });
      },
      text: "回答する",
    });
    function updateSubmit() { submit.disabled = closed || !complete(); }
    const actions = el("div", { class: "actions" }, submit, terminalButton(d, closed));
    if (single) actions.append(el("div", { class: "hint", text: "↑↓ 選ぶ · Enter 決定 · Space 複数選択の切替" }));
    root.append(actions);
    const multi = !!qs[0].multiSelect && single;
    ui = {
      kind: "question", cards, multi, submit, closed, freeText: freeTextEl,
      setCursor(i, select) {
        if (!cards.length) return;
        i = clamp(i, cards.length);
        dr.cursor = i;
        cards.forEach((c, k) => c.card.classList.toggle("cursor", k === i));
        cards[i].card.scrollIntoView({ block: "nearest" });
        if (select && !multi && !closed) cards[i].input.click();
      },
      get cursor() { return dr.cursor ?? 0; },
    };
    if (single && !closed) ui.setCursor(dr.cursor, false);
    return;
  }

  // approve_plan
  const qsBox = el("div", { class: "qs" }, el("div", { class: "plan-q", text: "この計画を承認しますか" }));
  root.append(qsBox);
  const approve = el("button", { class: "btn primary", type: "button", disabled: closed, title: "キー: y", text: "承認", onclick: () => send(d, { approve: true, set_mode_auto: false }) });
  const auto = el("button", { class: "btn", type: "button", disabled: closed, title: "キー: a", text: "承認して auto", onclick: () => send(d, { approve: true, set_mode_auto: true }) });
  const reject = el("button", { class: "btn danger", type: "button", disabled: closed, title: "キー: n", text: "却下", onclick: () => startReject(d) });
  const actions = el("div", { class: "actions" });
  if (dr.rejecting && !closed) {
    const confirm = el("button", {
      class: "btn danger", type: "button", disabled: !dr.reason.trim(), text: "却下を送る",
      onclick: () => send(d, { approve: false, reason: dr.reason.trim() }),
    });
    const input = el("input", {
      type: "text", id: "reason", placeholder: "却下の理由(必須)", value: dr.reason,
      oninput: (ev) => { dr.reason = ev.target.value; confirm.disabled = !dr.reason.trim(); },
      onkeydown: (ev) => { if (ev.key === "Enter" && dr.reason.trim()) confirm.click(); },
    });
    actions.append(el("div", { class: "reject-box" }, input), confirm);
  }
  actions.append(approve, auto, reject, terminalButton(d, closed), el("div", { class: "hint", text: "←→ ↑↓ 選ぶ · Enter 決定 · y 承認 · a auto · n 却下" }));
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
  };
  if (!closed) ui.setCursor(dr.cursor ?? 0);
}

function startReject(d) {
  const dr = draftOf(d);
  dr.rejecting = true;
  dr.cursor = 2;
  renderRight(d);
  $("reason")?.focus();
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

// 9 行を超える pre は <details> に畳む
function foldLongPre(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.parentElement?.tagName === "DETAILS" && pre.parentElement.classList.contains("fold")) continue;
    const lines = (pre.textContent ?? "").replace(/\n$/, "").split("\n").length;
    if (lines <= FOLD_LINES) continue;
    const det = el("details", { class: "fold" }, el("summary", { text: `コードを表示(${lines} 行)` }));
    pre.replaceWith(det);
    det.append(pre);
  }
}

// pre の畳み・diff・mermaid をまとめて適用(何度呼んでも壊れない)
async function enhance(container) {
  for (const code of container.querySelectorAll("pre > code.language-diff")) {
    code.closest("pre").replaceWith(diffBlock(code.textContent ?? ""));
  }
  await Promise.all([...container.querySelectorAll("pre > code.language-mermaid")].map(renderMermaid));
  foldLongPre(container);
}

async function renderMarkdown(container, md) {
  container.innerHTML = sanitize(window.marked.parse(md, { async: false }));
  await enhance(container);
}

// ---- 説明ファイル v2 から判断画面を組む ----

const SUFFIX_RE = /\s*[(（]\s*(recommended|推奨)\s*[)）]\s*$/i;
const stripSuffix = (s) => s.replace(SUFFIX_RE, "");
const normLabel = (s) => stripSuffix(s.normalize("NFKC")).replace(/\s/g, "").toLowerCase();
const normHeading = (s) => s.normalize("NFKC").replace(/\s/g, "").replace(/[と・]/g, "").toLowerCase();

// h1〜h3 で節に切る。節は同じか浅い次の見出しの直前まで
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

// 完全一致を優先し、無ければ部分一致
function findSection(secs, name) {
  const n = normHeading(name);
  return secs.find((s) => s.norm === n) ?? secs.find((s) => s.norm.includes(n));
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
  m.left = left;
  const qs = d.request.questions;
  if (qs.length === 1) {
    const secs = sectionsOf(left);
    const optSec = findSection(secs, "選択肢");
    let recSec = findSection(secs, "推奨");
    if (recSec === optSec) recSec = undefined;
    const table = optSec?.nodes.find((n) => n.tagName === "TABLE") ?? optSec?.nodes.map((n) => n.querySelector?.("table")).find(Boolean);
    const v2 = table ? parseOptionsTable(table, qs[0].options, fm) : null;
    if (v2) {
      v2.title = fm.title || d.explanation.title || qs[0].question;
      for (const n of optSec.nodes) n.remove();
      if (recSec) {
        const recBox = el("div", { class: "md" });
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

// 表(先頭列 = ラベル)を options に対応付ける。対応が取れる行が無ければ null
function parseOptionsTable(table, options, fm) {
  const trs = [...table.querySelectorAll("tr")];
  if (trs.length < 2) return null;
  const cells = (tr) => [...tr.children].map((c) => (c.textContent ?? "").trim());
  const header = cells(trs[0]);
  const hn = header.map(normHeading);
  const hi = hn.findIndex((h) => h.includes(normHeading("起きること")));
  const ri = hn.findIndex((h) => h.includes(normHeading("リスク")));
  const cards = [];
  for (const row of trs.slice(1).map(cells)) {
    const o = options.find((o) => normLabel(o.label) === normLabel(row[0] ?? ""));
    if (!o || cards.some((c) => c.option === o)) continue;
    let lines;
    if (hi >= 0 && ri >= 0) lines = [{ text: row[hi] ?? "" }, { text: row[ri] ?? "", muted: true }];
    else lines = row.slice(1).map((t, j) => ({ text: t ? `${header[j + 1] ?? ""}: ${t}` : "" })); // 旧形式
    lines = lines.filter((l) => l.text && !/^[-—ー]+$/.test(l.text));
    cards.push({ option: o, label: stripSuffix(row[0]), lines, suffix: SUFFIX_RE.test(row[0]), recommended: false });
  }
  if (!cards.length) return null;
  const want = fm.recommended ? normLabel(fm.recommended) : null;
  const byFm = want ? cards.filter((c) => normLabel(c.option.label) === want) : [];
  for (const c of byFm.length ? byFm : cards.filter((c) => c.suffix)) c.recommended = true;
  const extras = options.filter((o) => !cards.some((c) => c.option === o));
  return { cards, extras };
}

// ---- 左列: 背景 ----

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
    // hook は explanation.markdown に計画本文を入れるので、本文と違うときだけ続ける
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
  const reason = ex?.none_reason ?? "";
  root.append(el("div", { class: "bg-note", text: `エージェントは説明を書きませんでした${reason ? `(理由: ${reason})` : ""}` }));
}

// ---- 表示の切り替え ----

function renderAll() {
  const d = decisions.get(shownId);
  $("main").hidden = !d;
  $("empty").hidden = !!d;
  renderHeader();
  renderList();
  renderLeft(d);
  renderRight(d);
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
  if (d.id === shownId) {
    if (d.status !== "pending") {
      toast(STATUS_TEXT[d.status] ?? "更新されました");
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
  for (const d of ds) { decisions.set(d.id, d); seen.add(d.id); }
  // SSE の取りこぼしで、手元では pending のまま変わっていたものを取り直す
  for (const d of [...decisions.values()]) {
    if (d.status === "pending" && !seen.has(d.id)) {
      try { decisions.set(d.id, await api(`/api/decisions/${d.id}`)); } catch {}
    }
  }
  const cur = decisions.get(shownId);
  if (!cur || cur.status !== "pending") advance();
  else { renderHeader(); renderList(); }
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

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("decision.created", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("decision.updated", (e) => upsert(JSON.parse(e.data)));
  es.addEventListener("open", () => loadAll().catch(() => {}));
}

// ---- キーボード ----

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && drawerOpen()) { setDrawer(false); return; }
  if (ev.ctrlKey || ev.metaKey || ev.altKey || drawerOpen() || !ui || ui.closed) return;
  const t = ev.target;
  const typing = t instanceof HTMLInputElement && t.type === "text";

  if (ui.kind === "question") {
    const n = ui.cards.length;
    if (typing) {
      if (ev.key === "Enter") { ev.preventDefault(); if (!ui.submit.disabled) ui.submit.click(); }
      else if (n && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
        ev.preventDefault();
        t.blur();
        ui.setCursor(ui.cursor + (ev.key === "ArrowDown" ? 1 : -1), true);
      }
      return;
    }
    if (t instanceof HTMLButtonElement) return; // ボタンの既定動作に任せる
    if (t instanceof HTMLInputElement) t.blur(); // ネイティブの選択操作と二重にならないように
    const onFree = n > 0 && ui.cursor === n - 1;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!n) return;
      ev.preventDefault();
      ui.setCursor(ui.cursor + (ev.key === "ArrowDown" ? 1 : -1), true);
    } else if (ev.key === " ") {
      if (!ui.multi) return;
      ev.preventDefault();
      ui.cards[ui.cursor].input.click();
    } else if (ev.key === "ArrowRight") {
      if (onFree) { ev.preventDefault(); ui.freeText.focus(); }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (onFree && ui.freeText.value.trim() === "") ui.freeText.focus();
      else if (!ui.submit.disabled) ui.submit.click();
    }
    return;
  }

  // 計画
  if (typing || t instanceof HTMLButtonElement) return;
  if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") { ev.preventDefault(); ui.setCursor(ui.cursor - 1); }
  else if (ev.key === "ArrowRight" || ev.key === "ArrowDown") { ev.preventDefault(); ui.setCursor(ui.cursor + 1); }
  else if (ev.key === "Enter") { ev.preventDefault(); ui.buttons[ui.cursor].click(); }
  else if (ev.key === "y") { ev.preventDefault(); ui.approve.click(); }
  else if (ev.key === "a") { ev.preventDefault(); ui.auto.click(); }
  else if (ev.key === "n") { ev.preventDefault(); startReject(decisions.get(shownId)); }
});

$("pending-btn").addEventListener("click", () => setDrawer(!drawerOpen()));
$("backdrop").addEventListener("click", () => setDrawer(false));

setInterval(() => {
  for (const e of document.querySelectorAll(".age")) e.textContent = elapsed(e.dataset.created);
}, 10000);
setInterval(refreshMetrics, 30000);

loadAll().catch(() => {});
refreshMetrics();
connect();
