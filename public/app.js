// ukagai GUI。ユーザー由来の文字列は textContent で入れる。innerHTML は marked / mermaid の出力だけ。
const MULTI_SELECT_SEPARATOR = ", "; // src/contract.ts と同じ値
const FOLD_LINES = 9;

const decisions = new Map();
const drafts = new Map(); // id -> { sel: Map<qIndex, Set<label>>, free: Map<qIndex, {on, text}>, rejecting, reason }
let shownId = null;
let ui = null; // 表示中の判断の操作(キーボード用)

const $ = (id) => document.getElementById(id);

// どの版の app.js を見ているかを画面に出す(index.html が付ける ?v=<版>)
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

// server 再起動で cookie が失効したら GET / を取り直して cookie を更新する(同時に呼ばれても 1 回)
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
    .replace(/<img\b[^>]*?\ssrc\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]*)[^>]*>/gi, "")
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, "");
}

// 実体化した後の最終防衛: 外部オリジンの画像は data: 以外すべて外す(実体参照で regex をすり抜けたものも)
function dropExternalImages(container) {
  for (const img of container.querySelectorAll("img")) {
    const src = (img.getAttribute("src") ?? "").trim();
    let external = false;
    try { const u = new URL(src, location.href); external = u.protocol !== "data:" && u.origin !== location.origin; } catch { external = true; }
    if (external) img.remove();
  }
}

// ---- 表示補助 ----

// 見出し用の平文(Markdown の記号を除く)
const plainMd = (t) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[ \t]*#+[ \t]*/, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
const NONE_REASONS = { loop_guard: "書き直しの指示に従わなかったため", plan_mode: "plan mode のため", not_required: "説明を要求していないため" };

const hasExplanation = (d) => !!d.explanation && d.explanation.attached_via !== "none";

function cwdTail(d) {
  return d.session.cwd.split("/").filter(Boolean).pop() || d.session.cwd;
}

function titleOf(d) {
  const t = rawTitleOf(d);
  return d.kind === "approve_plan" ? plainMd(t) || "計画の承認" : t;
}

function rawTitleOf(d) {
  let t = d.explanation?.title;
  if (!t && hasExplanation(d) && d.kind === "answer_question") t = parseFrontMatter(d.explanation.markdown).fm.title;
  if (t) return t;
  if (d.kind === "approve_plan") return /^#[ \t]+(.+?)[ \t]*$/m.exec(d.request.plan ?? "")?.[1] ?? "計画の承認";
  return d.session.title || d.request.questions[0]?.question || "質問";
}

// 人にしかできない作業(認証・権限など)で止まった判断。explanation.type か front matter の type
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
// 右列の送信ボタンの真上(.actions の上端に重ねる)に縦に積む。最大 3 枚。判断が無いときは右下
const toastBox = el("div", { class: "toasts", role: "status" });
document.body.append(toastBox);
const TOAST_MAX = 3;
function toast(msg, { kind = "", ms = 2000 } = {}) {
  const t = el("div", { class: `toast ${kind}`.trim(), text: msg });
  toastBox.append(t);
  while (toastBox.children.length > TOAST_MAX) toastBox.firstElementChild.remove();
  setTimeout(() => t.remove(), ms);
}
function placeToasts() {
  const a = document.querySelector("#decision .actions");
  if (a) { if (toastBox.parentElement !== a) a.prepend(toastBox); } else if (toastBox.parentElement !== document.body) document.body.append(toastBox);
  toastBox.classList.toggle("floating", toastBox.parentElement === document.body);
}

const clip = (t, n = 40) => (t.length > n ? t.slice(0, n) + "…" : t);
const LOST_TEXT = {
  answer_lost: (t) => `${t} は届きませんでした(ターミナルに落ちました)`,
  hook_disconnected: (t) => `${t} は届きませんでした(hook が切断されました)`,
  cancelled: (t) => `${t} は届きませんでした(キャンセルされました)`,
  fallback: (t) => `${t} は届きませんでした(ターミナルで答える扱いになりました)`,
};
// 表示中でない判断の状態が変わったとき
function notifyBackground(prev, d) {
  if (!prev || prev.status === d.status) return;
  const t = clip(titleOf(d));
  if (LOST_TEXT[d.status]) toast(LOST_TEXT[d.status](t), { kind: "lost", ms: 4000 });
  else if (d.status === "answered") toast(`${t} 届きました`, { kind: "soft" });
}

// ---- 保留ボタン / タイトル ----

// 保留ボタン: 1100px 以上は右上固定、未満は右列の見出しの右端(インライン)
const narrowQuery = matchMedia("(max-width: 1099px)");
function placePending() {
  const btn = $("pending-btn");
  const slot = narrowQuery.matches ? document.querySelector("#decision .title-row") : null;
  if (slot) { if (btn.parentElement !== slot) slot.append(btn); } else if (btn.parentElement !== document.body) document.body.prepend(btn);
}
narrowQuery.addEventListener("change", placePending);
const titleRow = (title) => el("div", { class: "title-row" }, title);

function renderHeader() {
  const n = pendingList().length;
  $("pending-count").textContent = String(n);
  $("pending-btn").hidden = n < 2; // 1 件なら表示中のものだけなので出さない
  document.body.classList.toggle("has-pending-btn", n >= 2);
  const blocked = pendingList().some(isBlocker);
  document.title = n > 0 ? `(${n}) ukagai${blocked ? " · 作業待ち" : ""}` : "ukagai";
}

// 右列の title の直下: ブランチ・作業ディレクトリ(フルパス)・可逆性・scope・経過時間
// 描画してよい context は branch だけ
const tildePath = (p) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

const WT_RE = /\/\.herdr\/worktrees\/([^/]+)\/([^/]+)/;
const repoOf = (d) => WT_RE.exec(d.session.cwd)?.[1] ?? cwdTail(d);
const worktreeOf = (d) => WT_RE.exec(d.session.cwd)?.[2];

// リポジトリ(紫)・ブランチ(緑)・ワークツリー(橙)。色は種類ごとに固定
function chips(d, cls = "") {
  const box = el("span", { class: `chips ${cls}`.trim() });
  box.append(el("span", { class: "chip repo", text: `◈ ${repoOf(d)}`, title: "リポジトリ" }));
  if (d.context?.branch) box.append(el("span", { class: "chip branch", text: `⎇ ${d.context.branch}`, title: "ブランチ" }));
  const wt = worktreeOf(d);
  if (wt) box.append(el("span", { class: "chip worktree", text: `⧉ ${wt}`, title: "ワークツリー" }));
  return box;
}

function metaLine(d) {
  const line = el("div", { class: "meta-line" });
  line.append(chips(d));
  line.append(el("span", { class: "cwd", text: tildePath(d.session.cwd), title: d.session.cwd }));
  const rev = reversibilityOf(d);
  if (rev === "irreversible") line.append(el("span", { class: "badge irreversible", text: "元に戻せない" }));
  else if (rev === "costly") line.append(el("span", { class: "badge costly", text: "戻すのにコストがかかる" }));
  const scope = scopeOf(d);
  if (scope) line.append(el("span", { class: "badge", text: scope }));
  line.append(el("span", { class: "badge age", "data-created": d.created_at, text: elapsed(d.created_at) }));
  return line;
}

// ---- ドロワー ----

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
  $("pending-btn").setAttribute("aria-expanded", String(open));
  if (!open && document.activeElement === $("pending-btn")) $("pending-btn").blur(); // Enter が保留ボタンに吸われないように
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
    if (isBlocker(d)) meta.append(el("span", { class: "badge blocker", text: "作業" }));
    if (d.kind === "answer_question" && !hasExplanation(d)) meta.append(el("span", { class: "badge none", text: "説明なし" }));
    if (d.id === shownId) meta.append(el("span", { class: "badge", text: "表示中" }));
    const row = el("button", {
      class: "row" + (d.id === shownId ? " current" : ""),
      type: "button",
      onclick: () => { show(d.id); setDrawer(false); },
    }, el("div", { class: "title", text: titleOf(d) }), chips(d, "small"), meta);
    list.append(el("li", {}, row));
  }
  if (!list.children.length) list.append(el("li", { class: "muted", text: "保留はありません" }));
  else if (drawerOpen()) focusDrawerRow();
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

// 説明の表と対応が取れない生の選択肢: (Recommended) 等の接尾辞は外して推奨バッジにする。回答値は元の label
const rawItem = (o) => ({ label: stripSuffix(o.label), value: o.label, lines: o.description ? [{ text: o.description }] : [], badge: SUFFIX_RE.test(o.label), pref: SUFFIX_RE.test(o.label) });

const kbd = (t) => el("kbd", { class: "kbd", text: t });
const keyLine = (...parts) => el("div", { class: "keys" }, ...parts.flatMap(([ks, label]) => [...ks.map(kbd), el("span", { text: label })]));
const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));

async function copyCode(pre) {
  try {
    await navigator.clipboard.writeText((pre.textContent ?? "").replace(/\n$/, ""));
    toast("コピーしました");
  } catch {
    toast("コピーできませんでした");
  }
}

// 長い推奨・カード本文の折りたたみ(CSS で 6 行 / 3 行)。折りたたみで溢れる要素にだけ「全文 .」のチップを付ける。
// 展開状態は判断ごとの draft に持ち、`.` かチップのクリックで全体を切り替える
function toggleExpand(dr) {
  dr.expanded = !dr.expanded;
  const root = $("decision");
  root.classList.toggle("expanded", dr.expanded);
  for (const chip of root.querySelectorAll(".more-chip")) chip.firstChild.textContent = dr.expanded ? "折りたたむ " : "全文 ";
}
function markClamps(root, dr) {
  root.classList.remove("expanded");
  for (const c of root.querySelectorAll(".clampable")) {
    if (c.scrollHeight <= c.clientHeight + 1) continue;
    const host = c.parentElement;
    host.classList.add("has-more");
    if (host.querySelector(".more-chip")) continue;
    host.append(el("button", { class: "more-chip", type: "button", tabindex: "-1", onclick: () => toggleExpand(dr) }, el("span", { text: "全文 " }), kbd(".")));
  }
  if (dr.expanded) { root.classList.add("expanded"); for (const chip of root.querySelectorAll(".more-chip")) chip.firstChild.textContent = "折りたたむ "; }
}

function renderRight(d) {
  document.body.append(toastBox); // replaceChildren で消えないように退避
  renderRightBody(d);
  placeToasts();
  placePending();
  clampMeta();
}

// 計画本文の「影響範囲と可逆性」の節(照合名)を右列に出す。無ければ null
function impactBox(d) {
  const tmp = el("div", { class: "md" });
  tmp.innerHTML = sanitize(window.marked.parse(d.request.plan ?? "", { async: false }));
  dropExternalImages(tmp);
  const sec = findSection(sectionsOf(tmp), "影響範囲と可逆性");
  const nodes = sec?.nodes.slice(1) ?? [];
  if (!nodes.some((n) => (n.textContent ?? "").trim())) return null;
  const body = el("div", { class: "clampable impact-body md" }, ...nodes);
  callouts(body);
  return el("div", { class: "impact" }, el("div", { class: "impact-cap", text: "影響範囲と可逆性" }), body);
}

// meta-line は折り返して見せる。3 行目以降は隠して末尾を … にする
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
  root.classList.remove("expanded");
  if (!drawerOpen()) document.activeElement?.blur?.(); // フォーカスを body に戻し、キーを document で受ける
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
        box.append(el("div", { class: "head" },
          isBlocker(d) ? el("div", { class: "blocker-band", text: "人の作業待ち" }) : null,
          titleRow(el("div", { class: "v2-title", text: titleOf(d) })), metaLine(d)));
        if (v2.todoBox) box.append(el("div", { class: "todo" }, el("div", { class: "todo-cap", text: "人にしてほしいこと" }), v2.todoBox));
        if (v2.recBox) box.append(el("div", { class: "rec" }, el("div", { class: "rec-cap", text: "推奨" }), el("div", { class: "clampable rec-body" }, v2.recBox)));
        items = [
          ...v2.cards.map((c) => ({ label: c.label, value: c.option.label, lines: c.lines, badge: c.recommended, pref: c.recommended })),
          ...v2.extras.map(rawItem),
        ];
      } else {
        const title = titleOf(d);
        // title と質問文が同じなら 1 つだけ。違う(session.title)ときは title の下に質問文を出す
        box.append(el("div", { class: "head" },
          title === q.question ? el("div", { class: "header", text: q.header }) : null,
          titleRow(el("div", { class: "question", text: title })), metaLine(d)));
        if (title !== q.question) box.append(el("div", { class: "header", text: q.header }), el("div", { class: "question", text: q.question }));
        items = q.options.map(rawItem);
      }
      if (single) {
        if (dr.cursor == null) dr.cursor = Math.max(0, items.findIndex((i) => i.pref));
        // 単一選択は移動 = 選択。初期位置(推奨、無ければ先頭)を選んでおく
        if (!closed && !q.multiSelect && sel.size === 0 && !free.on && items.length) sel.add(items[dr.cursor].value);
      }
      if (single) box.append(keyLine([["↑", "↓"], "移動"], [["Enter"], "回答"], ...(v2?.todoBox?.querySelector("pre") ? [[["c"], "コマンドをコピー"]] : []), ...(q.multiSelect ? [[["Space"], "切替"]] : [])));
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
        type: "text", class: "free-text", placeholder: "自由記述", value: free.text, disabled: closed,
        onfocus: () => { if (!free.on) freeInput.click(); },
        oninput: (ev) => { free.text = ev.target.value; updateSubmit(); },
      });
      const freeCard = el("label", { class: "opt free" }, freeInput,
        el("span", { class: "grow" }, el("div", { class: "lab" }, el("span", { text: "自由記述" }), single ? kbd("Enter") : null), freeText));
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
          // 回答は元の option.label(表の見た目ではなく)で返す
          const picked = q.options.map((o) => o.label).filter((l) => sel.has(l));
          const f = dr.free.get(qi);
          if (f.on && !q.multiSelect) picked.length = 0;
          if (f.on) picked.push(f.text.trim());
          answers[q.question] = picked.join(MULTI_SELECT_SEPARATOR);
        });
        send(d, { answers });
      },
    }, el("span", { text: "回答する" }), kbd("Enter"));
    function updateSubmit() { submit.disabled = closed || !complete(); }
    const actions = el("div", { class: "actions" }, submit);
    if (single) {
      actions.append(el("div", { class: "hint" }, `↑↓ 移動 · ${qs[0].multiSelect ? "Space 切替 · " : ""}Enter 回答 · ${v2?.todoBox?.querySelector("pre") ? "c コピー · " : ""}←→ 次の保留 · Esc 戻る`, " ", buildTag()));
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
    el("div", { class: "plan-q", text: "この計画を承認しますか" }));
  const impact = impactBox(d);
  if (impact) qsBox.append(impact);
  root.append(qsBox);
  const approve = el("button", { class: "btn primary", type: "button", disabled: closed, onclick: () => send(d, { approve: true, set_mode_auto: false }) }, el("span", { text: "承認" }), kbd("y"));
  const auto = el("button", { class: "btn", type: "button", disabled: closed, onclick: () => send(d, { approve: true, set_mode_auto: true }) }, el("span", { text: "承認して auto" }), kbd("a"));
  const reject = el("button", { class: "btn danger", type: "button", disabled: closed, onclick: () => startReject(d) }, el("span", { text: "却下" }), kbd("n"));
  const actions = el("div", { class: "actions" });
  if (dr.rejecting && !closed) {
    const confirm = el("button", {
      class: "btn danger", type: "button", disabled: !dr.reason.trim(), text: "却下を送る",
      onclick: () => send(d, { approve: false, reason: dr.reason.trim() }),
    });
    const input = el("input", {
      type: "text", id: "reason", placeholder: "却下の理由(Enter で送信、Esc で取りやめ)", value: dr.reason,
      oninput: (ev) => { dr.reason = ev.target.value; confirm.disabled = !dr.reason.trim(); },
      onkeydown: (ev) => { if (ev.key === "Enter" && dr.reason.trim()) confirm.click(); },
    });
    actions.append(el("div", { class: "reject-box" }, input), confirm);
  }
  actions.append(approve, auto, reject, el("div", { class: "hint" }, "↑↓ 選ぶ · Enter 決定 · ←→ 次の保留", " ", buildTag()));
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
    const el0 = box.querySelector("svg");
    const natural = el0?.viewBox?.baseVal?.width || parseFloat(el0?.style.maxWidth) || 0;
    if (natural) box.dataset.natural = String(natural);
    pre.replaceWith(box);
    refreshWide();
  } catch (e) {
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
    const msg = String(e?.message ?? e).split("\n")[0];
    pre.before(el("div", { class: "mermaid-err", text: `Mermaid の描画に失敗しました: ${msg}` }));
    pre.textContent = source;
  }
}

// 図の自然幅が列幅の 1.5 倍を超えるとき、「全幅で見る f」のチップを図の上に出す
const WIDE_RATIO = 1.5;
function refreshWide() {
  const full = document.body.classList.contains("fullwide");
  for (const box of document.querySelectorAll("#background .mermaid-ok")) {
    const natural = Number(box.dataset.natural || 0);
    const wide = full || (natural > 0 && natural > box.clientWidth * WIDE_RATIO && box.clientWidth > 0);
    box.classList.toggle("wide", wide);
    const chip = box.querySelector(".wide-chip");
    if (wide && !chip) box.prepend(el("button", { class: "wide-chip", type: "button", tabindex: "-1", onclick: () => setFullwide(!document.body.classList.contains("fullwide")) }, el("span", { text: "全幅で見る " }), kbd("f")));
    else if (!wide && chip) chip.remove();
    const svg = box.querySelector("svg");
    if (svg) {
      if (full && natural) { svg.style.width = `${natural}px`; svg.style.maxWidth = "none"; svg.style.maxHeight = "none"; }
      else { svg.style.removeProperty("width"); svg.style.removeProperty("max-width"); svg.style.removeProperty("max-height"); }
    }
    const c2 = box.querySelector(".wide-chip");
    if (c2) c2.firstChild.textContent = full ? "戻る " : "全幅で見る ";
  }
}

// 全幅表示(判断列を隠して背景だけを広く)。Enter は無効にして誤送信を防ぐ
const hasWide = () => !!document.querySelector("#background .mermaid-ok.wide");
function setFullwide(on) {
  if (on && !hasWide()) return;
  document.body.classList.toggle("fullwide", on);
  document.activeElement?.blur?.();
  refreshWide();
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

// GitHub 形式の alert(blockquote の先頭が [!NOTE] など)を色付きの箱にする。何度呼んでも壊れない
const CALLOUTS = { NOTE: ["補足", "note"], TIP: ["ヒント", "tip"], WARNING: ["注意", "warning"], CAUTION: ["警告", "caution"] };
function callouts(container) {
  for (const bq of container.querySelectorAll("blockquote:not(.callout)")) {
    const p = bq.firstElementChild;
    const first = p?.firstChild;
    if (!p || p.tagName !== "P" || first?.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\s*\[!(NOTE|TIP|WARNING|CAUTION)\][ \t]*\n?/i.exec(first.textContent ?? "");
    if (!m) continue;
    const [label, cls] = CALLOUTS[m[1].toUpperCase()];
    first.textContent = first.textContent.slice(m[0].length);
    if (p.firstChild?.nodeName === "BR") p.firstChild.remove();
    if (!p.textContent.trim() && !p.children.length) p.remove();
    bq.classList.add("callout", cls);
    bq.prepend(el("div", { class: "callout-label", text: label }));
  }
}

// 表のセルの装飾(strong / em / code)だけ残して複製する。他の要素は中身だけ残す
function inlineClone(node) {
  const out = document.createDocumentFragment();
  for (const c of node.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) out.append(c.textContent ?? "");
    else if (c.nodeType === Node.ELEMENT_NODE) {
      const tag = c.tagName.toLowerCase();
      if (tag === "strong" || tag === "em" || tag === "code") {
        const e = document.createElement(tag);
        e.append(inlineClone(c));
        out.append(e);
      } else if (tag === "br") out.append(" ");
      else out.append(inlineClone(c));
    }
  }
  return out;
}

// pre の畳み・diff・mermaid をまとめて適用(何度呼んでも壊れない)
async function enhance(container) {
  callouts(container);
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

// ---- 説明ファイル v2 から判断画面を組む ----

const SUFFIX_RE = /\s*[(（]\s*(recommended|推奨)\s*[)）]\s*$/i;
const stripSuffix = (s) => s.replace(SUFFIX_RE, "");
const normLabel = (s) => stripSuffix(s.normalize("NFKC")).replace(/\s/g, "").toLowerCase();
// ラベルに HTML が含まれていても表のセル(textContent)と比べられるよう、ラベル側も一度テキストにする(DOMParser は何も実行・読み込みしない)
const labelText = (s) => new DOMParser().parseFromString(s, "text/html").body.textContent ?? s;
const sameLabel = (a, b) => normLabel(a) === normLabel(b) || normLabel(labelText(a)) === normLabel(b);
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
  dropExternalImages(left);
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
      if (v2.cards.length) for (const n of optSec.nodes) n.remove(); // 1 つも対応が取れなければ、表は左に残す
      const todoSec = (fm.type === "blocker" || d.explanation.type === "blocker") ? findSection(secs, "人にしてほしいこと") : undefined;
      if (todoSec && todoSec !== optSec) {
        const todoBox = el("div", { class: "md" });
        for (const n of todoSec.nodes.slice(1)) todoBox.append(n);
        todoSec.head.remove();
        for (const pre of todoBox.querySelectorAll("pre")) {
          const wrap = el("div", { class: "codewrap" });
          pre.replaceWith(wrap);
          wrap.append(pre, el("button", { class: "copy-btn", type: "button", tabindex: "-1", text: "コピー", onclick: () => copyCode(pre) }));
        }
        if (todoBox.children.length) { v2.todoBox = todoBox; enhance(todoBox).catch(() => {}); }
      }
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
  for (const tr of trs.slice(1)) {
    const row = cells(tr);
    const tds = [...tr.children];
    const o = options.find((o) => sameLabel(o.label, row[0] ?? ""));
    if (!o || cards.some((c) => c.option === o)) continue;
    let lines;
    if (hi >= 0 && ri >= 0) lines = [{ text: row[hi] ?? "", cell: tds[hi] }, { text: row[ri] ?? "", muted: true, cell: tds[ri] }];
    else lines = row.slice(1).map((t, j) => ({ text: t ? `${header[j + 1] ?? ""}: ${t}` : "" })); // 旧形式
    lines = lines.filter((l) => l.text && !/^[-—ー]+$/.test(l.text));
    cards.push({ option: o, label: stripSuffix(row[0]), lines, suffix: SUFFIX_RE.test(row[0]), recommended: false });
  }
  // 行が 1 つも照合できなくても v2 は捨てない(全 option が生のカードになる)
  const want = fm.recommended ? fm.recommended : null;
  const byFm = want ? cards.filter((c) => sameLabel(c.option.label, want)) : [];
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
  const code = ex?.none_reason ?? "";
  const reason = NONE_REASONS[code] ?? code;
  root.append(el("div", { class: "bg-note", text: `エージェントは説明を書きませんでした${reason ? `(理由: ${reason})` : ""}` }));
}

// ---- 表示の切り替え ----

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
  for (const d of ds) {
    seen.add(d.id);
    if (decisions.has(d.id) && decisions.get(d.id).status !== d.status) upsert(d);
    else decisions.set(d.id, d);
  }
  // SSE の取りこぼし・server 再起動で、手元では pending のまま変わった / 消えたものを取り直す
  for (const d of [...decisions.values()]) {
    if (d.status === "pending" && !seen.has(d.id)) {
      try { upsert(await api(`/api/decisions/${d.id}`)); }
      catch (e) {
        if (e.message === "unauthorized") throw e;
        decisions.delete(d.id); // 取れない(404 等)= 消えた
        models.delete(d.id);
        drafts.delete(d.id);
      }
    }
  }
  const cur = decisions.get(shownId);
  if (!cur || cur.status !== "pending") advance();
  else { renderHeader(); renderList(); }
}

// SSE。切れたら cookie を取り直して 2 秒後(以後 2 倍、上限 5 秒)に再接続し、open で保留を同期する
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
    $("banner").hidden = true;
    loadAll().catch(() => {});
  });
  es.addEventListener("error", () => {
    es.close();
    const wait = retryMs;
    retryMs = Math.min(5000, retryMs * 2);
    retryTimer = setTimeout(async () => { await refreshAuth(); connect(); }, wait);
  });
}

// ---- キーボード ----

let lastG = 0; // gg の 1 回目の時刻

function cycle(step) {
  const list = pendingList();
  if (list.length < 2) return;
  const i = list.findIndex((d) => d.id === shownId);
  show(list[(i + step + list.length) % list.length].id);
}

// IME(日本語入力)が有効だと keydown の key が "Process"、keyCode が 229 になり文字が取れない。
// テキスト欄の外では物理キー(code)から割り当てキーを決める
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
  // テキスト欄で IME 変換中のキーは入力に回す。欄の外では IME が有効でも物理キーで判定する(logicalKey)
  if (typing && (ev.isComposing || ev.keyCode === 229)) return;
  if (document.body.classList.contains("fullwide")) {
    const k = logicalKey(ev);
    if (k === "Escape" || k === "f" || k === "Tab") { ev.preventDefault(); setFullwide(false); }
    else if (k === "Enter") ev.preventDefault(); // 全幅中は送信しない
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
    if (key === "Enter" && isBtn && t !== ui.submit) return; // そのボタンの既定動作に任せる
    if (key === " " && isBtn) return;
    if (t instanceof HTMLInputElement) t.blur(); // ネイティブの選択操作と二重にならないように
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

  // 計画
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

$("pending-btn").addEventListener("click", () => setDrawer(!drawerOpen()));
$("backdrop").addEventListener("click", () => setDrawer(false));

setInterval(() => {
  for (const e of document.querySelectorAll(".age")) e.textContent = elapsed(e.dataset.created);
}, 10000);

$("empty").append(el("div", { class: "build empty-build", text: `build ${BUILD}` }));

loadAll().catch(() => {});
connect();
