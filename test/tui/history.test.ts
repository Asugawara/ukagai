import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionHistory } from "../../src/contract.js";
import { App } from "../../src/tui/app.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { BLOCKER_MD, Q, V2_MD, blockerDecision, decision, withExplanation } from "./helpers.js";
import type { Decision } from "../../src/contract.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
let now = Date.parse("2026-10-02T12:00:00Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (now += 10)));
const tick = () => new Promise<void>((r) => setImmediate(r));
const draw = (app: App, lang: "en" | "ja" = "en", cols = 160) => {
  app.lang = lang;
  const f = renderFrame(app.view(now), { cols, rows: 40 });
  app.syncFrame(f, now);
  return stripAnsi(f.text);
};

const at = (h: number) => new Date(now - h * 3600_000).toISOString();
const FIRST = "Implement the history view. ".repeat(12).trim();
const HIST: SessionHistory = {
  session_id: "s1",
  total: 3,
  first: { at: at(30), text: FIRST },
  recent: [
    { at: at(30), text: FIRST.slice(0, 500) },
    { at: at(5), text: "second instruction" },
    { at: at(1), text: "third\ninstruction" },
  ],
};

interface Fx {
  app: App;
  calls: string[];
}
/** An App with a history fetcher; `result` may be a function so a test can fail or vary it */
function setup(result: SessionHistory | Error = HIST): Fx {
  const app = new App();
  const calls: string[] = [];
  app.fetchHistory = async (id) => {
    calls.push(id);
    if (result instanceof Error) throw result;
    return result;
  };
  app.upsert(decision({ ...withExplanation(V2_MD) }), now);
  return { app, calls };
}

test("the fetched first instruction lands in the model", async () => {
  const { app } = setup();
  assert.equal(app.model()?.history, null);
  await tick();
  assert.equal(app.model()?.history?.first?.text, FIRST);
  assert.equal(app.model()?.history?.total, 3);
});

test("Goal is cut at two rows with …, the rest of the background follows", async () => {
  const { app } = setup();
  await tick();
  const text = draw(app, "en", 160).split("\n");
  const i = text.findIndex((l) => l.includes("Goal "));
  assert.ok(i >= 0);
  const left = (l: string) => l.split(" │ ")[0]!;
  assert.match(left(text[i]!), /^Goal Implement the history view\./);
  assert.ok(left(text[i + 1]!).trimEnd().endsWith("…"), left(text[i + 1]!));
  assert.match(left(text[i + 2]!).trim(), /^─+$/, "a rule under the goal");
  assert.equal(left(text[i + 3]!).trim(), "");
  assert.ok(text.slice(i + 4).some((l) => left(l).includes("Why this decision")));
  assert.ok(draw(app, "ja").includes("目的 "));
});

test("a short instruction is not cut", async () => {
  const { app } = setup({ ...HIST, first: { at: at(1), text: "fix the bug" } });
  await tick();
  assert.ok(draw(app).includes("Goal fix the bug"));
  assert.ok(!draw(app).includes("fix the bug…"));
});

test("s opens the list: first marked, chronological, the first one is not repeated", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("s"));
  assert.equal(app.mode, "history");
  const text = draw(app);
  assert.match(text, /This session's instructions/);
  const rows = text.split("\n").filter((l) => /instruction|Implement/.test(l) && !l.includes("session's"));
  assert.equal(rows.length, 3, text);
  assert.match(rows[0]!, /30h\s+first Implement the history view/);
  assert.match(rows[1]!, /5h\s+second instruction/);
  assert.match(rows[2]!, /▸.*1h\s+third instruction/, "newest is under the cursor, line break folded to a space");
  assert.match(text, /Enter full text/);
});

test("j/k move; Enter shows the full text in the background column; Esc goes back to the list, Esc closes it", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("s"), ch("k"), ch("k"), enter);
  assert.equal(app.mode, "normal");
  let text = draw(app);
  assert.match(text, /Instruction 30h · first/);
  assert.ok(!text.includes("Goal "));
  assert.ok(text.includes("Implement the history view. Implement the history view."));
  assert.doesNotMatch(text, /…\s*│/);
  press(app, esc);
  assert.equal(app.mode, "history");
  assert.equal(app.view(now).history?.index, 0, "the list reopens where it was");
  press(app, esc);
  assert.equal(app.mode, "normal");
  text = draw(app);
  assert.ok(text.includes("Goal "));
});

test("a long entry keeps its line breaks in the full view", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("s"), enter);
  const lines = draw(app).split("\n").map((l) => l.split(" │ ")[0]!.trim());
  const i = lines.indexOf("third");
  assert.ok(i > 0 && lines[i + 1] === "instruction", lines.join("|"));
});

test("a failed fetch shows nothing and s does nothing; the next show retries", async () => {
  const { app, calls } = setup(new Error("boom"));
  await tick();
  assert.equal(app.model()?.history, null);
  assert.ok(!draw(app).includes("Goal "));
  press(app, ch("s"));
  assert.equal(app.mode, "normal");
  assert.equal(calls.length, 1);
  app.upsert(decision({ id: "d2", tool_use_id: "t2", created_at: "2026-10-02T00:01:00.000Z", ...withExplanation(V2_MD) }), now);
  press(app, ch("]"));
  assert.equal(calls.length, 2, "not cached, so it is asked again");
});

test("an empty history (unreadable transcript) shows nothing", async () => {
  const { app } = setup({ session_id: "s1", total: 0, first: null, recent: [] });
  await tick();
  assert.ok(!draw(app).includes("Goal "));
  press(app, ch("s"));
  assert.equal(app.mode, "normal");
});

test("the same session is fetched once, a different session separately", async () => {
  const { app, calls } = setup();
  await tick();
  const other = (id: string, sid: string, created: string) =>
    decision({ id, tool_use_id: id, session: { session_id: sid, cwd: "/x", transcript_path: "/x" }, created_at: created, ...withExplanation(V2_MD) });
  app.upsert(other("d2", "s1", "2026-10-02T00:01:00.000Z"), now);
  press(app, ch("]"));
  press(app, ch("[")); // back and forth
  await tick();
  assert.deepEqual(calls, ["d1"]);
  app.upsert(other("d3", "s9", "2026-10-02T00:02:00.000Z"), now);
  press(app, ch("]"), ch("]"));
  await tick();
  assert.deepEqual(calls, ["d1", "d3"]);
  assert.equal(app.model()?.history?.session_id, "s1", "d3's own fetch resolved with the stub");
});

test("two shows before the answer arrives still fetch once", async () => {
  const { app, calls } = setup();
  app.upsert(decision({ id: "d2", tool_use_id: "t2", created_at: "2026-10-02T00:01:00.000Z", ...withExplanation(V2_MD) }), now);
  press(app, ch("]"), ch("["));
  await tick();
  assert.equal(calls.length, 1);
});

test("without a fetcher nothing is asked and nothing is shown", () => {
  const app = new App();
  app.upsert(decision({ ...withExplanation(V2_MD) }), now);
  assert.ok(!draw(app).includes("Goal "));
});

// ---- no clash with 1-9 / x / n / typing ----

const answerOf = (e: ReturnType<typeof press>): string | undefined => {
  const a = e.find((x) => x.type === "answer");
  return a && a.type === "answer" ? (a.body["answers"] as Record<string, string>)[Q] : undefined;
};

test("digits and x do nothing inside the s list; after Esc they work as before", async () => {
  const { app } = setup();
  await tick();
  assert.deepEqual(press(app, ch("s"), ch("2"), ch("x"), ch("n")), []);
  assert.equal(app.mode, "history");
  press(app, esc);
  assert.equal(answerOf(press(app, ch("2"))), "WebSocket");
});

test("s reaches nothing else: x still opens Can't answer, 1 still sends the first card", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("x"));
  assert.equal(app.mode, "cannot");
  press(app, ch("s"));
  assert.equal(app.mode, "cannot", "s inside the picker is ignored");
  press(app, esc);
  assert.equal(answerOf(press(app, ch("1"))), "SSE (Recommended)");
});

test("typing free text with s in it does not open the list", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("i"), ch("s"), ch("s"));
  assert.equal(app.mode, "input");
  assert.equal(app.view(now).input?.text, "ss");
});

test("irreversible: s between the two number presses disarms the confirmation", async () => {
  const app = new App();
  app.fetchHistory = async () => HIST;
  app.upsert(decision({ ...withExplanation(V2_MD.replace("reversibility: costly", "reversibility: irreversible")) }), now);
  await tick();
  assert.deepEqual(press(app, ch("2")), []);
  press(app, ch("s"), esc);
  assert.deepEqual(press(app, ch("2")), [], "armed again, not sent");
  assert.equal(answerOf(press(app, ch("2"))), "WebSocket");
});

test("a decision change closes the overlay and the full view", async () => {
  const { app } = setup();
  await tick();
  press(app, ch("s"), enter);
  app.upsert(decision({ id: "d2", tool_use_id: "t2", created_at: "2026-10-02T00:01:00.000Z", ...withExplanation(V2_MD) }), now);
  press(app, ch("]"));
  assert.equal(app.view(now).histDetail, null);
  press(app, ch("s"));
  assert.equal(app.mode, "history");
  press(app, ch("s"));
  assert.equal(app.mode, "normal", "s toggles");
});

test("footer mentions s only when there are 2+ instructions; i18n keys match", async () => {
  const { app } = setup();
  assert.ok(!draw(app).includes("s history"));
  await tick();
  assert.ok(draw(app).includes("s history"));
  assert.ok(draw(app, "ja").includes("s 履歴"));
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.ja).sort());
});

test("narrow (stacked) layout also shows Goal:", async () => {
  const { app } = setup();
  await tick();
  assert.ok(draw(app, "en", 90).includes("Goal "));
});

// `s` on every kind of card, right after the fetch and long after it (the TUI cache has no TTL: it must keep working, never go stale-silent)
const KINDS: Record<string, () => Decision> = {
  "single question": () => decision({ ...withExplanation(V2_MD) }),
  "question without explanation": () => decision(),
  "multi-question": () => decision({ request: { questions: [
    { question: "First?", header: "H1", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
    { question: "Second?", header: "H2", multiSelect: true, options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] }] } }),
  quiz: () => decision({ ...withExplanation(V2_MD, { type: "quiz" }) }),
  blocker: () => blockerDecision(),
  "approve plan": () => decision({ kind: "approve_plan", request: { plan: "# Plan\n\nStep 1", planFilePath: "/tmp/p.md" } }),
  checkpoint: () => decision({ kind: "checkpoint", tool_use_id: "checkpoint:s1:2026-10-02T00:00:00.000Z", request: { recap: "Did a thing. Next another.", recap_at: "2026-10-02T00:00:00.000Z" } }),
};
for (const [name, make] of Object.entries(KINDS)) {
  for (const later of [false, true]) {
    test(`s opens the history on a ${name} card${later ? " an hour later" : ""} (Goal row shown, footer / list unchanged)`, async () => {
      const app = new App();
      app.fetchHistory = async () => HIST;
      app.upsert(make(), now);
      await tick();
      if (later) now += 3600_000;
      assert.match(draw(app), /Goal /);
      press(app, ch("s"));
      assert.match(draw(app), /second instruction/);
      press(app, esc);
      assert.doesNotMatch(draw(app), /second instruction/);
    });
  }
}
