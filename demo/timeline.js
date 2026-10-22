// @ts-check
// The storyboard (v2.1): the one file to tune. Times are script seconds; playback seconds = script seconds / speed.
// Scene times are seconds from the start of the scene. Changing a scene's dur shifts every scene after it.

/** @typedef {import("./stage/types.js").Timeline} Timeline */
/** @typedef {import("./stage/types.js").Story} Story */

/** @type {Story} */
export const story = {
  en: {
    cc: { prompt: "Failed exports should retry with backoff. Plan it first.", question: "Where should the retry for failed exports live?" },
    codex: { prompt: "Make the onboarding page convert better. Show me options.", question: "Which onboarding page variant should we ship?" },
    cc2: { prompt: "Add a currency column to the orders table.", instruction: "Backfill in batches: one UPDATE would lock orders for minutes." },
  },
  ja: {
    cc: { prompt: "失敗したエクスポートをバックオフ付きでリトライさせたい。まずプランを立てて", question: "失敗したエクスポートのリトライはどこに置くべきですか？" },
    codex: { prompt: "オンボーディングページの登録率を上げたい。案を見せて", question: "公開するオンボーディングページはどの案にしますか？" },
    cc2: { prompt: "orders テーブルに currency 列を追加して", instruction: "バッチで埋め戻して。1 回の UPDATE だと orders が数分ロックされる" },
  },
};

const both = (/** @type {(l: "en" | "ja") => string} */ f) => ({ en: f("en"), ja: f("ja") });
const recHero = { en: "In the queue worker (Recommended)", ja: "キューのワーカー (推奨)" };
const recCompare = { en: "Variant A, centered (Recommended)", ja: "案 A（中央寄せ） (推奨)" };

// What ukagai itself prints. test/demo checks these against the product's output.
const HOOK_Q = "PreToolUse:AskUserQuestion hook error: [ukagai, not a failure] Question sent to the human in ukagai: end your turn, the answer arrives as a message (see hook context).";
const HOOK_P = "PreToolUse:ExitPlanMode hook error: [ukagai, not a failure] Plan sent to the human in ukagai: stay in plan mode and end your turn, the decision arrives as a message (see hook context).";
const MSG_ANSWER = both((l) => `[ukagai] (ref 3f2a9c1e) The human answered your question in the ukagai GUI:\n- ${JSON.stringify(story[l].cc.question)}: ${JSON.stringify(recHero[l])}`);
const MSG_INSTRUCT = both(
  (l) =>
    `[ukagai] (ref 7d41c0aa) The human has not approved the plan yet and asks you to do this first: ${story[l].cc2.instruction}\nYou are still in plan mode: do it (research, subagents and reviews are fine; do not edit project files), update the plan file, then call ExitPlanMode again.`,
);
const MSG_APPROVED = "[ukagai] (ref 9b0d6e2f) The human approved your plan in the ukagai GUI. Call ExitPlanMode once more with the same plan, without editing the plan file first; it will be allowed.";
const CODEX_BLOCKED = both((l) => `Blocked by hook: The human answered in the ukagai GUI: ${story[l].codex.question} = ${recCompare[l]}. Do not ask again; continue with this answer.`);

const PLAN_MODE = "⏸ plan mode on (shift+tab to cycle)";

/** @type {Timeline} */
const timeline = {
  width: 1280,
  height: 720,
  fps: 24,
  loopDissolve: 0.6,
  speed: 1.5,
  windows: {
    cc: { kind: "terminal", agent: "claude", title: "claude — export-service", status: PLAN_MODE, repo: "export-service", w: 600, h: 520 },
    codex: { kind: "terminal", agent: "codex", title: "codex — web-app", repo: "web-app", w: 600, h: 520 },
    cc2: { kind: "terminal", agent: "claude", title: "claude — orders-api", status: PLAN_MODE, repo: "orders-api", w: 600, h: 520 },
    gui: { kind: "browser", title: "ukagai", url: "127.0.0.1:4818", w: 680 },
  },
  layouts: {
    row: { cc: { x: 24, y: 150, s: 0.66 }, codex: { x: 442, y: 150, s: 0.66 }, cc2: { x: 860, y: 150, s: 0.66 } },
    stack: { cc: { x: 16, y: 16, s: 0.43 }, codex: { x: 16, y: 250, s: 0.43 }, cc2: { x: 16, y: 484, s: 0.43 }, gui: { x: 300, y: 30, s: 1.4 } },
  },
  captions: {
    fleet: { n: "1", en: "Several agents at once: Claude Code and Codex", ja: "Claude Code と Codex、エージェントを何体も同時に" },
    inbox: { n: "2", en: "Every question and plan lands in one inbox", ja: "質問もプランも、1 つの受信箱に届く" },
    explain: { n: "3", en: "Each comes with the agent's own explanation", ja: "エージェント自身の説明つき" },
    keys: { n: "4", en: "Answer from the keyboard", ja: "キーボードで答える" },
    message: { n: "5", en: "Your answer reaches the agent as a message", ja: "答えはメッセージとしてエージェントに届く" },
    compare: { n: "6", en: "Compare HTML mockups side by side", ja: "HTML の案を並べて比べる" },
    codex: { n: "7", en: "Codex continues with your choice", ja: "Codex も選んだ案で続ける" },
    plan: { n: "8", en: "Review the plan: what changed, the diff, the code", ja: "プランを読む: 変更点、diff、コード" },
    approve: { n: "9", en: "Approve, instruct or reject", ja: "承認・指示・却下" },
    zero: { n: "10", en: "Inbox zero. Every agent keeps going.", ja: "受信箱は空に。どのエージェントも先へ進む" },
  },
  scenes: [
    {
      name: "fleet",
      dur: 2.0,
      caption: "fleet",
      layout: { to: "row", dur: 0 },
      gui: [{ at: 0, shot: "empty" }],
      term: {
        cc: [
          { at: 0, kind: "user", text: both((l) => story[l].cc.prompt) },
          { at: 0, kind: "tool", text: "Read(src/export/job.ts)" },
          { at: 0, kind: "result", text: "Read 118 lines" },
          { at: 0.6, kind: "tool", text: "Write(~/.claude/plans/retry-exports.md)" },
          { at: 0.8, kind: "result", text: "Wrote 38 lines to ~/.claude/plans/retry-exports.md" },
        ],
        codex: [
          { at: 0, kind: "user", text: both((l) => story[l].codex.prompt) },
          { at: 0, kind: "tool", text: "Explored" },
          { at: 0, kind: "result", text: "Read onboarding.html, signup.css" },
          { at: 0.9, kind: "tool", text: "Wrote a.html, b.html" },
        ],
        cc2: [
          { at: 0, kind: "user", text: both((l) => story[l].cc2.prompt) },
          { at: 0, kind: "message", text: MSG_INSTRUCT },
          { at: 1.2, kind: "tool", text: "Read(src/orders/checkout.ts)" },
          { at: 1.4, kind: "result", text: "Read 62 lines" },
          { at: 1.7, kind: "tool", text: "Edit(~/.claude/plans/orders-currency.md)" },
          { at: 1.9, kind: "result", text: "Updated ~/.claude/plans/orders-currency.md with 1 addition and 1 removal" },
        ],
      },
    },
    { name: "gather", dur: 0.9, layout: { to: "stack", at: 0, dur: 0.8 }, focus: [{ at: 0, window: "gui" }] },
    {
      name: "arrive",
      dur: 2.8,
      caption: "inbox",
      gui: [
        { at: 0.85, shot: "q1" },
        { at: 1.45, shot: "q2" },
        { at: 2.05, shot: "q3" },
      ],
      term: {
        cc: [
          { at: 0.1, kind: "tool", text: both((l) => `AskUserQuestion(${story[l].cc.question})`) },
          { at: 0.3, kind: "error", text: HOOK_Q },
          { at: 0.6, kind: "text", text: { en: "I asked in ukagai where the retry should live. I'll continue when the answer arrives.", ja: "リトライの置き場所を ukagai で聞きました。回答が届いたら続けます。" } },
        ],
        codex: [{ at: 0.7, kind: "tool", text: both((l) => `request_user_input(${story[l].codex.question})`) }],
        cc2: [
          { at: 1.3, kind: "tool", text: "ExitPlanMode" },
          { at: 1.5, kind: "error", text: HOOK_P },
          { at: 1.8, kind: "text", text: { en: "The revised plan is in ukagai. I'll continue when you decide.", ja: "直したプランを ukagai に出しました。決まったら続けます。" } },
        ],
      },
      beams: [
        { at: 0.35, from: "cc", to: { anchor: "q3.pending" } },
        { at: 0.95, from: "codex", to: { anchor: "q3.pending" } },
        { at: 1.55, from: "cc2", to: { anchor: "q3.pending" } },
      ],
      pulse: [
        { at: 0.85, window: "gui" },
        { at: 1.45, window: "gui" },
        { at: 2.05, window: "gui" },
      ],
    },
    {
      name: "list",
      dur: 2.7,
      camera: [{ at: 0.3, to: { anchor: "inbox.items", pad: 20 } }],
      gui: [
        { at: 0.1, shot: "inbox" },
        { at: 2.5, shot: "hero" },
      ],
      keys: [
        { at: 0.1, key: "b" },
        { at: 2.5, key: "Enter" },
      ],
    },
    {
      name: "explain",
      dur: 5.4,
      caption: "explain",
      camera: [
        { at: 0, to: { anchor: "hero.mermaid", pad: 16 } },
        { at: 2.25, to: { anchor: "hero.lower", pad: 16 }, dur: 0.9 },
        { at: 4.5, to: { anchor: "hero.options", pad: 16 } },
      ],
      gui: [{ at: 2.25, shot: "hero@", scroll: { from: 0, to: 1, dur: 0.9 } }],
    },
    {
      name: "keys",
      dur: 2.4,
      caption: "keys",
      gui: [
        { at: 0.55, shot: "pick2" },
        { at: 1.0, shot: "pick1" },
        { at: 1.55, shot: "hero-answered" },
      ],
      keys: [
        { at: 0.55, key: "j" },
        { at: 1.0, key: "k" },
        { at: 1.55, key: "Enter" },
      ],
    },
    {
      name: "message",
      dur: 2.8,
      caption: "message",
      camera: [{ at: 0, to: { window: "cc", pad: 16 }, dur: 0 }],
      focus: [{ at: 0, window: "cc" }],
      gui: [{ at: 1.0, shot: "compare" }],
      beams: [{ at: 0.1, from: "gui", to: { window: "cc" } }],
      term: {
        cc: [
          { at: 0.7, kind: "message", text: MSG_ANSWER },
          { at: 1.4, kind: "text", text: { en: "The retry goes in the queue worker. Writing the plan.", ja: "リトライはキューのワーカーに置きます。プランを書きます。" } },
          { at: 1.9, kind: "tool", text: "Edit(~/.claude/plans/retry-exports.md)" },
          { at: 2.1, kind: "result", text: "Updated ~/.claude/plans/retry-exports.md with 44 additions and 1 removal" },
        ],
      },
    },
    {
      name: "compare",
      dur: 2.8,
      caption: "compare",
      camera: [{ at: 0, to: { anchor: "compare.body", pad: 12 }, dur: 0 }],
      focus: [{ at: 0, window: "gui" }],
      gui: [{ at: 1.95, shot: "compare-answered" }],
      keys: [{ at: 1.95, key: "1" }],
    },
    {
      name: "codex",
      dur: 2.35,
      caption: "codex",
      camera: [{ at: 0, to: { window: "codex", pad: 16 }, dur: 0 }],
      focus: [{ at: 0, window: "codex" }],
      gui: [{ at: 1.3, shot: "plan" }],
      beams: [{ at: 0.05, from: "gui", to: { window: "codex" } }],
      term: {
        codex: [
          { at: 0.6, kind: "error", text: CODEX_BLOCKED },
          { at: 1.3, kind: "text", text: { en: "Variant A it is. Replacing onboarding.html with a.html.", ja: "案 A にします。onboarding.html を a.html の内容に置き換えます。" } },
        ],
      },
    },
    {
      name: "plan",
      dur: 6.1,
      caption: "plan",
      camera: [
        { at: 0, to: { anchor: "plan.top", pad: 16 }, dur: 0 },
        { at: 1.3, to: { anchor: "plan-src.snip", pad: 12 } },
        { at: 3.55, to: { anchor: "plan-src.steps", pad: 12 }, dur: 1.05 },
      ],
      focus: [{ at: 0, window: "gui" }],
      gui: [
        { at: 0.95, shot: "plan-src" },
        { at: 3.55, shot: "plan-src@", scroll: { from: 0, to: 1, dur: 1.05 } },
      ],
      cursor: [
        { at: 0.25, to: { anchor: "plan.toggle" }, dur: 0.5 },
        { at: 0.95, to: { anchor: "plan.toggle" }, dur: 0, click: true },
        { at: 1.3, to: null },
      ],
    },
    {
      name: "approve",
      dur: 2.35,
      caption: "approve",
      camera: [{ at: 0, to: { anchor: "plan.actions", pad: 16 } }],
      gui: [{ at: 1.5, shot: "plan-approved" }],
      keys: [{ at: 1.5, key: "y" }],
    },
    {
      name: "zero",
      dur: 3.4,
      caption: { at: 0.2, key: "zero" },
      camera: [{ at: 0, to: "all" }],
      focus: [{ at: 0, window: null }],
      layout: { to: "row", at: 2.0, dur: 0.8 },
      gui: [{ at: 1.0, shot: "zero" }],
      beams: [{ at: 0.3, from: "gui", to: { window: "cc2" } }],
      term: {
        cc2: [
          { at: 0.8, kind: "message", text: MSG_APPROVED },
          { at: 1.2, kind: "tool", text: "ExitPlanMode" },
          { at: 1.35, kind: "result", text: "User has approved your plan" },
          { at: 1.4, kind: "status", text: "⏵⏵ auto mode on (shift+tab to cycle)" },
          { at: 1.7, kind: "tool", text: "Write(db/migrations/0042_add_currency.sql)" },
        ],
        cc: [
          { at: 1.0, kind: "tool", text: "Read(src/export/worker.ts)" },
          { at: 1.15, kind: "result", text: "Read 64 lines" },
        ],
        codex: [{ at: 1.2, kind: "tool", text: "Edited onboarding.html (+38 -52)" }],
      },
    },
  ],
};

export default timeline;
