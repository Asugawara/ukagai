import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { render } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const dot = { name: "char", ch: "." } as const;

const NOW = Date.parse("2026-10-02T00:00:30.000Z");
const planDecision = (plan: string) =>
  decision({ kind: "approve_plan", request: { plan, planFilePath: "/p" } } as never);

test("計画の model: 「影響範囲と可逆性」の節が入る(あり / なし / 部分一致の見出し)", () => {
  const withSec = buildModel(planDecision("# P\n\n## 影響範囲と可逆性\n\n- scope: repo\n\n## 手順\n\n1. x\n"));
  assert.equal(withSec.impact, "- scope: repo");
  assert.equal(buildModel(planDecision("# P\n\n## 手順\n\n1. x\n")).impact, null);
  const partial = buildModel(planDecision("# P\n\n## 手順\n\n1. x\n\n## 影響範囲・可逆性の整理\n\n- 戻せる\n"));
  assert.equal(partial.impact, "- 戻せる");
  const exact = buildModel(planDecision("# P\n\n## 影響範囲と可逆性の補足\n\n- 部分\n\n## 影響範囲と可逆性\n\n- 完全\n"));
  assert.equal(exact.impact, "- 完全");
});

test("render: 影響範囲は y ボタンの上に出る。節が無ければ出ない", () => {
  const app = new App();
  app.upsert(planDecision("# P\n\n## 影響範囲と可逆性\n\n- scope: repo\n- reversible\n"), NOW);
  const lines = stripAnsi(render(app.view(NOW), { cols: 140, rows: 40 })).split("\n");
  const imp = lines.findIndex((l) => l.includes("影響範囲と可逆性") && l.includes("┌"));
  const y = lines.findIndex((l) => l.includes("[y] 承認"));
  assert.ok(imp >= 0 && y > imp, `imp=${imp} y=${y}`);
  assert.ok(lines.some((l) => l.includes("scope: repo")));

  const none = new App();
  none.upsert(planDecision("# P\n\n## 手順\n\n1. x\n"), NOW);
  const out = stripAnsi(render(none.view(NOW), { cols: 140, rows: 40 }));
  assert.ok(!out.includes("┌─ 影響範囲と可逆性"));
});

test("8 行超は畳まれ、. で全文、もう一度 . で畳む", () => {
  const items = Array.from({ length: 14 }, (_, i) => `- 項目${i}`).join("\n");
  const app = new App();
  app.upsert(planDecision(`# P\n\n## 影響範囲と可逆性\n\n${items}\n`), NOW);
  const show = () => stripAnsi(render(app.view(NOW), { cols: 140, rows: 60 }));
  let out = show();
  // 背景(左)にも計画本文が出るので、右の箱に出る分は出現回数で数える
  const count = (t: string, k: string) => t.split(k).length - 1;
  assert.equal(count(out, "項目7"), 2);
  assert.equal(count(out, "項目8"), 1);
  assert.ok(out.includes("(. で全文)"));
  app.handle(dot, NOW);
  out = show();
  assert.equal(count(out, "項目13"), 2);
  assert.ok(out.includes("(. で折りたたむ)"));
  app.handle(dot, NOW);
  assert.equal(count(show(), "項目13"), 1);
});
