// Cleanup guards: SSE parsing skips unhandled events without parsing, the safety poll skips plans while SSE is up,
// and a repaint does not render the open sections of a plan again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSse } from "../../src/tui/api.js";
import { App } from "../../src/tui/app.js";
import { refetch, type SyncApi } from "../../src/tui/sync.js";
import { renderFrame, richStats } from "../../src/tui/render.js";
import type { PlanContent } from "../../src/contract.js";

const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

test("parseSse: heartbeats are dropped without JSON.parse; session and plan events are validated", () => {
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => (parses++, real(...a))) as typeof JSON.parse;
  try {
    assert.equal(parseSse(": ping"), null);
    assert.equal(parseSse("event: session.created\ndata: {\"id\":\"s\"}"), null);
    assert.equal(parses, 0);
  } finally {
    JSON.parse = real;
  }
  // session.updated is read now (a checkpoint's idle note follows the session state); a payload that is not a SessionSummary is dropped
  assert.equal(parseSse("event: session.updated\ndata: {not json"), null);
  assert.equal(parseSse("event: session.updated\ndata: {\"id\":\"s\"}"), null);
  const sess = { session_id: "s", state: "idle", last_event_at: "2026-10-03T00:00:00.000Z", cwd: "/w" };
  assert.deepEqual(parseSse(`event: session.updated\ndata: ${JSON.stringify(sess)}`), { event: "session.updated", session: sess });
  const plan = { name: "a.md", title: "A", mtime: "2026-10-03T00:00:00.000Z", bytes: 1, sections: 0, lines: 1, read: true };
  assert.deepEqual(parseSse(`event: plan.updated\ndata: ${JSON.stringify(plan)}`), { event: "plan.updated", plan });
  assert.equal(parseSse(`event: plan.updated\ndata: ${JSON.stringify({ name: "a.md" })}`), null, "a payload that is not a PlanSummary");
  assert.deepEqual(parseSse('event: plan.removed\ndata: {"name":"a.md"}'), { event: "plan.removed", name: "a.md" });
  assert.equal(parseSse('event: plan.removed\ndata: {"name":1}'), null);
});

test("refetch: plans are fetched on connect, and the safety poll skips them while SSE is up", async () => {
  let plans = 0;
  const api: SyncApi = {
    listPending: async () => [],
    get: async () => {
      throw new Error("unused");
    },
    plans: async () => (plans++, []),
    stream: async () => {},
  };
  const app = new App();
  await refetch(api, app, () => NOW);
  assert.equal(plans, 1);
  await refetch(api, app, () => NOW, app.down); // SSE up
  assert.equal(plans, 1);
  app.setConnected(false, NOW);
  await refetch(api, app, () => NOW, app.down); // SSE down
  assert.equal(plans, 2);
});

test("a repaint of an open long plan renders nothing again; a new width or language does", async () => {
  const app = new App();
  const file: PlanContent = { name: "b.md", title: "Export retry", mtime: new Date(NOW - 3600_000).toISOString(), markdown: LONG, read: false } as PlanContent;
  app.fetchPlan = async () => file;
  app.planUpdated({ name: "b.md", title: file.title, mtime: file.mtime, bytes: LONG.length, sections: 9, lines: 200, read: false }, NOW);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.shownPlan, "b.md");
  const paint = (cols: number) => renderFrame(app.view(NOW), { cols, rows: 50 }).text;
  const first = paint(140);
  const after = richStats.renders;
  assert.ok(after > 0);
  assert.equal(paint(140), first, "the same string");
  assert.equal(richStats.renders, after, "no section was rendered again");
  paint(100);
  assert.ok(richStats.renders > after, "another width renders again");
});
