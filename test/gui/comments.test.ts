// Inline comments on text in the real GUI: select text in the left column (a Range + mouseup) -> popover -> Ctrl+Enter -> one highlight and one badge,
// the list in the right column, the stored response.comments and composed text, Approve needing a second press, Esc in the popover not moving a plan
// card on, re-anchoring across plan file updates (kept quote: found; removed quote: orphan), and the draft surviving a reload.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH (unless UKAGAI_REQUIRE_BROWSER=1).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { optInPlanAutoShow } from "../support/plans-auto.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRE_BROWSER = process.env["UKAGAI_REQUIRE_BROWSER"] === "1";
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.UKAGAI_SHOTS_DIR ?? join(tmpdir(), "ukagai-shots");
mkdirSync(SHOTS, { recursive: true });
const PLAN = "# Export retry\n\n## Context\n\nThe export job fails on a flaky upload.\n\n## Scope and reversibility\n\nReversibility: reversible\nScope: file\n\n## Steps\n\n- [ ] add retry\n";

let home = "";
let top = "";
let scratch = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-cmt-${process.pid}-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
function ab(...args: string[]): string {
  return execFileSync("agent-browser", args, { env: { ...process.env, AGENT_BROWSER_SESSION: session }, encoding: "utf8", timeout: 30000 }).trim();
}
function ev<T = any>(js: string): T {
  const out = ab("eval", js).split("\n").at(-1)!;
  let v: unknown = JSON.parse(out);
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch {}
  }
  return v as T;
}
async function waitFor(what: string, js: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = ev(`!!(${js})`) === true; } catch {}
    if (ok) return;
    assert.ok(Date.now() < end, `condition not met in time: ${what}`);
    await sleep(100);
  }
}
/** A key as a real KeyboardEvent; `target` is a CSS selector (default: the document) */
const key = (k: string, target = "", init = "") =>
  ev(`(${target ? `document.querySelector(${JSON.stringify(target)})` : "document"}).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true${init} })), "ok"`);
/** Put text in the instruction box the way typing does */
const typeInto = (text: string) => ev(`(() => { const t = document.querySelector("#instruct"); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);

async function api(path: string, body?: unknown, method?: string) {
  const go = () => fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go()); // a kept-alive socket may have been reset while the browser worked
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as any;
}
/** A solid-colour PNG (no dependency): signature, IHDR, one IDAT, IEND */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
async function seedPlan(sid?: string, transcriptPath?: string): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_pli_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: sid ?? `00000000-0000-0000-0002-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcriptPath ?? join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan: PLAN, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
  });
  assert.ok(d.id, JSON.stringify(d));
  return { id: d.id };
}
async function cancelAll() {
  for (const d of (await api("/api/decisions?status=pending")) as { id: string }[]) await api(`/api/decisions/${d.id}/cancel`, {});
}
async function reopen(ready: string) {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plin-"));
  top = mkdtempSync(join(tmpdir(), "claude-ukagai-cmt-"));
  scratch = join(top, "-proj", "sess-cmt", "scratchpad");
  mkdirSync(join(scratch, "ukagai"), { recursive: true });
  writeFileSync(join(scratch, "ukagai", "shot.png"), png(400, 300, [147, 197, 253]));
  dataDir = join(home, "data");
  optInPlanAutoShow(dataDir);
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_TERMINAL: "none" } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
  ab("open", base + "/", "--viewport", "1280x800");
  opened = true;
});
after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  for (const d of [home, top]) if (d) rmSync(d, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI comments: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1280", "800");
    try { await fn(t); } finally { await cancelAll(); }
  });
}


/** Select `needle` (inside one text node of the left column) with a Range and finish with a mouseup, the way a drag does */
const selectText = (needle: string) => ev<string>(`(() => { const root = document.getElementById("background"); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(${JSON.stringify(needle)}); if (i < 0) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${needle.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return "ok"; } return "none"; })()`);
const popOpen = () => ev<boolean>(`!!document.querySelector(".cmt-pop")`);
const highlights = () => ev<number>(`(CSS.highlights.get("ukagai-comment")?.size ?? 0)`);
const badges = () => ev<number>(`document.querySelectorAll("#background .cmt-badge").length`);
/** Select `needle`, write `note` in the popover and add it with Ctrl+Enter */
async function comment(needle: string, note: string) {
  assert.equal(selectText(needle), "ok", `${needle} is in the left column`);
  await waitFor("popover opens", `document.querySelector(".cmt-pop .cmt-pop-ta") && document.activeElement?.classList.contains("cmt-pop-ta")`);
  ev(`(() => { const t = document.querySelector(".cmt-pop-ta"); t.value = ${JSON.stringify(note)}; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  key("Enter", ".cmt-pop-ta", ", ctrlKey: true");
  await waitFor("popover closed", `!document.querySelector(".cmt-pop")`);
}
async function answered(id: string) {
  const end = Date.now() + 8000;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status !== "pending") return d;
    assert.ok(Date.now() < end, "not answered");
    await sleep(100);
  }
}

const count0 = (sel: string) => ev<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const active = () => ev<string>(`document.activeElement?.id ?? ""`);

gui("select text -> popover -> Ctrl+Enter gives one highlight and one badge; the right list shows it; Send stores response.comments and the composed text", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await comment("flaky upload", "retry with backoff, not a loop");
  await waitFor("badge and highlight", `document.querySelectorAll("#background .cmt-badge").length === 1`);
  assert.equal(badges(), 1);
  assert.equal(highlights(), 1);
  assert.equal(ev(`document.querySelectorAll("#decision .cmt-row").length`), 1);
  assert.match(ev<string>(`document.querySelector("#decision .cmt-row").textContent`), /flaky upload.*retry with backoff, not a loop/s);
  assert.match(ev<string>(`document.querySelector("#decision .instruct-card .lab").textContent`), /Send 1 comment/);
  assert.equal(ev(`document.querySelector("#decision .opt.cursor")?.dataset.card`), "instruct", "with comments the instruction card is the cursor");
  assert.equal(ev(`document.querySelector("#instruct-send").disabled`), false, "a comment alone can be sent");
  assert.match(ev<string>(`document.querySelector("#foot").textContent`), /m Comment/);
  ab("screenshot", join(SHOTS, "CMT-plan.png"));
  ev(`document.querySelector("#instruct-send").click(), "ok"`);
  const d = await answered(id);
  assert.equal(d.response.instruct, true);
  assert.equal(d.response.comments.length, 1);
  assert.equal(d.response.comments[0].quote, "flaky upload");
  assert.equal(d.response.comments[0].note, "retry with backoff, not a loop");
  assert.equal(d.response.comments[0].source.kind, "plan");
  assert.deepEqual(d.response.comments[0].section, ["Export retry", "Context"]);
  assert.match(d.response.text, /The human left 1 comment:/);
  assert.match(d.response.text, /retry with backoff, not a loop/);
  assert.equal(ev(`localStorage.getItem("ukagai.comments.${id}")`), null, "the stored draft is gone after the send");
});

gui("Approve with comments needs a second press and discards them", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await comment("export job", "rename this job");
  await waitFor("one comment", `document.querySelectorAll("#decision .cmt-row").length === 1`);
  key("y");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending", "the first press only asks");
  assert.match(ev<string>(`document.querySelector("#decision .approve-card .confirm-inline:not([hidden])")?.textContent ?? ""`), /1 comment will be discarded/);
  key("y");
  const d = await answered(id);
  assert.equal(d.response.approve, true);
  assert.equal(d.response.comments, undefined);
});

gui("Reject sends the comments with the reason", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await comment("add retry", "cap the attempts");
  await waitFor("one comment", `document.querySelectorAll("#decision .cmt-row").length === 1`);
  key("n");
  await waitFor("reason box", `document.querySelector("#reason")`);
  ev(`(() => { const r = document.querySelector("#reason"); r.value = "not yet"; r.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  ev(`document.querySelector("#decision .reject-box .btn").click(), "ok"`);
  const d = await answered(id);
  assert.equal(d.response.approve, false);
  assert.equal(d.response.comments.length, 1);
  assert.match(d.response.reason, /not yet/);
});

gui("a reload restores the draft comments; deleting one removes it from the highlight, the list and the storage", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await comment("flaky upload", "first");
  await comment("export job", "second");
  await waitFor("two comments", `document.querySelectorAll("#decision .cmt-row").length === 2`);
  assert.equal(highlights(), 2);
  await reopen("document.querySelectorAll('#decision .cmt-row').length === 2 && document.querySelectorAll('#background .cmt-badge').length === 2");
  assert.equal(highlights(), 2, "the highlights are back after the reload");
  assert.equal(ev(`JSON.parse(localStorage.getItem("ukagai.comments.${id}")).comments.length`), 2);
  ev(`document.querySelector("#decision .cmt-row .cmt-del").click(), "ok"`);
  await waitFor("one left", `document.querySelectorAll("#decision .cmt-row").length === 1`);
  await waitFor("one badge", `document.querySelectorAll("#background .cmt-badge").length === 1`);
  assert.equal(highlights(), 1);
  assert.equal(ev(`JSON.parse(localStorage.getItem("ukagai.comments.${id}")).comments.length`), 1);
  // a click on the row reopens the popover to edit; Delete in it removes the comment
  ev(`document.querySelector("#decision .cmt-row").click(), "ok"`);
  await waitFor("edit popover", `document.querySelector(".cmt-pop .cmt-pop-ta")?.value === "second"`);
  ev(`[...document.querySelectorAll(".cmt-pop button")].find(b => b.textContent === "Delete").click(), "ok"`);
  await waitFor("none left", `document.querySelectorAll("#decision .cmt-row").length === 0 && document.querySelectorAll("#background .cmt-badge").length === 0`);
  assert.equal(highlights(), 0);
  assert.equal(ev(`localStorage.getItem("ukagai.comments.${id}")`), null);
});

gui("plan file card: Esc in the popover only closes it; a plan update that keeps the quote re-anchors, one that removes it marks the comment orphan", async () => {
  const file = join(home, ".claude", "plans", "quick-fox.md");
  writeFileSync(file, PLAN);
  const tpath = join(home, ".claude", "projects", "p", "s-cmt.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"quick-fox"}\n');
  await api("/api/events", { session_id: "s-cmt", transcript_path: tpath, cwd: ROOT, hook_event_name: "Stop", received_at: new Date().toISOString() });
  await reopen("document.querySelector('#decision .done-reading')");
  const pick = () => ev<string>(`document.querySelector("#head .plan-file")?.textContent ?? ""`);
  for (let i = 0; i < 6 && pick() !== "quick-fox.md"; i++) { key("l"); await sleep(300); }
  assert.equal(pick(), "quick-fox.md");
  // Esc in the popover: closes it, never "Done reading" (which would move to the next item)
  assert.equal(selectText("flaky upload"), "ok");
  await waitFor("popover", `document.querySelector(".cmt-pop-ta")`);
  key("Escape", ".cmt-pop-ta");
  assert.equal(popOpen(), false);
  assert.equal(pick(), "quick-fox.md", "Esc did not advance the plan card");
  assert.equal(badges(), 0, "nothing was added");
  await comment("flaky upload", "use the idempotency key");
  await waitFor("badge", `document.querySelectorAll("#background .cmt-badge").length === 1`);
  // the quote stays: the text around it changes, the comment is found again
  writeFileSync(file, PLAN.replace("## Steps", "## Preface\n\nA new paragraph.\n\n## Steps"));
  await waitFor("updated plan shown", `document.getElementById("background").textContent.includes("A new paragraph.")`, 15000);
  await waitFor("re-anchored", `document.querySelectorAll("#background .cmt-badge").length === 1 && !document.querySelector("#decision .cmt-row.orphan")`);
  assert.equal(highlights(), 1);
  // the quote goes away: the comment is kept and marked
  writeFileSync(file, PLAN.replace("fails on a flaky upload", "fails sometimes"));
  await waitFor("orphan mark", `document.querySelector("#decision .cmt-row.orphan")`, 15000);
  assert.match(ev<string>(`document.querySelector("#decision .cmt-row.orphan").textContent`), /Not found in the current text/);
  assert.equal(badges(), 0);
  assert.equal(highlights(), 0);
  assert.equal(ev(`document.querySelectorAll("#decision .cmt-row").length`), 1, "still in the list");
  // put the quote back: the mark clears
  writeFileSync(file, PLAN);
  await waitFor("found again", `!document.querySelector("#decision .cmt-row.orphan") && document.querySelectorAll("#background .cmt-badge").length === 1`, 15000);
  // send to the plan endpoint with the comment only
  ev(`document.querySelector("#instruct-send").click(), "ok"`);
  await waitFor("sent toast", `document.body.textContent.includes("Sent to the agent")`);
  const ins = await api("/api/sessions/s-cmt/instruction");
  assert.match(ins.instruction.text, /The human left 1 comment:/);
  assert.match(ins.instruction.text, /use the idempotency key/);
  rmSync(file, { force: true });
});

gui("a drag on an image draws a region and makes a region comment with a marked copy; a plain click still opens the lightbox, which shows the region; Send carries it", async () => {
  const docPath = join(scratch, "ukagai", "ex.md");
  const markdown = "---\nukagai: 1\n---\n## Why this decision is needed now\n\nThe colour:\n\n![shot](shot.png)\n";
  writeFileSync(docPath, markdown);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_cmt_img_${process.pid}_${++seq}`,
    kind: "answer_question",
    session: { session_id: "00000000-0000-0000-0009-000000000003", cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl"), scratchpad_dir: scratch },
    request: { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "A", description: "A" }, { label: "B", description: "B" }] }] },
    explanation: { path: docPath, markdown, has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, JSON.stringify(d));
  void api(`/api/decisions/${d.id}/wait?timeout_ms=60000`).catch(() => {});
  await reopen("document.querySelector('#background figure.doc-img img')?.naturalWidth === 400");
  const imgBox = () => ev<{ x: number; y: number; w: number; h: number }>(`JSON.stringify((() => { const r = document.querySelector("#background figure.doc-img img").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())`);
  const b = imgBox();
  const at = (dx: number, dy: number) => [String(Math.round(b.x + dx)), String(Math.round(b.y + dy))];
  ab("mouse", "move", ...at(50, 40));
  ab("mouse", "down");
  ab("mouse", "move", ...at(100, 60));
  ab("mouse", "move", ...at(150, 90));
  ab("mouse", "up");
  await waitFor("region popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.equal(count0(".overlay"), 0, "the click after a drag did not open the lightbox");
  assert.match(ev<string>(`document.querySelector(".cmt-pop .cmt-pop-q").textContent`), /^Region \d+×\d+ at \d+,\d+$/);
  ev(`(() => { const t = document.querySelector(".cmt-pop-ta"); t.value = "a paler purple"; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  // the first upload fails: the error shows inside the popover, which stays open with the note
  ev(`(() => { window.__fetch = window.fetch; window.fetch = (u, i) => (String(u).includes("/api/marks") && !window.__failed ? (window.__failed = 1, Promise.resolve(new Response('{"error":"disk full"}', { status: 500 }))) : window.__fetch(u, i)); return "ok"; })()`);
  key("Enter", ".cmt-pop-ta", ", ctrlKey: true");
  await waitFor("error in the popover", `document.querySelector(".cmt-pop .cmt-pop-err") && !document.querySelector(".cmt-pop .cmt-pop-err").hidden`);
  assert.match(ev<string>(`document.querySelector(".cmt-pop .cmt-pop-err").textContent`), /disk full/);
  assert.equal(ev(`document.querySelector(".cmt-pop-ta").value`), "a paler purple");
  assert.equal(count0("#decision .cmt-row"), 0, "nothing was added");
  key("Enter", ".cmt-pop-ta", ", ctrlKey: true");
  await waitFor("popover closed after the upload", `!document.querySelector(".cmt-pop")`, 15000);
  await waitFor("region outline and badge", `document.querySelectorAll("#background .rg-box").length === 1 && document.querySelectorAll("#background .cmt-badge").length === 1 && document.querySelectorAll("#decision .cmt-row").length === 1`);
  const stored = ev<any>(`JSON.stringify(JSON.parse(localStorage.getItem("ukagai.comments.${d.id}")).comments[0])`);
  assert.equal(stored.kind, "region");
  assert.deepEqual(stored.source, { kind: "image", file: join(scratch, "ukagai", "shot.png") });
  assert.match(stored.mark, /^[0-9a-f]{16}$/);
  // the displayed pixels are scaled to the natural ones (the image is 400 wide on screen or less)
  const k = 400 / b.w;
  assert.ok(Math.abs(stored.rect.x - 50 * k) <= 2 && Math.abs(stored.rect.y - 40 * k) <= 2 && Math.abs(stored.rect.w - 100 * k) <= 3 && Math.abs(stored.rect.h - 50 * k) <= 3, JSON.stringify({ rect: stored.rect, k }));
  // a plain click opens the lightbox; the region is drawn there too; Esc closes it
  ab("mouse", "move", ...at(200, 150));
  ab("mouse", "down");
  ab("mouse", "up");
  await waitFor("lightbox", `document.querySelector(".overlay.lightbox .lightbox-img")`);
  await waitFor("region in the lightbox", `document.querySelectorAll(".overlay.lightbox .rg-box").length === 1`);
  assert.equal(String(ev(`document.querySelector(".overlay.lightbox .rg-box .cmt-n").textContent`)), "1");
  key("Escape");
  await waitFor("lightbox closed", `!document.querySelector(".overlay")`);
  await waitFor("outline is back inline", `document.querySelectorAll("#background .rg-box").length === 1`);
  ab("screenshot", join(SHOTS, "CMT-region.png"));
  // answer with an option: the comment goes with the answer, and the composed text points at the marked copy
  ev(`document.querySelector("#decision .opt").click(), "ok"`);
  const done = await answered(d.id);
  assert.equal(done.response.comments.length, 1);
  assert.equal(done.response.comments[0].kind, "region");
  assert.equal(done.response.comments[0].mark, stored.mark);
  const answer = JSON.stringify(done.response);
  const m = /marked copy: (\/[^\s"\\)]+\.png)/.exec(answer);
  assert.ok(m, `the text names the marked copy: ${answer}`);
  assert.equal(m![1], join(scratch, "ukagai", "marks", `${stored.mark}.png`));
  assert.ok(existsSync(m![1]), "the marked copy exists");
  assert.equal(readFileSync(m![1]).subarray(1, 4).toString(), "PNG");
  assert.match(answer, /region x=\d+ y=\d+ w=\d+ h=\d+/);
  assert.match(answer, /a paler purple/);
});

if (REQUIRE_BROWSER) {
  test("UKAGAI_REQUIRE_BROWSER=1: agent-browser is on PATH", () => {
    assert.ok(HAS_BROWSER, "agent-browser is not on PATH");
  });
}
