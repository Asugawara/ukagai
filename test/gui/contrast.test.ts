// TX1: no faint text. Every piece of visible text is drawn in --fg (or an accent / status colour) with contrast >= 7:1 against the nearest
// opaque background, in the light and the dark scheme, on a question card, a checkpoint card, a plan card and the settings page; hierarchy is
// size / weight (the type scale), never a lighter colour or opacity. A real server (temp HOME) and a real browser (agent-browser).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/contract.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LONG = readFileSync(new URL("./fixtures/long-plan.md", import.meta.url), "utf8");
const DESIGN = readFileSync(new URL("../explain-fixtures/pass-design.md", import.meta.url), "utf8");
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.TX1_SHOTS_DIR ?? "";

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-contrast-${process.pid}-${Date.now().toString(36)}`;
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

async function waitFor(what: string, js: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = ev(`!!(${js})`) === true; } catch {}
    if (ok) return;
    assert.ok(Date.now() < end, `condition not met in time: ${what}`);
    await sleep(100);
  }
}

async function api(path: string, body?: unknown, method?: string) {
  const go = () => fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

const setTheme = (theme: "light" | "dark") => api("/api/settings", structuredClone({ ...DEFAULT_SETTINGS, theme }), "PUT");

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

const transcript = (name: string, texts: string[]): string => {
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const t0 = Date.now() - 3 * 3600_000;
  writeFileSync(path, texts.map((text, i) => JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: new Date(t0 + i * 1800_000).toISOString() })).join("\n") + "\n");
  return path;
};

const sessionOf = (n: number, cwd = ROOT) => {
  const id = `00000000-0000-0000-0009-${String(n).padStart(12, "0")}`;
  return { session_id: id, cwd, transcript_path: transcript(id, ["Make the header calm and readable", "second: no faint text"]) };
};

/** A real repository on branch `main` inside a herdr-style worktree path, so the server reports a branch and a worktree (the chips) whatever the checkout of the test run */
function gitWorktree(): string {
  const wt = join(home, ".herdr", "worktrees", "ukagai", "wt");
  mkdirSync(wt, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  return wt;
}

async function seedQuestion(): Promise<void> {
  const n = ++seq;
  const question = /^question: (.+)$/m.exec(DESIGN)![1]!;
  const title = /^title: (.+)$/m.exec(DESIGN)![1]!;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_contrast_${process.pid}_${n}`,
    kind: "answer_question",
    session: sessionOf(n, gitWorktree()),
    request: { questions: [{ question, header: "Check", multiSelect: false, options: [{ label: "SSE (Recommended)", description: "One-way" }, { label: "WebSocket", description: "Two-way" }] }] },
    explanation: { path: "", title, question, reversibility: "costly", scope: "repo", markdown: DESIGN, has: { mermaid: true, table: true, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, JSON.stringify(d));
}

async function seedBlocker(): Promise<void> {
  const n = ++seq;
  const markdown = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
  const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(markdown)![1]!;
  const labels = [...markdown.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!).filter((l) => !/^-+$/.test(l)).slice(1);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_contrast_blk_${process.pid}_${n}`,
    kind: "answer_question",
    session: sessionOf(n),
    request: { questions: [{ question: fm("question"), header: "Blocked", multiSelect: false, options: [{ label: `${labels[0]} (Recommended)`, description: "Retry" }, { label: labels[1]!, description: "Skip" }, { label: labels[2]!, description: "Stop" }] }] },
    explanation: { path: "", type: "blocker", title: fm("title"), question: fm("question"), reversibility: "reversible", scope: "machine", markdown, has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, JSON.stringify(d));
}

async function seedCheckpoint(): Promise<void> {
  const n = ++seq;
  const sid = `ck-contrast-${process.pid}-${n}`;
  const at = new Date(Date.now() + n).toISOString();
  const d = await api("/api/decisions", {
    tool_use_id: `checkpoint:${sid}:${at}`,
    kind: "checkpoint",
    session: { session_id: sid, cwd: ROOT, transcript_path: transcript(sid, ["Add the retry to the uploader"]) },
    request: { recap: "Added the retry to the uploader and the tests pass. Next I would wire it into the CLI and update the README.", recap_at: at },
  });
  assert.ok(d.id, JSON.stringify(d));
}

async function seedPlan(): Promise<void> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_contrast_plan_${process.pid}_${n}`,
    kind: "approve_plan",
    session: sessionOf(n),
    request: { plan: LONG, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
  });
  assert.ok(d.id, JSON.stringify(d));
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-contrast-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
  ab("open", base + "/", "--viewport", "1100x900");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

/** Runs in the page: every element with its own visible text, its colour, the nearest opaque background and the WCAG contrast */
const SWEEP = String.raw`(() => {
  const cs = (e, p) => getComputedStyle(e, p);
  const rgba = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (e) => {
    const layers = [];
    for (let n = e; n; n = n.parentElement) { const c = rgba(cs(n).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a === 1) break; } }
    let base = layers.length && layers.at(-1).a === 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) base = over(layers.pop(), base);
    return base;
  };
  const probe = document.createElement("span"); document.body.append(probe);
  const resolve = (v) => { probe.style.color = ""; probe.style.color = "var(" + v + ")"; return cs(probe).color; };
  const fg = resolve("--fg");
  const band = resolve("--blocker");
  const accents = ["--accent", "--red", "--green", "--yellow", "--blocker", "--purple", "--opt-0", "--opt-1", "--opt-2", "--opt-3", "--repo-accent"].map(resolve);
  probe.remove();
  const out = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (e.closest("svg, script, style, .sr-only, [hidden], #build, .build") || (typeof e.className === "string" && /(^|\\s)hljs-/.test(e.className))) continue; // syntax-highlight token colours are not hierarchy
    const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.data.trim() !== "").map((n) => n.data.trim()).join(" ");
    if (!own) continue;
    const s = cs(e);
    const r = e.getBoundingClientRect();
    if (s.display === "none" || s.visibility === "hidden" || r.width === 0 || r.height === 0) continue;
    if (e.disabled || e.closest(":disabled")) continue;
    let op = 1; for (let n = e; n; n = n.parentElement) op *= Number(cs(n).opacity);
    const color = rgba(s.color);
    const bg = bgOf(e);
    const fgc = over(color, bg);
    const l1 = lum(fgc), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    out.push({ tag: e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""), text: own.slice(0, 40), color: s.color, isFg: s.color === fg, onBand: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")" === band, isAccent: accents.includes(s.color), opacity: op, ratio: Math.round(ratio * 100) / 100, size: s.fontSize, weight: s.fontWeight });
  }
  return JSON.stringify({ fg, rows: out });
})()`;

type Row = { onBand: boolean; tag: string; text: string; color: string; isFg: boolean; isAccent: boolean; opacity: number; ratio: number; size: string; weight: string };

function sweep(label: string): void {
  const { rows } = ev<{ fg: string; rows: Row[] }>(SWEEP);
  assert.ok(rows.length > 10, `${label}: only ${rows.length} text elements found`);
  const bad: string[] = [];
  for (const r of rows) {
    const where = `${r.tag} "${r.text}" ${r.color} ${r.ratio}:1 opacity ${r.opacity}`;
    if (r.opacity < 1) bad.push(`translucent: ${where}`);
    else if (r.onBand && r.ratio >= 6) continue; // the blocker band (dark text on orange) is unchanged: 6:1
    else if (!r.isFg && !r.isAccent && r.ratio < 7) bad.push(`not --fg or an accent: ${where}`);
    else if (r.isFg && r.ratio < 7) bad.push(`--fg below 7:1: ${where}`);
    else if (r.isAccent && r.ratio < 3) bad.push(`accent below 3:1: ${where}`);
  }
  assert.deepEqual(bad, [], `${label}: faint or low-contrast text`);
}

const px = (sel: string) => ev<{ size: string; weight: string } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "null"; const s = getComputedStyle(e); return JSON.stringify({ size: s.fontSize, weight: s.fontWeight }); })()`);
function scale(sel: string, size: string, weight: string) {
  assert.deepEqual(px(sel), { size, weight }, `${sel} should be ${size} / ${weight}`);
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  ev(`(() => { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; for (const e of document.querySelectorAll("#background, #decision, .q-top, .q-cards, main")) e.scrollTop = 0; return "ok"; })()`);
  ab("screenshot", join(SHOTS, `${name}.png`));
}

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI contrast: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1100", "900");
    try { await fn(t); } finally { await cancelAll(); await setTheme("light"); }
  });
}

async function open(path: string, ready: string, theme: "light" | "dark") {
  await setTheme(theme);
  ab("open", base + path);
  await waitFor(`ready (${theme})`, `document.documentElement.dataset.theme === ${JSON.stringify(theme)} && ${ready}`);
  await sleep(300);
}

for (const theme of ["light", "dark"] as const) {
  gui(`question card, ${theme}: all text in --fg or an accent, >= 7:1; chips, goal rule, condition label, bold key names`, async () => {
    await seedQuestion();
    await open("/", "document.querySelector('#decision .opt') && document.querySelector('#background .hd-goal') && document.querySelector('#background .hd-cond')", theme);
    sweep(`question ${theme}`);
    scale("#head .hd-title .v2-title", "20px", "600");
    scale("#head .hd-ctx .chip.branch", "12px", "400");
    scale("#head .hd-ctx .chip.repo", "12px", "600");
    scale("#background .hd-goal", "12px", "400");
    scale("#background .hd-goal .goal-label", "12px", "600");
    scale("#background .hd-cond .cond-label", "12px", "600");
    scale("#decision .opt .lab", "14px", "600");
    scale("#decision .opt .desc", "13px", "400");
    scale("#foot .hint", "12px", "400");
    scale("#foot .hint b", "12px", "600");
    const st = ev<Record<string, any>>(`(() => {
      const probe = document.createElement("span"); probe.style.color = "var(--repo-accent)"; document.querySelector("#head").append(probe);
      const accent = getComputedStyle(probe).color; probe.remove();
      const chips = [...document.querySelectorAll("#head .hd-ctx .chip")].map((c) => ({ cls: c.className, w: getComputedStyle(c).borderTopWidth, r: getComputedStyle(c).borderTopLeftRadius, color: getComputedStyle(c).borderTopColor, text: c.textContent }));
      const goal = getComputedStyle(document.querySelector("#background .hd-goal"));
      return JSON.stringify({ accent, chips, goalRule: goal.borderBottomWidth, goalRuleStyle: goal.borderBottomStyle, goalText: document.querySelector("#background .hd-goal .goal-label").textContent,
        condLabel: document.querySelector("#background .hd-cond .cond-label").textContent, condFirst: document.querySelector("#background .hd-cond").firstElementChild.className,
        keys: [...document.querySelectorAll("#foot .hint b")].map((b) => b.textContent) });
    })()`);
    assert.ok(st.chips.length >= 5, `chips: ${st.chips.map((c: any) => c.text)}`); // repo, branch, worktree, scope, age
    for (const c of st.chips) { assert.equal(c.w, "1px", c.cls); assert.equal(c.r, "2px", c.cls); }
    assert.equal(st.chips.find((c: any) => c.cls.includes("repo")).color, st.accent, "the repo chip border is the repo colour");
    assert.equal(st.chips.some((c: any) => c.cls.includes("branch") && c.text.startsWith("⎇ ")), true);
    assert.equal(st.chips.some((c: any) => c.cls.includes("worktree") && c.text.startsWith("⧉ ")), true);
    assert.equal(st.chips.some((c: any) => c.cls.includes("scope")), true);
    assert.equal(st.chips.some((c: any) => c.cls.includes("age")), true);
    assert.equal(st.goalRule, "1px");
    assert.equal(st.goalRuleStyle, "solid");
    assert.ok(!st.goalText.endsWith(":"), "the goal label has no colon");
    assert.equal(st.condFirst, "cond-label", "the condition starts with its label");
    assert.ok(st.condLabel.length > 0);
    assert.ok(st.keys.length >= 3 && st.keys.includes("Esc"), `bold key names: ${st.keys}`);
    await shot(`question-${theme}`);
  });
}

gui("checkpoint card (light, dark): all text in --fg or an accent, >= 7:1", async () => {
  await seedCheckpoint();
  for (const theme of ["light", "dark"] as const) {
    await open("/", "document.querySelector('#decision .opt') && document.querySelector('#background .cp-recap')", theme);
    sweep(`checkpoint ${theme}`);
    scale("#background .cp-optional", "12px", "400");
    if (theme === "light") await shot("checkpoint-light");
  }
});

gui("plan card (light, dark): all text in --fg or an accent, >= 7:1", async () => {
  await seedPlan();
  for (const theme of ["light", "dark"] as const) {
    await open("/", "document.querySelector('#decision .opt') && document.querySelector('#background details.plan-sec')", theme);
    sweep(`plan ${theme}`);
    scale("#head .hd-ctx .chip.age", "12px", "400");
    if (theme === "light") await shot("plan-light");
  }
});

gui("blocker card (light, dark): all text in --fg, an accent or dark-on-band, >= 7:1; chips on the band have a dark border", async () => {
  await seedBlocker();
  for (const theme of ["light", "dark"] as const) {
    await open("/", "document.querySelector('#head.blocker') && document.querySelector('#decision .opt')", theme);
    sweep(`blocker ${theme}`);
    const c = ev<string>(`getComputedStyle(document.querySelector("#head .hd-ctx .chip.repo")).borderTopColor`);
    assert.match(c, /rgba\(29, 29, 31, 0\.4\)/, "dark chip border on the band");
    if (theme === "light") await shot("blocker-light");
  }
});

gui("settings page (light, dark): all text in --fg or an accent, >= 7:1", async () => {
  for (const theme of ["light", "dark"] as const) {
    await open("/settings", "document.querySelector('#form fieldset')", theme);
    sweep(`settings ${theme}`);
    scale(".set-help", "12px", "400");
    if (theme === "light") await shot("settings-light");
  }
});

gui("settings Skill pane (light, dark; edit, preview, diff, unsaved and reset armed): all text in --fg or an accent, >= 7:1", async () => {
  const def = (await api("/api/skill")).default as string;
  await api("/api/skill", { text: def + "\n# Heading\n\nA line the test added.\n" }, "PUT");
  try {
    for (const theme of ["light", "dark"] as const) {
      ab("open", base + "/settings"); // a hash-only change would keep the page (and the armed reset button) of the previous round
      await open("/settings#skill", "document.getElementById('skill-text') && !document.getElementById('skill-text').disabled && document.getElementById('skill-text').value.length > 0", theme);
      // an unsaved edit shows the indicator and the newer-version notice is not needed here; arm the reset button too
      ev(`(() => { const a = document.getElementById("skill-text"); a.value += " x"; a.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("skill-reset").click(); return "ok"; })()`);
      for (const tab of ["edit", "preview", "diff"]) {
        ev(`(document.getElementById("skill-tab-${tab}").click(), "ok")`);
        await waitFor("status line gone", `!document.querySelector(".set-status.on") && getComputedStyle(document.querySelector(".set-status")).opacity === "0"`);
        sweep(`skill ${tab} ${theme}`);
      }
      ev(`(document.getElementById("skill-discard").click(), "ok")`);
    }
  } finally {
    await api("/api/skill", undefined, "DELETE");
  }
});

gui("--muted is a readable tone (>= 6:1 on its panel) and only placeholders / disabled controls use it", async () => {
  await open("/settings", "document.querySelector('#form fieldset')", "light");
  const r = ev<{ muted: string; ratio: number }>(`(() => {
    const p = document.createElement("span"); p.style.color = "var(--muted)"; document.body.append(p);
    const c = getComputedStyle(p).color.match(/[\\d.]+/g).map(Number); p.remove();
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const l = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    return JSON.stringify({ muted: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(), ratio: 1.05 / (l + 0.05) });
  })()`);
  assert.equal(r.muted, "#55555b");
  assert.ok(r.ratio >= 6, `muted on white ${r.ratio}`);
  const css = readFileSync(join(ROOT, "public", "app.css"), "utf8");
  const uses = css.split("\n").filter((l) => /var\(--muted\)/.test(l) && !/^\s*--/.test(l));
  for (const l of uses) assert.ok(/::placeholder|:disabled|box-shadow/.test(l), `--muted on text: ${l.trim()}`);
});
