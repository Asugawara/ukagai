// Everything an explanation the hook accepts says must reach the TUI: every pass-* fixture is rendered and its atoms
// (test/support/explain-atoms.ts) are looked for on the screen. Only ALLOWED_DROPS may be missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { renderMermaid } from "../../src/tui/mermaid.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { passCases, type PassCase } from "../support/explain-atoms.js";
import { decision, withExplanation } from "./helpers.js";

const NOW = Date.parse("2026-10-02T00:00:30.000Z");

function decisionOf(c: PassCase) {
  const options = c.labels.map((label, i) => ({ label: i === 0 && c.kind === "decision" ? `${label} (Recommended)` : label, description: `About ${label}`, preview: `KEEPPREVIEW${i}` }));
  return decision({
    request: { questions: [{ question: c.question, header: "Check", multiSelect: false, options }] },
    ...withExplanation(c.markdown, c.kind === "decision" ? {} : { type: c.kind }),
  });
}

/** The screen as plain text: no ANSI, no whitespace, no box edges (a box wraps the text it holds) */
const flat = (s: string): string => stripAnsi(s).replace(/[\s│▏]/gu, "");

for (const c of passCases()) {
  test(`TUI keeps every atom of ${c.file}`, () => {
    const d = decisionOf(c);
    if (c.kind === "decision") assert.equal(buildModel(d).question?.v2, true, "the fixture must take the card path, where content can be lost");
    const app = new App();
    app.upsert(d, NOW);
    const frame = renderFrame(app.view(NOW), { cols: 100, rows: 1500 }); // under 120 columns: one column, no mixing of left and right
    assert.equal(frame.scrollMax, 0, "the whole screen fits the frame");
    const screen = frame.text.split("\n").map(stripAnsi);
    const text = flat(frame.text);
    const missing: string[] = [];
    // The option's preview: under the card the cursor starts on (the first one of every fixture), not under the others
    if (!text.includes("KEEPPREVIEW0")) missing.push("preview of the cursor card");
    if (text.includes("KEEPPREVIEW1")) missing.push("preview of a card without the cursor must stay hidden");
    for (const w of c.atoms.sentinels) if (!text.includes(w)) missing.push(`sentinel ${w}`);
    for (const alt of c.atoms.images) if (!text.includes(flat(`[image] ${alt}`))) missing.push(`image ${alt}`);
    for (const k of c.atoms.codeKeys) if (!text.includes(flat(k))) missing.push(`code ${k}`);
    // A Mermaid block is drawn as boxes: every line of its drawing is on the screen, in order
    for (const src of c.atoms.mermaid) {
      const r = renderMermaid(src);
      if (!r.ok) continue;
      let at = 0;
      for (const l of r.lines.map((x) => x.trim()).filter(Boolean)) {
        const i = screen.findIndex((s, n) => n >= at && s.includes(l));
        if (i < 0) { missing.push(`diagram line ${l}`); break; }
        at = i;
      }
    }
    assert.deepEqual(missing, [], `${c.file}: not on the screen`);
  });
}
