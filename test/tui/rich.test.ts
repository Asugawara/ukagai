import { test } from "node:test";
import assert from "node:assert/strict";
import { SECTION, parseBullets, parseFootnotes, parseTerms } from "../../src/hook/explain.js";
import { App } from "../../src/tui/app.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import type { Key } from "../../src/tui/keys.js";
import { buildModel, splitHeadline } from "../../src/tui/model.js";
import { noneAnswer } from "../../src/tui/none.js";
import { renderFrame, type Frame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { Q, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
let now = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (now += 10)));
const SIZE = { cols: 160, rows: 60 };
const draw = (app: App, lang: "en" | "ja" = "en"): { f: Frame; raw: string; text: string } => {
  app.lang = lang;
  const f = renderFrame(app.view(now), SIZE);
  app.syncFrame(f, now);
  return { f, raw: f.text, text: stripAnsi(f.text) };
};

const RICH = (rev = "costly", scope = "repo") => `---
ukagai: 1
question: ${Q}
title: Whether the GUI update channel uses SSE or WebSocket
reversibility: ${rev}
scope: ${scope}
recommended: SSE
---

## Why this decision is needed now

The **delivery mechanism** has to be chosen before \`/api/stream\` exists.[^1]

## Options

| Option | What happens if chosen | Risks and how to undo | Effort |
|---|---|---|---|
| SSE | One-way delivery from the server. | If you need two-way, revert and rewrite it. | 1 day |
| WebSocket | Two-way is possible. | Adds a dependency. Cannot be undone. | 3 days |

## Recommendation

Use SSE because the GUI only listens. The server stays small. If you need two-way messages, choose WebSocket.

## What only you know

- Whether a mobile client is planned
- Who owns the proxy config

## Assumptions

- Only the GUI consumes events
- Proxies allow long-lived HTTP

## Counterargument

WebSocket would avoid a second migration if two-way ever arrives.

## Affected

- src/server/stream.ts
- GUI
- proxy
- hook
- docs
- CI
- release notes
- installer

## Terms

- **long-poll** — the client re-asks the server after each reply
- SSE: server-sent events

## What I checked

- \`src/server/app.ts:42\` has no WebSocket dependency.[^2]

[^1]: docs/spec/api.md section 3
[^2]: grep -rn websocket src (no hits)

## Related diff

\`\`\`diff
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-old
+new
\`\`\`
`;

const rich = (md = RICH()) => decision(withExplanation(md));
const appOf = (md = RICH()): App => {
  const app = new App();
  app.upsert(rich(md), now);
  return app;
};
const release = (app: App) => app.tick((now += 10_000));

// ---- parsing (explain.ts additions) ----

test("parseTerms accepts bold + dash, bold + colon, and plain colon forms", () => {
  const body = "## Terms\n- **a** — one\n- **b**: two\n- c: three\n- not a term";
  assert.deepEqual(parseTerms(body), [
    { term: "a", definition: "one" },
    { term: "b", definition: "two" },
    { term: "c", definition: "three" },
  ]);
});

test("parseBullets, parseFootnotes", () => {
  assert.deepEqual(parseBullets("## Assumptions\n- a\n  more\n* b\n1. c\n\nplain", SECTION.assumptions), ["a more", "b", "c"]);
  assert.deepEqual(parseFootnotes("x[^1] y[^2] z[^1]\n\n[^1]: one\n[^3]: unused\n```\n[^9]\n```"), {
    defs: [{ id: "1", text: "one" }, { id: "3", text: "unused" }],
    refs: ["1", "2"],
  });
});

// ---- model ----

test("model: headline, You decide, assumptions, against, affected, terms, footnotes; the file sections leave the background", () => {
  const m = buildModel(rich());
  assert.equal(m.headline, "Use SSE because the GUI only listens.");
  assert.ok(m.recRest?.startsWith("The server stays small."));
  assert.deepEqual(m.unknowns, ["Whether a mobile client is planned", "Who owns the proxy config"]);
  assert.deepEqual(m.assumptions, ["Only the GUI consumes events", "Proxies allow long-lived HTTP"]);
  assert.match(m.against ?? "", /^WebSocket would avoid/);
  assert.equal(m.affects.length, 8);
  assert.deepEqual(m.terms.map((x) => x.term), ["long-poll", "SSE"]);
  assert.deepEqual(m.footnotes, ["1", "2"]);
  const bg = m.background ?? "";
  for (const gone of ["What only you know", "Assumptions", "Counterargument", "Affected"]) assert.ok(!bg.includes(gone), gone);
  assert.ok(bg.includes("Terms") && bg.includes("What I checked"), "Terms and What I checked stay in the background column");
});

test("model: extra columns become named card lines, and a risk cell that says 'cannot be undone' marks the card heavy", () => {
  const m = buildModel(rich());
  const [sse, ws] = m.question!.cards;
  assert.deepEqual(sse!.lines.filter((l) => l.name).map((l) => [l.name, l.text]), [["Effort", "1 day"]]);
  assert.equal(sse!.heavy, false);
  assert.equal(ws!.heavy, true);
});

test("splitHeadline: first sentence, Japanese full stop, no sentence end", () => {
  assert.deepEqual(splitHeadline("A is good. B follows."), { headline: "A is good.", rest: "B follows." });
  assert.deepEqual(splitHeadline("SSE にします。理由は軽いからです。"), { headline: "SSE にします。", rest: "理由は軽いからです。" });
  assert.deepEqual(splitHeadline("see file.ts now"), { headline: "see file.ts now", rest: "" });
});

// ---- render ----

test("render: headline, reversibility symbol, You decide, Assumptions with ☐, Against, Affected (+N), extra column", () => {
  const { text, raw } = draw(appOf());
  assert.ok(/\x1b\[1mUse .*SSE.* because the GUI only listens\./.test(raw), "headline is bold");
  assert.ok(text.includes("◐ Costly to undo"));
  // The decision column is narrow, so the band wraps: compare with the wrapping removed
  const flat = text.split("\n").map((l) => l.split(" │ ").at(-1)!.trim()).join(" ");
  assert.ok(flat.includes("You decide: Whether a mobile client is planned · Who owns the proxy config"));
  assert.ok(text.includes("☐ Only the GUI consumes events") && text.includes("☐ Proxies allow long-lived HTTP"));
  assert.ok(text.includes("Against this:") && text.includes("▏ WebSocket would avoid"));
  assert.ok(flat.includes("Affects: src/server/stream.ts · GUI · proxy · hook · docs · CI +2"));
  assert.ok(text.includes("Effort: 1 day"));
  const lines = text.split("\n");
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  assert.ok(at("Use SSE because") < at("You decide") && at("You decide") < at("Assumptions") && at("Assumptions") < at("Against this") && at("Against this") < at("▸ ● SSE"));
});

test("render: the other two reversibility symbols", () => {
  assert.ok(draw(appOf(RICH("reversible", "file"))).text.includes("↺ Reversible"));
  assert.ok(draw(appOf(RICH("irreversible"))).text.includes("■ Irreversible"));
});

test("render: terms are underlined in the text but not in the Terms section; option labels have their own colors", () => {
  const { raw } = draw(appOf());
  assert.ok(raw.includes("\x1b[4m") && /\x1b\[36m\x1b\[4mSSE\x1b\[24m\x1b\[39m/.test(raw), "term SSE: colored as option 0 and underlined as a term, in the headline");
  assert.ok(!raw.includes("\x1b[4mlong-poll\x1b[24m"), "the Terms section itself is plain");
  assert.ok(raw.includes("\x1b[36mSSE"), "option 0 is cyan");
  assert.ok(raw.includes("\x1b[35mWebSocket"), "option 1 is magenta");
});

test("render: risk words are red (cannot be undone) or green (undo) underlined; diff has file headings, + green, - red", () => {
  const { raw } = draw(appOf());
  assert.ok(raw.includes("\x1b[4;31mCannot be undone\x1b[24;39m"));
  assert.ok(raw.includes("\x1b[4;32mrevert\x1b[24;39m"));
  assert.ok(raw.includes("\x1b[1m--- a/x.ts") && raw.includes("\x1b[1m+++ b/x.ts"));
  assert.ok(raw.includes("\x1b[32m+new") && raw.includes("\x1b[31m-old"));
});

test("render: footnote refs show as [1]; e jumps the background to the definitions, cycling", () => {
  const app = appOf();
  const { f, text } = draw(app);
  assert.ok(text.includes("choose[1]") || /chosen before .*\[1\]/.test(text) || text.includes("[1]"));
  assert.ok(!text.includes("[^1]"));
  assert.equal(f.footRows.length, 2);
  // Small window so the background scrolls
  const small = { cols: 160, rows: 16 };
  const f2 = renderFrame(app.view(now), small);
  app.syncFrame(f2, now);
  assert.equal(f2.footRows.length, 2);
  press(app, ch("e"));
  assert.equal(app.scroll, Math.min(f2.scrollMax, f2.footRows[0]!));
  press(app, ch("e"));
  assert.equal(app.scroll, Math.min(f2.scrollMax, f2.footRows[1]!));
  press(app, ch("e"));
  assert.equal(app.scroll, Math.min(f2.scrollMax, f2.footRows[0]!), "cycles");
});

test("render in ja: new strings are Japanese", () => {
  const { text } = draw(appOf(), "ja");
  assert.ok(text.includes("あなたが決めること:") && text.includes("前提") && text.includes("これへの反論:") && text.includes("どれでもない…"));
  assert.ok(text.includes("◐ 戻すのにコストがかかる"));
});

// ---- weight: Enter twice ----

const heavyApp = (rev = "reversible", scope = "file"): App => {
  const app = appOf(RICH(rev, scope));
  press(app, ch("j")); // WebSocket: "cannot be undone"
  return app;
};

test("heavy option: one Enter only asks; the second Enter within 3s sends", () => {
  const app = heavyApp();
  assert.deepEqual(press(app, enter), []);
  assert.equal(app.view(now).notice, "Press Enter again to confirm (3s)");
  assert.deepEqual(draw(app).text.split("\n").at(-1)?.trim().startsWith("Press Enter again"), true);
  const eff = press(app, enter);
  assert.equal(eff.length, 1);
  assert.deepEqual((eff[0] as { body: unknown }).body, { answers: { [Q]: "WebSocket" } });
});

test("heavy option: the second Enter after 3s, or after any other key, only asks again", () => {
  let app = heavyApp();
  press(app, enter);
  assert.deepEqual(app.handle(enter, now + 3500), []);
  assert.ok(app.view(now + 3500).notice);
  app = heavyApp();
  press(app, enter, ch("k"), ch("j"));
  assert.equal(app.view(now).notice, null);
  assert.deepEqual(press(app, enter), []);
});

test("a light option sends with a single Enter; an irreversible decision makes every option heavy", () => {
  const light = appOf(RICH("reversible", "file"));
  assert.equal(press(light, enter).length, 1);
  const irr = appOf(RICH("irreversible", "repo"));
  assert.deepEqual(press(irr, enter), []);
  assert.equal(press(irr, enter).length, 0, "irreversible waits out its 5 s undo window after the second Enter");
  assert.equal(release(irr).length, 1);
});

const PLAN = (rev?: string) =>
  decision({
    kind: "approve_plan",
    request: { plan: "# P\n\n## Scope and reversibility\n\nx", planFilePath: "/p" },
    ...(rev ? withExplanation("# P\n\n## Scope and reversibility\n\nx", { reversibility: rev, scope: "repo" }) : {}),
  } as never);

test("plan: irreversible approval (y, a, Enter on a button) needs a second press; reject does not", () => {
  const app = new App();
  app.upsert(PLAN("irreversible"), now);
  assert.deepEqual(press(app, ch("y")), []);
  assert.ok(app.view(now).notice);
  assert.deepEqual(press(app, enter), [], "Enter confirms y (the cursor moved to Approve) and starts the 5 s window");
  assert.ok(app.graceActive());
  assert.equal(release(app).length, 1);
  const auto = new App();
  auto.upsert(PLAN("irreversible"), now);
  assert.deepEqual(press(auto, ch("a")), []);
  press(auto, ch("a"));
  assert.deepEqual(auto.tick((now += 10_000)).map((e) => (e as { body: unknown }).body), [{ approve: true, set_mode_auto: true }]);
});

// ---- grace ----

test("grace: costly waits 3s, nothing is sent before, then the answer goes out; the footer counts down", () => {
  const app = appOf(RICH("costly", "repo"));
  const t0 = now + 10;
  assert.deepEqual(app.handle(enter, t0), []);
  assert.equal(app.view(t0).notice, "Sent in 3… Undo (u)");
  assert.equal(app.view(t0 + 1500).notice, "Sent in 2… Undo (u)");
  assert.deepEqual(app.tick(t0 + 2999), []);
  const eff = app.tick(t0 + 3000);
  assert.equal(eff.length, 1);
  assert.equal(app.view(t0 + 3000).notice, null);
});

test("grace: reversible 2s, irreversible 5s", () => {
  const rev = appOf(RICH("reversible", "repo"));
  const t0 = now + 10;
  rev.handle(enter, t0);
  assert.deepEqual(rev.tick(t0 + 1999), []);
  assert.equal(rev.tick(t0 + 2000).length, 1);
  const irr = appOf(RICH("irreversible", "repo"));
  irr.handle(enter, t0);
  irr.handle(enter, t0 + 10);
  assert.deepEqual(irr.tick(t0 + 5009), []);
  assert.equal(irr.tick(t0 + 5010).length, 1);
});

test("grace: u or Esc cancels, nothing is ever sent, and the screen is back", () => {
  for (const k of [ch("u"), esc]) {
    const app = appOf(RICH("costly", "repo"));
    press(app, enter);
    assert.ok(app.graceActive());
    assert.deepEqual(press(app, k), []);
    assert.equal(app.graceActive(), false);
    assert.ok(app.view(now).toast?.includes("Canceled"));
    assert.deepEqual(release(app), []);
    assert.equal(app.shownId, "d1");
    assert.equal(press(app, enter).length, 0, "can be answered again (new window)");
    assert.equal(release(app).length, 1);
  }
});

test("grace: other keys do nothing during the window; reversible + file is sent at once", () => {
  const app = appOf(RICH("costly", "repo"));
  press(app, enter);
  press(app, ch("j"), ch("n"), enter);
  assert.equal(app.mode, "normal");
  assert.equal(release(app).length, 1);
  assert.equal(press(appOf(RICH("reversible", "file")), enter).length, 1);
});

// ---- None of these ----

const bodyOf = (e: unknown) => (e as { body: { answers: Record<string, string> } }).body.answers[Q];

test("None of these: n opens the picker, j moves, Enter sends 'None of these — <type>'", () => {
  const app = appOf(RICH("reversible", "file"));
  press(app, ch("n"));
  assert.equal(app.mode, "none");
  const { text } = draw(app);
  for (const s of ["Missing option", "Wrong premise", "Need more evidence", "Ask me later"]) assert.ok(text.includes(s), s);
  const eff = press(app, ch("j"), ch("j"), enter);
  assert.equal(bodyOf(eff[0]), "None of these — Need more evidence");
});

test("None of these: i adds a note ('<type>: <text>'); Esc in the note returns to the picker, Esc again closes it", () => {
  const app = appOf(RICH("reversible", "file"));
  press(app, ch("n"), ch("i"), ch("x"), ch("y"));
  assert.ok(draw(app).text.includes("Note: xy▏"));
  press(app, enter);
  assert.equal(app.mode, "none");
  press(app, ch("i"), esc);
  assert.equal(app.mode, "none");
  assert.equal(bodyOf(press(app, enter)[0]), "None of these — Missing option: xy");
  const closed = appOf(RICH("reversible", "file"));
  press(closed, ch("n"), esc);
  assert.equal(closed.mode, "normal");
  assert.deepEqual(press(closed, esc), []);
});

test("None of these: it is also reachable with the cursor (Enter on the row) and sits before free text", () => {
  const app = appOf(RICH("reversible", "file"));
  press(app, ch("j"), ch("j"));
  assert.equal(app.view(now).cursor, 2);
  press(app, enter);
  assert.equal(app.mode, "none");
  press(app, esc, ch("j"));
  assert.equal(app.view(now).cursor, 3, "free text comes after None of these");
  assert.equal(noneAnswer(3, "  later  "), "None of these — Ask me later: later");
});

test("None of these: n on a plan is still reject", () => {
  const app = new App();
  app.upsert(PLAN(), now);
  press(app, ch("n"));
  assert.equal(app.view(now).input?.kind, "reason");
});

// ---- i18n ----

test("the new messages exist in en and ja with the same placeholders", () => {
  for (const k of ["reversible", "you_decide", "assumptions_title", "against_title", "none_of_these", "confirm_again", "sending_in", "send_canceled", "hint_none", "hint_evidence"] as const) {
    assert.ok(MESSAGES.en[k] && MESSAGES.ja[k], k);
  }
  assert.equal(MESSAGES.en.confirm_again, "Press Enter again to confirm (3s)");
  assert.equal(MESSAGES.ja.confirm_again, "もう一度 Enter で確定(3 秒)");
  assert.ok(MESSAGES.en.sending_in.includes("{n}") && MESSAGES.ja.sending_in.includes("{n}"));
});

// ---- Q5 fixes ----

test("render: 'cannot be restored' is red as a whole; 'restored' is not also green (N0 vocabulary)", () => {
  const { raw } = draw(appOf(RICH().replace("Cannot be undone", "The history cannot be restored")));
  assert.ok(raw.includes("\x1b[4;31mcannot be restored\x1b[24;39m"), "bad phrase is red");
  assert.ok(!raw.includes("\x1b[4;32mrestored"), "restored is not green");
  const can = draw(appOf(RICH().replace("Cannot be undone", "It can't be rolled back")));
  assert.ok(can.raw.includes("\x1b[4;31mcan't be rolled back\x1b[24;39m"));
});

test("render: Affected items lose their inline-code backticks", () => {
  const { text } = draw(appOf(RICH().replace("- src/server/stream.ts", "- `src/server/stream.ts`")));
  assert.ok(text.includes("src/server/stream.ts"));
  assert.ok(!text.includes("`src/server/stream.ts`"));
});
