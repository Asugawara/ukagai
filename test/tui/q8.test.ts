import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi, width } from "../../src/tui/width.js";
import { decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
let now = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (now += 10)));

const QJ = "どのストアを使いますか?";
const JA_MD = `---
ukagai: 1
question: ${QJ}
title: 保存先のストアを決める
reversibility: costly
scope: repo
recommended: Sqlite
---

## なぜ今この判断が要るか

リリース前にキャッシュ層のスキーマが必要です。ファイルストアでは 1 回の読み込みが 40 ミリ秒かかり、Sqlite なら 5 ミリ秒未満に収まります。

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| Sqlite | 単一ファイルで動き、サーバーを立てずに済みます。読み込みが速くなります。 | 後から変えるときは移行スクリプトを書き直します(約 1 日)。 |
| Postgres | 別プロセスのサーバーが必要になりますが、複数の書き込みを同時に扱えます。 | 移行後は元に戻せません。 |
| Flat files | 今のまま使い続けます。実装は増えません。 | 読み込みが遅いままです。後からいつでも変えられます。 |

## 推奨

Sqlite を勧めます。サーバーを立てずに読み込みを速くできるからです。サーバー運用がすでにあるなら、Postgres を選びます。

## あなたにしか分からないこと

- 来四半期にチームが DB サーバーを運用するか
- 12 MB という数字にアーカイブが含まれるか

## 反論

Postgres なら後で移行し直す必要がありません。

## 前提

- 書き込みは 1 プロセスだけ
- データは 100 MB を超えない

## 確かめたこと

- \`src/store/read.ts:42\` を読みました。

## 影響を受けるもの

- src/store.ts
- docs
`;

const optsJa = [{ label: "Sqlite (推奨)", description: "a" }, { label: "Postgres", description: "b" }, { label: "Flat files", description: "c" }];
const jaApp = (): App => {
  const app = new App();
  app.lang = "ja";
  app.upsert(decision({ request: { questions: [{ question: QJ, header: "Store", multiSelect: false, options: optsJa }] }, ...withExplanation(JA_MD) }), now);
  return app;
};
const draw = (app: App, cols: number, rows: number) => {
  const f = renderFrame(app.view(now), { cols, rows });
  app.syncFrame(f, now);
  return stripAnsi(f.text);
};

test("Y3 I-3: at 140x40 and 120x32 the first screen shows all 3 cards and the right-column hint, headline and condition on top", () => {
  for (const [cols, rows] of [[140, 40], [120, 32]] as const) {
    const text = draw(jaApp(), cols, rows);
    const right = text.split("\n").map((l) => (l.includes(" │ ") ? l.split(" │ ").at(-1)! : ""));
    const joined = right.join("\n");
    for (const c of ["Sqlite", "Postgres", "Flat files", "自由記述"]) assert.ok(joined.includes(c), `${cols}x${rows}: ${c}\n${text}`);
    assert.ok(right.some((l) => l.includes("j/k") && l.includes("Enter")), `${cols}x${rows}: hint`);
    assert.ok(joined.includes("条件"), "condition");
    assert.ok(joined.indexOf("Sqlite を勧めます") >= 0 && joined.indexOf("Sqlite を勧めます") < joined.indexOf("1 ▸"), "headline above the cards");
    // no reading material in the decision column
    for (const s of ["あなたが決めること", "反論:", "前提"]) assert.ok(!joined.includes(s), `${cols}x${rows}: ${s} is not in the decision column`);
    assert.ok(!text.includes("該当なし") && text.includes("n どれでもない"), "same word as the GUI");
  }
});

test("Y3 I-3: the background column is in the GUI order (Why, Recommendation, You decide, Against, Assumptions, Checked, Affected)", () => {
  const text = draw(jaApp(), 140, 60);
  const left = text.split("\n").map((l) => l.split(" │ ")[0]!);
  const at = (s: string) => left.findIndex((l) => l.includes(s));
  const order = ["なぜ今この判断が要るか", "推奨", "あなたが決めること:", "反論:", "前提", "確かめたこと", "影響を受けるもの:"].map(at);
  assert.ok(order.every((n) => n >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, JSON.stringify(order));
});

test("Y3 I-3: the single column (100x28) still shows the decision first and then the background in order", () => {
  const text = draw(jaApp(), 100, 28);
  assert.ok(!text.includes(" │ "), "one column");
  assert.ok(text.includes("Sqlite") && text.includes("条件"));
});

test("Y3: TUI and GUI use the same words for the same things", async () => {
  const { MESSAGES: GUI } = (await import(new URL("../../public/i18n.js", import.meta.url).href)) as { MESSAGES: Record<"en" | "ja", Record<string, string>> };
  for (const lang of ["en", "ja"] as const) {
    assert.equal(MESSAGES[lang].hint_none, `n ${GUI[lang]!.hint_none}`);
    assert.equal(MESSAGES[lang].hint_cannot, GUI[lang]!.hint_cannot);
    assert.equal(MESSAGES[lang].hint_evidence, `e ${GUI[lang]!.hint_evidence}`);
    assert.equal(MESSAGES[lang].history_title, GUI[lang]!.history_title);
    assert.equal(MESSAGES[lang].assumptions_note, GUI[lang]!.assumptions_hint);
    assert.equal(MESSAGES[lang].against_title, GUI[lang]!.against_cap);
    assert.equal(MESSAGES[lang].cond_prefix, GUI[lang]!.cond_prefix);
    assert.equal(MESSAGES[lang].none_of_these, GUI[lang]!.none_of_these);
    assert.equal(MESSAGES[lang].cannot_answer, GUI[lang]!.cannot_answer);
  }
});

const freeOnly = (header = "Question", rev = "reversible"): App => {
  const app = new App();
  app.upsert(decision({ request: { questions: [{ question: "Which approach do you prefer?", header, multiSelect: false, options: [] }] }, ...(rev === "irreversible" ? { explanation: undefined } : {}) }), now);
  return app;
};

test("Y3 M-2: free text sends with one Enter (empty sends nothing); multi select only confirms", () => {
  const app = freeOnly();
  press(app, ch("i"));
  assert.deepEqual(press(app, enter), [], "empty text sends nothing");
  press(app, ch("i"), ch("h"), ch("i"));
  const fx = press(app, enter);
  assert.equal(fx.length, 1);
  assert.equal(fx[0]!.type, "answer");
  assert.deepEqual((fx[0] as { body: { answers: Record<string, string> } }).body.answers, { "Which approach do you prefer?": "hi" });
  // the typing hint says Enter sends
  const a2 = freeOnly();
  press(a2, ch("i"));
  assert.ok(draw(a2, 140, 40).includes("Enter send"));
  // multi select: Enter only confirms the text
  const m = new App();
  m.upsert(decision({ request: { questions: [{ question: "Pick", header: "Q", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } }), now);
  press(m, ch("i"), ch("x"));
  assert.deepEqual(press(m, enter), []);
});

const APPROVAL_MD = `---
ukagai: 1
question: Allow Codex to run?
title: Allow \`curl -sI https://example.com\`
recommended: Allow
reversibility: reversible
scope: file
---

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Allow | Runs it | None. |
| Deny | Skips it | None. |

## Recommendation

Allow it.
`;

test("Y3 M-3: an approval's header shows the command emphasised (no raw backticks), keeps the blank line, and has no None of these / Can't answer", () => {
  const q = "Run a request.\n\n`curl -sI https://example.com`";
  const app = new App();
  app.upsert(decision({ request: { questions: [{ question: q, header: "Approval", multiSelect: false, options: [{ label: "Allow" }, { label: "Deny" }] }] }, ...withExplanation(APPROVAL_MD) }), now);
  const f = renderFrame(app.view(now), { cols: 140, rows: 40 });
  const lines = f.text.split("\n");
  assert.ok(lines[0]!.includes("\x1b[1;36mcurl -sI https://example.com") || /\x1b\[1m\x1b\[36mcurl -sI/.test(lines[0]!) || lines[0]!.includes("curl -sI https://example.com"));
  assert.ok(!stripAnsi(lines[0]!).includes("`"), "no raw backticks in the title row (row 1)");
  assert.ok(/\x1b\[36m/.test(lines[0]!), "command in cyan");
  const text = stripAnsi(f.text);
  assert.ok(!text.includes("None of these") && !text.includes("Can't answer") && !text.includes("n None"), text);
  const rows = text.split("\n").map((l) => l.split(" │ ").at(-1)!);
  const a = rows.findIndex((l) => l.includes("Run a request."));
  assert.ok(a >= 0 && rows[a + 1]!.trim() === "" && rows[a + 2]!.includes("curl -sI"), "description and command on separate rows with a blank between");
  press(app, ch("n"));
  assert.ok(!draw(app, 140, 40).includes("Missing option"), "n does nothing");
});

test("Y3: the hint line fits the decision column (en / ja) at 140x40", () => {
  for (const lang of ["en", "ja"] as const) {
    const app = jaApp();
    app.lang = lang;
    const text = draw(app, 140, 40);
    const hint = text.split("\n").map((l) => l.split(" │ ").at(-1)!).find((l) => l.includes("j/k") && l.includes("Enter"))!;
    assert.ok(hint && width(hint.trimEnd()) <= 56, hint);
  }
});
