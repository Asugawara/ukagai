// HerdrTerminal against a fake `herdr` first on PATH: it records its argv and prints canned JSON.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrTerminal, replyLine, terminalLabel, TerminalTypeError } from "../../src/serve/terminal.js";

const dir = mkdtempSync(join(tmpdir(), "ukagai-term-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LIST = JSON.stringify({
  result: {
    panes: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "working", agent_session: { value: "other" } },
      { pane_id: "w1:p2", agent: "claude", agent_status: "idle", agent_session: { value: "sess-1" } },
      { pane_id: "w1:p3", agent: "claude", agent_status: "done", agent_session: { value: "sess-done" } },
      { pane_id: "w1:p4", agent: "claude", agent_status: "weird", agent_session: { value: "sess-odd" } },
      { pane_id: "w1:p5", agent: "claude", agent_status: "blocked", agent_session: { value: "sess-blocked" } },
      { pane_id: "w1:p6", agent: "codex", agent_status: "idle", agent_session: { value: "sess-codex" } },
      { pane_id: "w1:p7", agent_status: "idle", agent_session: { value: "sess-shell" } },
    ],
  },
});

function fake(failKeys = false): { bin: string; argv: () => string[][] } {
  const bin = join(dir, "herdr");
  const log = join(dir, "argv.log");
  writeFileSync(log, "");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nif [ "$2" = list ]; then cat <<'EOF'\n${LIST}\nEOF\nfi\n${failKeys ? 'if [ "$2" = send-keys ]; then exit 1; fi\n' : ""}`);
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\0").filter((x, i, a) => i < a.length - 1 || x !== "")),
  };
}

test("find picks the claude pane whose agent_session is the session and reads its status from the same snapshot", async () => {
  const f = fake();
  const t = new HerdrTerminal(f.bin);
  const found = await t.find("sess-1");
  assert.deepEqual(found, { ref: { kind: "herdr", pane_id: "w1:p2" }, status: "idle" });
  assert.equal(terminalLabel(found!.ref), "herdr:w1:p2");
  assert.equal(await t.find("nobody"), undefined);
  assert.deepEqual(f.argv().slice(0, 1), [["pane", "list"]]);
  assert.equal(f.argv().length, 2, "one `pane list` per find, no second spawn for the status");
});

test("done counts as idle; blocked stays blocked; an unknown word is unknown", async () => {
  const t = new HerdrTerminal(fake().bin);
  assert.equal((await t.find("sess-done"))?.status, "idle");
  assert.equal((await t.find("sess-blocked"))?.status, "blocked");
  assert.equal((await t.find("sess-odd"))?.status, "unknown");
  assert.equal(await t.status({ kind: "herdr", pane_id: "w1:p3" }), "idle");
  assert.equal(await t.status({ kind: "herdr", pane_id: "w1:nope" }), "unknown");
});

test("a pane that is not a claude agent is never a terminal (a shell would run the text)", async () => {
  const t = new HerdrTerminal(fake().bin);
  assert.equal(await t.find("sess-codex"), undefined);
  assert.equal(await t.find("sess-shell"), undefined);
});

test("type = send-text with one literal argument, then send-keys Enter (two spawns)", async () => {
  const f = fake();
  const t = new HerdrTerminal(f.bin);
  await t.type({ kind: "herdr", pane_id: "w1:p2" }, replyLine("a\nb  $(x) 'q'"));
  assert.deepEqual(f.argv(), [
    ["pane", "send-text", "w1:p2", "[ukagai] Reply to your progress recap: a b $(x) 'q'"],
    ["pane", "send-keys", "w1:p2", "Enter"],
  ]);
});

test("Enter failing after send-text is reported as textSent", async () => {
  const t = new HerdrTerminal(fake(true).bin);
  await assert.rejects(t.type({ kind: "herdr", pane_id: "w1:p2" }, "x"), (e: unknown) => e instanceof TerminalTypeError && e.textSent === true);
});

test("control characters are stripped from the typed line", () => {
  assert.equal(replyLine("a\x1b[31mb\x03c\x7fd"), "[ukagai] Reply to your progress recap: a [31mb c d");
});

test("replyLine is one line and capped at 4000 characters", () => {
  assert.equal(replyLine("x\r\ny\n\nz"), "[ukagai] Reply to your progress recap: x y z");
  assert.equal(replyLine("y".repeat(9000)).length, 4000);
});

test("a missing herdr binary means no terminal (never throws)", async () => {
  const errors: string[] = [];
  const t = new HerdrTerminal(join(dir, "does-not-exist"), (m) => errors.push(m));
  assert.equal(await t.find("sess-1"), undefined);
  assert.equal(errors.length, 1, "the failure is reported to the logger, not thrown");
  assert.equal(await t.status({ kind: "herdr", pane_id: "w1:p1" }), "unknown");
});
