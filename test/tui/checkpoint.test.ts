// Progress checkpoints in the TUI: the same card as the GUI (title, recap, three one-press cards, no None / Can't answer), the same words in en and ja,
// the same order (blockers, questions and plans, checkpoints, plan files). No network: the App is driven with keys and rendered to a frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Decision, PlanSummary, SessionSummary } from "../../src/contract.js";
import type { Key } from "../../src/tui/keys.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import { parseSse } from "../../src/tui/api.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { BLOCKER_MD, BLOCKER_Q, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
let clock = Date.parse("2026-10-04T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const type = (app: App, text: string) => press(app, ...[...text].map(ch));

const RECAP = "Added the retry to the uploader and the tests pass. Next I would wire it into the CLI and update the README.";
const SID = "s-ck";

function checkpoint(over: Partial<Decision> = {}): Decision {
  return {
    id: "ck1",
    kind: "checkpoint",
    tool_use_id: `checkpoint:${SID}:2026-10-04T11:50:00.000Z`,
    session: { session_id: SID, cwd: "/Users/a/.herdr/worktrees/ukagai/feat-ck" },
    request: { recap: RECAP, recap_at: "2026-10-04T11:50:00.000Z" },
    context: {},
    status: "pending",
    created_at: "2026-10-04T11:50:00.000Z",
    ...over,
  } as Decision;
}

const sess = (state: SessionSummary["state"]): SessionSummary => ({ session_id: SID, state, last_event_at: new Date(clock).toISOString(), cwd: "/Users/a/.herdr/worktrees/ukagai/feat-ck" });

function draw(app: App, cols = 140, rows = 40) {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return { text: stripAnsi(frame.text), lines: frame.lines.map(stripAnsi), raw: frame.text };
}

function setup(...ds: Decision[]): App {
  const app = new App();
  app.replacePending(ds, clock);
  return app;
}

test("TUI checkpoint: title, first sentence, optional line, the recap, three cards, no None / Can't answer", () => {
  const app = setup(checkpoint());
  const { lines, text } = draw(app);
  assert.match(lines[0]!, /^feat-ck|^ukagai ⎇|^ukagai/); // the origin still comes first
  assert.ok(lines[1]!.includes("Progress check · feat-ck"), lines[1]);
  assert.ok(lines[2]!.includes("Added the retry to the uploader and the tests pass."), lines[2]);
  assert.ok(!lines[2]!.includes("Next I would"), "row 2 is the first sentence only");
  assert.ok(lines[3]!.includes("The agent keeps working if you do not answer"), lines[3]);
  assert.ok(text.includes(RECAP.slice(0, 40)), "the recap in the background column");
  assert.ok(lines.some((l) => /1\s+▸\s+Continue\s+Recommended/.test(l)), "card 1");
  assert.ok(lines.some((l) => /2\s+Give an instruction…/.test(l)), "card 2");
  assert.ok(lines.some((l) => /3\s+Stop here/.test(l)), "card 3");
  assert.ok(!/None of these|Can't answer|Free text/.test(text));
  assert.ok(!text.includes("idle"), "no idle note while the session works");
});

test("TUI checkpoint: 1 sends {kind: continue}; 3 sends {kind: stop} with one press", () => {
  assert.deepEqual(press(setup(checkpoint()), ch("1")), [{ type: "answer", id: "ck1", body: { kind: "continue" } }]);
  assert.deepEqual(press(setup(checkpoint()), ch("3")), [{ type: "answer", id: "ck1", body: { kind: "stop" } }]);
});

test("TUI checkpoint: Enter acts on the card under the cursor; j moves; the first card is the default", () => {
  assert.deepEqual(press(setup(checkpoint()), enter), [{ type: "answer", id: "ck1", body: { kind: "continue" } }]);
  const app = setup(checkpoint());
  press(app, ch("j"), { name: "esc" }, ch("j")); // j onto the instruction card opens its box; Esc leaves it
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "ck1", body: { kind: "stop" } }]);
});

test("TUI checkpoint: 2 opens the box; text + Enter sends {kind: instruct, text}; an empty box sends nothing", () => {
  const app = setup(checkpoint());
  assert.deepEqual(press(app, ch("2")), []);
  assert.equal(app.mode, "input");
  assert.deepEqual(press(app, enter), []);
  assert.equal(app.mode, "normal");
  press(app, ch("2"));
  type(app, "also bump the version");
  assert.ok(draw(app).text.includes("also bump the version▏"));
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "ck1", body: { kind: "instruct", text: "also bump the version" } }]);
});

test("TUI checkpoint: i opens the box too; Esc leaves it without sending", () => {
  const app = setup(checkpoint());
  press(app, ch("i"));
  assert.equal(app.mode, "input");
  type(app, "x");
  assert.deepEqual(press(app, esc), []);
  assert.equal(app.mode, "normal");
});

test("TUI checkpoint: n and x do nothing (no None of these / Can't answer)", () => {
  const app = setup(checkpoint());
  assert.deepEqual(press(app, ch("n"), ch("x")), []);
  assert.equal(app.mode, "normal");
});

test("TUI checkpoint: idle note only while the session is idle (set from GET /api/sessions and session.updated)", () => {
  const app = setup(checkpoint());
  app.setSessions([sess("working")]);
  assert.ok(!draw(app).text.includes("The agent is idle"));
  app.sessionUpdated(sess("idle"));
  assert.ok(draw(app, 100).text.includes("The agent is idle; your reply arrives at its next tool call"));
  app.sessionUpdated(sess("working"));
  assert.ok(!draw(app).text.includes("The agent is idle"));
  const ev = parseSse(`event: session.updated\ndata: ${JSON.stringify(sess("idle"))}`);
  assert.equal(ev?.event, "session.updated");
});

test("TUI checkpoint: Japanese words", () => {
  const app = setup(checkpoint());
  app.lang = "ja";
  app.setSessions([sess("idle")]);
  const { text, lines } = draw(app, 100);
  assert.ok(lines[1]!.includes("進捗確認 · feat-ck"), lines[1]);
  assert.ok(text.includes("答えなくてもエージェントは進みます"));
  assert.ok(text.includes("このまま続ける"));
  assert.ok(text.includes("指示を出す…"));
  assert.ok(text.includes("ここで止める"));
  assert.ok(text.includes("エージェントは待機中。返事は次のツール実行時に届きます"));
});

test("TUI checkpoint: order — a blocker, then a question, then the checkpoint, then plan files; the count includes it; the list says recap", () => {
  const q = decision({ id: "q1", created_at: "2026-10-04T11:55:00.000Z" });
  const b = decision({ id: "b1", created_at: "2026-10-04T11:58:00.000Z", ...withExplanation(BLOCKER_MD) });
  const app = new App();
  app.replacePending([checkpoint(), q, b], clock);
  assert.deepEqual(app.pending().map((d) => d.id), ["b1", "q1", "ck1"]);
  assert.equal(app.shownId, "b1");
  assert.equal(app.count(clock), 3);
  assert.ok(BLOCKER_Q);
  // A plan file comes after the checkpoint
  const plan: PlanSummary = { name: "p.md", title: "A plan file", mtime: new Date(clock - 60_000).toISOString(), bytes: 10, sections: 1, lines: 3, read: false };
  app.replacePlans([plan], clock);
  press(app, ch("b"));
  const rows = draw(app).lines.filter((l) => /^ ?[▸ ] /.test(l) && !l.startsWith("      ") && !l.startsWith("    "));
  const ixCk = rows.findIndex((l) => l.includes("Progress check"));
  const ixPlan = rows.findIndex((l) => l.includes("A plan file"));
  assert.ok(ixCk > 0 && ixPlan > ixCk, rows.join("\n"));
  assert.ok(draw(app).text.includes("recap"));
});

test("TUI checkpoint: answering moves on to the next item; a cancelled update removes it silently", () => {
  const q = decision({ id: "q1", created_at: "2026-10-04T11:55:00.000Z" });
  const app = new App();
  app.replacePending([checkpoint()], clock);
  assert.equal(app.shownId, "ck1");
  // A question that arrives outranks the checkpoint on screen
  app.upsert(q, clock);
  assert.equal(app.shownId, "q1");
  app.upsert({ ...checkpoint(), status: "cancelled", status_reason: "superseded" } as Decision, clock);
  assert.equal(app.pending().length, 1);
  assert.ok(!draw(app).text.includes("Delivered") && !draw(app).text.includes("Cancelled"));
  const only = setup(checkpoint());
  only.upsert({ ...checkpoint(), status: "cancelled", status_reason: "expired" } as Decision, clock);
  assert.equal(only.shownId, null);
  assert.ok(!draw(only).text.includes("Cancelled"));
});

test("TUI and GUI use the same words for checkpoints", async () => {
  const { MESSAGES: GUI } = (await import(new URL("../../public/i18n.js", import.meta.url).href)) as { MESSAGES: Record<"en" | "ja", Record<string, string>> };
  const table = {
    checkpoint_title: ["Progress check", "進捗確認"],
    checkpoint_optional: ["The agent keeps working if you do not answer", "答えなくてもエージェントは進みます"],
    checkpoint_continue: ["Continue", "このまま続ける"],
    checkpoint_instruct: ["Give an instruction…", "指示を出す…"],
    checkpoint_stop: ["Stop here", "ここで止める"],
    checkpoint_idle: ["The agent is idle; your reply arrives at its next tool call", "エージェントは待機中。返事は次のツール実行時に届きます"],
    checkpoint_idle_terminal: ["The agent is idle; your reply will be typed into its terminal (an unsent draft there goes with it)", "エージェントは待機中。返事はエージェントの端末に入力されます（未送信の下書きがあれば一緒に送られます）"],
    checkpoint_sent: ["Reply sent", "返事を送りました"],
    checkpoint_delivered: ["Reply delivered", "返事が届きました"],
    history_delivered: ["delivered", "届いた"],
    history_undelivered: ["not delivered yet", "未配達"],
    checkpoint_kind: ["recap", "進捗"],
    checkpoint_placeholder: ["What should the agent do next?", "エージェントに次に何をさせますか？"],
  } as const;
  for (const [k, [en, ja]] of Object.entries(table)) {
    assert.equal(MESSAGES.en[k as keyof typeof MESSAGES.en], en, `tui en.${k}`);
    assert.equal(MESSAGES.ja[k as keyof typeof MESSAGES.ja], ja, `tui ja.${k}`);
    assert.equal(GUI.en![k], en, `gui en.${k}`);
    assert.equal(GUI.ja![k], ja, `gui ja.${k}`);
  }
});

// ---- delivery: terminal note, sent vs delivered, history mark ----

const answeredCk = (id: string, kind: "instruct" | "stop" | "continue", delivered: boolean, at: string): Decision =>
  checkpoint({
    id,
    status: "answered",
    response: { via: "gui", kind, ...(kind === "continue" ? {} : { text: `text of ${id}` }), decided_at: at, ...(delivered ? { delivered_at: at, delivered_via: "terminal" as const } : {}) },
  } as Partial<Decision>);

// The note wraps inside its column: compare without the column bars and whitespace
const flat = (text: string) => text.replace(/[│\s]+/g, "");

test("TUI checkpoint: idle note says the reply is typed into the terminal when the session has one (en and ja)", () => {
  const app = setup(checkpoint());
  app.sessionUpdated({ ...sess("idle"), terminal: "herdr:w1:p1" });
  assert.ok(flat(draw(app, 100).text).includes(flat("The agent is idle; your reply will be typed into its terminal (an unsent draft there goes with it)")));
  app.lang = "ja";
  assert.ok(flat(draw(app, 100).text).includes(flat("エージェントは待機中。返事はエージェントの端末に入力されます（未送信の下書きがあれば一緒に送られます）")));
  app.lang = "en";
  app.sessionUpdated(sess("idle"));
  assert.ok(flat(draw(app, 100).text).includes(flat("your reply arrives at its next tool call")));
});

test("TUI checkpoint: answered says Reply sent; a later decision.updated with delivered_at says Reply delivered", () => {
  const app = setup(checkpoint());
  const sent = answeredCk("ck1", "instruct", false, "2026-10-04T12:00:00.000Z");
  app.answered(sent, clock);
  assert.ok(draw(app).text.includes("Reply sent"));
  assert.ok(!draw(app).text.includes("Delivered"));
  app.upsert(answeredCk("ck1", "instruct", true, "2026-10-04T12:00:00.000Z"), clock);
  assert.ok(draw(app).text.includes("Reply delivered"));
});

test("TUI checkpoint: the s list marks answered checkpoints delivered / not delivered yet; continue shows nothing", async () => {
  const app = new App();
  app.fetchHistory = async () => ({
    session_id: SID,
    total: 2,
    first: { at: "2026-10-04T08:00:00.000Z", text: "start the work" },
    recent: [{ at: "2026-10-04T08:00:00.000Z", text: "start the work" }, { at: "2026-10-04T09:00:00.000Z", text: "second prompt" }],
  });
  app.replacePending([checkpoint()], clock);
  app.upsert(answeredCk("a1", "instruct", true, "2026-10-04T10:00:00.000Z"), clock);
  app.upsert(answeredCk("a2", "stop", false, "2026-10-04T11:00:00.000Z"), clock);
  app.upsert(answeredCk("a3", "continue", false, "2026-10-04T11:30:00.000Z"), clock);
  await new Promise((r) => setTimeout(r, 20));
  press(app, ch("s"));
  const text = draw(app).text;
  assert.match(text, /text of a1.*delivered/);
  assert.match(text, /text of a2.*not delivered yet/);
  assert.ok(!text.includes("text of a3"));
  app.lang = "ja";
  const ja = draw(app).text;
  assert.match(ja, /text of a1.*届いた/);
  assert.match(ja, /text of a2.*未配達/);
});
