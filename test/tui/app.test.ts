import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { V2_MD, blockerDecision, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
let t = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (t += 10)));

test("単一選択: 初期は推奨、j で移動 = 選択、Enter で answers を送る(元の label)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  assert.deepEqual(press(app, enter), [
    { type: "answer", id: "d1", body: { answers: { "通知は SSE と WebSocket のどちらにしますか？": "SSE (Recommended)" } } },
  ]);
});

test("j で WebSocket に移して送る。二重送信は無視", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  const eff = press(app, ch("j"), enter);
  assert.equal((eff[0] as { body: { answers: Record<string, string> } }).body.answers["通知は SSE と WebSocket のどちらにしますか？"], "WebSocket");
  assert.deepEqual(press(app, enter), []);
});

test("自由記述: i → 入力 → Enter 確定 → Enter で送信(選択は置き換わる)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  const eff = press(app, ch("i"), ch("あ"), ch("い"), { name: "backspace" }, ch("x"), enter, enter);
  assert.deepEqual((eff[0] as { body: unknown }).body, { answers: { "通知は SSE と WebSocket のどちらにしますか？": "あx" } });
});

test("自由記述の Esc は取りやめ(確定前の文字は残らない)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  press(app, ch("i"), ch("z"), { name: "esc" });
  assert.equal(app.mode, "normal");
  assert.equal(app.view(t).free.text, "");
});

test("複数選択: Space で切替、', ' 区切りで送る", () => {
  const d = decision({
    request: { questions: [{ question: "どれ？", header: "h", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  } as never);
  const app = new App();
  app.upsert(d, t);
  assert.deepEqual(press(app, enter), []); // 未選択では送れない
  const eff = press(app, ch(" "), ch("j"), ch("j"), ch(" "), enter);
  assert.deepEqual((eff[0] as { body: unknown }).body, { answers: { "どれ？": "A, C" } });
});

test("gg / G で先頭・末尾(末尾は自由記述)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  press(app, ch("G"));
  assert.equal(app.view(t).cursor, 2);
  press(app, ch("g"), ch("g"));
  assert.equal(app.view(t).cursor, 0);
});

test("計画: y は承認、a は auto、n は理由入力 → Enter で却下", () => {
  const plan = decision({ kind: "approve_plan", request: { plan: "# P\n\n## 影響範囲と可逆性\n\nx", planFilePath: "/p" } } as never);
  let app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: false } }]);
  app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("a")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("n"), enter), []); // 理由が空
  assert.deepEqual(press(app, ch("だ"), ch("め"), enter), [{ type: "answer", id: "d1", body: { approve: false, reason: "だめ" } }]);
});

test("h/l で保留を切替、b の一覧で選ぶ、回答後は次の保留へ自動で移る", () => {
  const app = new App();
  const mk = (id: string, at: string) => decision({ id, tool_use_id: id, created_at: at } as never);
  app.upsert(mk("a", "2026-10-02T00:00:00Z"), t);
  app.upsert(mk("b", "2026-10-02T00:00:01Z"), t);
  assert.equal(app.shownId, "a");
  press(app, ch("l"));
  assert.equal(app.shownId, "b");
  press(app, ch("h"));
  assert.equal(app.shownId, "a");
  press(app, ch("b"), ch("j"), enter);
  assert.equal(app.shownId, "b");
  app.answered({ ...mk("b", "2026-10-02T00:00:01Z"), status: "answer_submitted" }, t);
  assert.equal(app.shownId, "a");
  assert.equal(app.view(t).toast, "届けています…");
  app.upsert({ ...mk("b", "2026-10-02T00:00:01Z"), status: "answered" }, t + 10);
  assert.equal(app.view(t + 20).toast, "届きました");
  assert.equal(app.view(t + 3000).toast, null);
});

test("質問が 2 つ以上の判断は答えられない", () => {
  const d = decision({
    request: { questions: [
      { question: "a?", header: "h", options: [{ label: "x" }] },
      { question: "b?", header: "h", options: [{ label: "y" }] },
    ] },
  } as never);
  const app = new App();
  app.upsert(d, t);
  assert.deepEqual(press(app, enter), []);
  assert.match(app.model()!.unsupported ?? "", /GUI/);
});

test("blocker: Enter だけで「対応した。続けて (Recommended)」を送る。c は先頭のコードブロックをコピー", () => {
  const app = new App();
  app.upsert(blockerDecision(), t);
  assert.deepEqual(press(app, ch("c")), [{ type: "copy", text: "gcloud auth login\ngcloud auth application-default login" }]);
  assert.deepEqual(press(app, enter), [
    { type: "answer", id: "d1", body: { answers: { "gcloud の認証が切れています。対応できましたか？": "対応した。続けて (Recommended)" } } },
  ]);
});

test("blocker でない判断では c は何もしない", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  assert.deepEqual(press(app, ch("c")), []);
});

// ---- スクロール ----

const LONG = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- 行 ${i}`).join("\n") + "\n";
const wheel = (dir: "up" | "down", x: number, y = 10): Key => ({ name: "wheel", dir, x, y });
const SIZE = { cols: 140, rows: 24 };

function longApp(): App {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  app.syncFrame(renderFrame(app.view(t), SIZE));
  return app;
}
const redraw = (app: App) => {
  const f = renderFrame(app.view(t), SIZE);
  app.syncFrame(f);
  return f;
};

test("ホイール: 左の列は背景を 3 行、右の列は判断を動かす。端で止まる", () => {
  const app = longApp();
  assert.equal(app.scroll, 0);
  press(app, wheel("down", 10));
  assert.equal(app.scroll, 3);
  press(app, wheel("up", 10), wheel("up", 10));
  assert.equal(app.scroll, 0, "上端で止まる");
  const f = redraw(app);
  for (let i = 0; i < 100; i++) press(app, wheel("down", 10));
  assert.equal(app.scroll, f.scrollMax, "下端で止まる");
  // 右の列(split 以降)は背景を動かさない。判断が溢れていなければ何も起きない
  const before = app.scroll;
  press(app, wheel("up", f.split + 5));
  assert.equal(app.scroll, before);
  assert.equal(app.rscroll, null);
});

test("ホイール: 右の列が溢れるときは判断を動かし、カーソル移動で追従に戻る", () => {
  const app = longApp();
  const small = { cols: 140, rows: 14 };
  const f = renderFrame(app.view(t), small);
  app.syncFrame(f);
  assert.ok(f.rightMax > 0, "右が溢れる");
  press(app, wheel("down", f.split + 5));
  assert.equal(app.rscroll, Math.min(f.rightMax, f.rightOff + 3));
  assert.equal(app.scroll, 0);
  press(app, ch("j"));
  assert.equal(app.rscroll, null);
});

test("PgDn / PgUp は半画面、Ctrl-D / Ctrl-U も同じ。端で止まる", () => {
  const app = longApp();
  const f = redraw(app);
  const half = Math.floor(f.bodyRows / 2);
  press(app, { name: "pgdn" });
  assert.equal(app.scroll, half);
  press(app, { name: "ctrl-d" });
  assert.equal(app.scroll, half * 2);
  press(app, { name: "pgup" }, { name: "ctrl-u" }, { name: "pgup" });
  assert.equal(app.scroll, 0);
  for (let i = 0; i < 50; i++) press(app, { name: "pgdn" });
  assert.equal(app.scroll, f.scrollMax);
});

test("Tab でフォーカス切替。背景フォーカスの j/k は 1 行スクロール、G / gg は端、判断のカーソルは動かない", () => {
  const app = longApp();
  const cursorBefore = app.view(t).cursor;
  assert.equal(app.focus, "decision");
  press(app, { name: "tab" });
  assert.equal(app.focus, "background");
  const f = redraw(app);
  assert.match(stripAnsi(f.lines.find((l) => l.includes("背景"))!), /背景/);
  assert.ok(f.lines.some((l) => l.includes("\x1b[7m 背景")), "フォーカス列の見出しは反転");
  press(app, ch("j"), ch("j"), { name: "down" });
  assert.equal(app.scroll, 3);
  press(app, ch("k"));
  assert.equal(app.scroll, 2);
  press(app, ch("G"));
  assert.equal(app.scroll, f.scrollMax);
  press(app, ch("g"), ch("g"));
  assert.equal(app.scroll, 0);
  assert.equal(app.view(t).cursor, cursorBefore);
  press(app, { name: "tab" });
  assert.equal(app.focus, "decision");
  press(app, ch("j"));
  assert.notEqual(app.view(t).cursor, cursorBefore);
});

test("上下配置: ホイールと PgDn は画面全体を動かす(フォーカスは効かない)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  const narrow = { cols: 80, rows: 20 };
  const f = renderFrame(app.view(t), narrow);
  app.syncFrame(f);
  assert.ok(!f.wide && f.scrollMax > 0);
  press(app, { name: "tab" }, ch("j"));
  assert.equal(app.view(t).cursor, 1, "上下配置では j は判断のカーソル");
  press(app, wheel("down", 5));
  assert.ok(app.scroll >= 3);
  press(app, { name: "pgdn" });
  assert.ok(app.scroll >= 3 + Math.floor(f.bodyRows / 2));
});

test("入力中・一覧中のホイールは無視。次の判断に移ると位置は戻る", () => {
  const app = longApp();
  press(app, wheel("down", 10));
  press(app, ch("b"));
  press(app, wheel("down", 10));
  assert.equal(app.scroll, 3);
});

// ---- 幅超過の図(横スクロール・全幅) ----

const chain = (n: number) => Array.from({ length: n }, (_, i) => `N${i}[調査${i}]`).join(" --> ");
const FIG = (n: number) => `${V2_MD.split("## 図")[0]}## 図\n\n\`\`\`mermaid\nflowchart LR\n  ${chain(n)}\n\`\`\`\n`;
const WIDE_FIG = FIG(7); // 幅 ≈ 86: 列幅(66)を超え、端末幅 140 には収まる
const HUGE_FIG = FIG(14); // 端末幅 140 にも収まらない
const body = (f: { lines: string[] }) => f.lines.map(stripAnsi);
const row = (f: { lines: string[] }, mark: string) => body(f).find((l) => l.includes(mark))!;

function figApp(md: string, size = SIZE): { app: App; frame: () => ReturnType<typeof renderFrame> } {
  const app = new App();
  app.upsert(decision(withExplanation(md)), t);
  const frame = () => {
    const f = renderFrame(app.view(t), size);
    app.syncFrame(f, t);
    return f;
  };
  frame();
  return { app, frame };
}

test("幅超過の図: 切り詰めて描き、注記と hMax が出る。退避文は出さない", () => {
  const { frame } = figApp(WIDE_FIG);
  const f = frame();
  const text = body(f).join("\n");
  assert.match(text, /\(図: 幅 \d+ 桁。←→ で横スクロール · f で全幅\)/);
  assert.ok(!text.includes("端末を広げるか"));
  assert.ok(text.includes("┌"));
  assert.ok(f.hMax > 0);
});

test("横スクロール: 背景フォーカスの → / l で 8 桁ずつ、超過行だけずれる。端で止まり、◀▶ が出る", () => {
  const { app, frame } = figApp(WIDE_FIG);
  const before = frame();
  const textRow = body(before).find((l) => l.includes("なぜ今この判断が要るか"))!;
  const figRow = row(before, "調査0");
  // 判断にフォーカスがあるうちは → は保留の切替(1 件なので何も起きない)で、横には動かない
  press(app, { name: "right" });
  assert.equal(app.hscroll, 0);
  press(app, { name: "tab" });
  press(app, { name: "right" });
  assert.equal(app.hscroll, 8);
  const after = frame();
  assert.notEqual(row(after, "調査1"), figRow);
  assert.equal(body(after).find((l) => l.includes("なぜ今この判断が要るか")), textRow, "折り返し済みの文は動かない");
  assert.match(body(after).at(-2)!, /◀▶ 8\/\d+/);
  assert.ok(!body(before).join("\n").includes("◀▶"));
  press(app, ch("l"));
  assert.equal(app.hscroll, 16);
  press(app, { name: "left" });
  assert.equal(app.hscroll, 8);
  press(app, ch("h"));
  assert.equal(app.hscroll, 0);
  press(app, { name: "right" });
  for (let i = 0; i < 30; i++) press(app, { name: "right" });
  const end = frame();
  assert.equal(app.hscroll, end.hMax, "右端で止まる");
  assert.ok(end.hMax > 0);
  for (let i = 0; i < 30; i++) press(app, { name: "left" });
  assert.equal(app.hscroll, 0, "左端で止まる");
});

test("f で全幅 → 判断の列が消えて広がる → Esc / f / Tab で戻る", () => {
  const { app, frame } = figApp(WIDE_FIG);
  const normal = frame();
  assert.ok(body(normal).some((l) => l.includes("判断")) && body(normal).some((l) => l.includes("│ ")));
  press(app, ch("f"));
  const full = frame();
  assert.ok(full.full && app.full);
  assert.ok(!body(full).join("\n").includes("通知は SSE"), "判断の列は隠れる");
  assert.ok(full.hMax === 0, "全幅なら図が収まる");
  assert.ok(body(full).join("\n").includes("調査6"), "右端のノードまで見える");
  assert.ok(!body(full).join("\n").includes("◀▶"));
  assert.match(body(full).at(-1)!, /f \/ Esc で戻る/);
  assert.deepEqual(press(app, enter), [], "全幅では判断は送れない");
  press(app, { name: "esc" });
  assert.ok(!app.full);
  assert.ok(body(frame()).at(-1)!.includes("h/l 切替"));
  press(app, ch("f"), ch("f"));
  assert.ok(!app.full);
  press(app, ch("f"), { name: "tab" });
  assert.ok(!app.full);
});

test("全幅でも収まらない図は横スクロールできる", () => {
  const { app, frame } = figApp(HUGE_FIG);
  press(app, ch("f"));
  const f = frame();
  assert.ok(f.hMax > 0);
  press(app, { name: "right" }, ch("l"));
  assert.equal(app.hscroll, 16);
  assert.match(body(frame()).at(-2)!, /◀▶ 16\/\d+/);
});

test("案内: 列幅を超えて全幅に収まるときだけ 1 回出る。収まらないときは出ない", () => {
  const { app, frame } = figApp(WIDE_FIG);
  // figApp の最初の描画で案内が始まっている
  assert.ok(body(frame()).at(-1)!.includes("図が列幅を超えています: f で全幅表示"));
  press(app, ch("f"));
  assert.ok(!body(frame()).at(-1)!.includes("図が列幅"), "全幅表示中は出さない");
  press(app, { name: "esc" });
  // 同じ判断では二度と出さない(時間が過ぎたあと)
  t += 10000;
  assert.ok(!body(frame()).at(-1)!.includes("図が列幅"));
  assert.ok(!body(frame()).at(-1)!.includes("図が列幅"));

  const huge = figApp(HUGE_FIG);
  assert.ok(!body(huge.frame()).at(-1)!.includes("図が列幅"), "全幅にも収まらない図では案内しない");
  const plain = figApp(V2_MD);
  assert.ok(!body(plain.frame()).at(-1)!.includes("図が列幅"));
});

test("上下配置: ← → は Tab 無しで横スクロール、h l は保留の切替のまま、f は効かない", () => {
  const narrow = { cols: 80, rows: 24 };
  const app = new App();
  const mk = (id: string, at: string) => decision({ id, tool_use_id: id, created_at: at, ...withExplanation(WIDE_FIG) } as never);
  app.upsert(mk("a", "2026-10-02T00:00:00Z"), t);
  app.upsert(mk("b", "2026-10-02T00:00:01Z"), t);
  const draw = () => {
    const f = renderFrame(app.view(t), narrow);
    app.syncFrame(f, t);
    return f;
  };
  const f0 = draw();
  assert.ok(!f0.wide && f0.hMax > 0);
  press(app, { name: "pgdn" }, { name: "pgdn" }, { name: "pgdn" });
  const f1 = draw();
  assert.ok(body(f1).join("\n").includes("(図: 幅"));
  assert.ok(!body(f1).join("\n").includes("f で全幅"), "上下配置の注記に f は出さない");
  app.scroll = 0;
  press(app, { name: "right" });
  assert.equal(app.hscroll, 8);
  assert.equal(app.shownId, "a");
  press(app, ch("l"));
  assert.equal(app.shownId, "b", "l は保留の切替");
  assert.equal(app.hscroll, 0, "切り替えると横位置は戻る");
  press(app, ch("f"));
  assert.ok(!app.full);
  press(app, { name: "right" }, { name: "right" });
  const f2 = draw();
  assert.equal(app.hscroll, f2.hMax, "端で止まる(16 ではなく hMax)");
  assert.match(body(f2).at(-2)!, new RegExp(`◀▶ ${f2.hMax}/\\d+`));
});
