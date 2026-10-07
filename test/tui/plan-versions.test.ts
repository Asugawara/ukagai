// Plan versions on the TUI screen: the version line, the summary, the [New] / [Changed] tags (no gutter bar), the - / + lines, < > between versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { PlanVersionsResponse } from "../../src/contract.js";
import type { Key } from "../../src/tui/keys.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import { renderFrame } from "../../src/tui/render.js";
import { diffPlans } from "../../src/serve/plan-diff.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
let clock = Date.parse("2026-10-07T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const tick = () => new Promise((r) => setTimeout(r, 5));

const FILL = Array.from({ length: 30 }, (_, i) => `- filler line ${i + 1}`).join("\n");
const mk = (goal: string, rest: string) => `# Export retry\n\n## Goal\n\n${goal}\n\n## Steps\n\n- [ ] add retry\n\n${rest}## Notes\n\n${FILL}\n`;
const V1 = mk("Retry the export on failure.", "## Old\n\ngone soon\n\n");
const V2 = mk("Retry the export on failure, with a cap.", "") + "\n## Risks\n\nnone known\n";
const SHORT1 = "# S\n\n## A\n\nold line\n\n## B\n\nkept\n";
const SHORT2 = "# S\n\n## A\n\nnew line\n\n## B\n\nkept\n\n## C\n\nadded\n";

function versions(plans: string[], instr: ({ text: string; kind?: "instruct" | "reject" } | null)[]): PlanVersionsResponse {
  const vs = plans.map((plan, i) => ({
    n: i + 1,
    at: `2026-10-07T0${i}:00:00.000Z`,
    source: "approval" as const,
    plan,
    ...(instr[i] ? { instruction: { text: instr[i]!.text, kind: instr[i]!.kind ?? ("instruct" as const), at: `2026-10-07T0${i}:30:00.000Z` } } : {}),
    ...(i === plans.length - 1 ? { current: true as const } : {}),
  }));
  return { versions: vs, diffs: vs.map((v, i) => diffPlans(i === 0 ? "" : vs[i - 1]!.plan, v.plan)) };
}

async function setup(plan: string, data: PlanVersionsResponse | null): Promise<{ app: App; calls: string[] }> {
  const app = new App();
  const calls: string[] = [];
  app.fetchVersions = async (sid, current) => {
    calls.push(`${sid}|${current}`);
    if (!data) throw new Error("no");
    return data;
  };
  app.upsert(decision({ id: "ap", kind: "approve_plan", request: { plan, planFilePath: "/x/b.md" } } as never), clock);
  draw(app); // the first paint starts the fetch
  await tick();
  return { app, calls };
}

function draw(app: App, cols = 140, rows = 50) {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return { text: stripAnsi(frame.text), raw: frame.text, lines: frame.lines.map(stripAnsi) };
}
const left = (text: string) => text.split("\n").map((l) => l.split(" │ ")[0]!);

test("two versions: the version line, the summary, the tags without a gutter bar, the old line with - and the new one with +", async () => {
  const { app, calls } = await setup(V2, versions([V1, V2], [{ text: "cap the retries" }, null]));
  assert.deepEqual(calls, ["s1|decision:ap"], "fetched once for the shown approval");
  const { text, raw } = draw(app);
  const rows = text.split("\n");
  assert.match(rows[2]!, /^\s*v1\s+v2\s*$/, "the version line has no labels and no star");
  assert.match(rows[3]!, /^v1 → v2: 1 section added · 1 changed · 1 removed · Instruction: cap the retries/);
  assert.match(raw, /\x1b\[1m\x1b\[7m v2 \x1b\[0m/, "the shown version is bold and in reverse video");
  const body = left(text);
  assert.ok(body.some((l) => /^▾ [☐☑] Goal \(\d+ lines\) \[Changed\]/.test(l)), body.join("\n"));
  assert.ok(body.some((l) => /^▸ ☐ Risks \(\d+ lines\) \[New\]/.test(l)));
  assert.ok(body.some((l) => /^\s*- Retry the export on failure\.\s*$/.test(l)), "the old line");
  assert.ok(body.some((l) => /\+ Retry the export on failure, with a cap\./.test(l)), "the new line");
  assert.ok(!body.some((l) => /\[(New|Changed)\]/.test(l) && /Steps|Notes/.test(l)), "unchanged sections carry no tag");
  assert.match(raw, /\x1b\[31m- Retry the export on failure\./, "the old line is red");
  assert.match(raw, /\x1b\[32m\+ Retry the export on failure, with a cap\./, "the new line is green");
  assert.ok(!raw.includes("▎"), "no gutter bar in the frame");
  assert.match(text.split("\n").at(-1)!, /< > version/);
});

test("< shows v1 with the note and no tags (the removed section is visible), > comes back; both languages", async () => {
  const { app } = await setup(V2, versions([V1, V2], [{ text: "cap the retries" }, null]));
  press(app, ch("<"));
  let d = draw(app);
  assert.match(d.text.split("\n")[3]!, /^v1: first version/);
  assert.ok(d.text.includes("Showing v1 (the decision is on v2)"));
  assert.ok(d.text.includes("gone soon"), "the removed section is in the earlier version");
  assert.ok(!/\[(New|Changed)\]/.test(d.text));
  assert.match(d.raw, /\x1b\[1m\x1b\[7m v1 \x1b\[0m/);
  press(app, ch("<")); // at the first one: stays
  assert.match(draw(app).text, /Showing v1/);
  press(app, ch(">"));
  d = draw(app);
  assert.ok(!d.text.includes("Showing v1"));
  assert.match(d.text.split("\n")[3]!, /^v1 → v2:/);
  app.lang = "ja";
  d = draw(app);
  assert.match(d.text.split("\n")[2]!, /^\s*v1\s+v2\s*$/);
  assert.match(d.text.split("\n")[3]!, /^v1 → v2: 1 節追加 · 1 節変更 · 1 節削除 · 指示: cap the retries/);
  assert.ok(d.text.includes("[変更]") && d.text.includes("[新規]"));
  press(app, ch("<"));
  assert.ok(draw(app).text.includes("v1 を表示中（承認対象は v2）"));
});

test("a rejection reason is labelled Rejection", async () => {
  const { app } = await setup(V2, versions([V1, V2], [{ text: "narrow it", kind: "reject" }, null]));
  assert.match(draw(app).text.split("\n")[3]!, /Rejection: narrow it/);
});

test("a short plan (no folding) is marked too", async () => {
  const { app } = await setup(SHORT2, versions([SHORT1, SHORT2], [{ text: "go" }, null]));
  const { text, raw } = draw(app);
  const body = left(text);
  assert.ok(body.some((l) => /^A \[Changed\]/.test(l)), body.join("\n"));
  assert.ok(body.some((l) => /^C \[New\]/.test(l)));
  assert.ok(body.some((l) => /- old line/.test(l)) && body.some((l) => /\+ new line/.test(l)));
  assert.match(raw, /\x1b\[31m- old line/);
});

test("one version, a failed fetch and no session: no version UI, and < > do nothing", async () => {
  const one = await setup(V2, versions([V2], [null]));
  let d = draw(one.app);
  assert.ok(!d.text.includes("v1") && !d.text.includes("< > version"));
  press(one.app, ch("<"));
  assert.equal(draw(one.app).text, d.text);
  const failed = await setup(V2, null);
  assert.ok(!draw(failed.app).text.includes("v1"));
  assert.equal(failed.calls.length, 1, "a failed fetch is not retried on every paint");
  assert.ok(draw(failed.app) && failed.calls.length === 1);
});

test("a new decision or an instruction marks the versions stale: they are fetched again", async () => {
  const { app, calls } = await setup(V2, versions([V1, V2], [{ text: "x" }, null]));
  draw(app);
  assert.equal(calls.length, 1, "painting again does not refetch");
  app.upsert(decision({ id: "ap2", tool_use_id: "t2", kind: "approve_plan", status: "answered", request: { plan: V1, planFilePath: "/x/b.md" } } as never), clock);
  draw(app);
  await tick();
  assert.equal(calls.length, 2);
});

test("i18n: both languages define the version strings", () => {
  for (const k of Object.keys(MESSAGES.en).filter((x) => x.startsWith("ver_") || x === "footer_versions")) assert.ok(k in MESSAGES.ja, k);
});
