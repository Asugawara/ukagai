import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Key } from "../../src/tui/keys.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

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
