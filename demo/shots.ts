// GUI shots: the real public/ GUI, driven over CDP, one PNG per shot and a manifest.
// Importing this file starts nothing; render.ts calls takeShots().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "./lib/cdp.js";
import { checkPublicUrls, ensureCache, interceptCdnjs } from "./lib/hljs.js";
import type { Serve } from "./lib/serve.js";
import type { Lang } from "./seeds.js";

export class DemoError extends Error {}

export const SHOT_NAMES = [
  "empty", "q1", "q2", "q3", "inbox", "hero", "pick2", "pick1", "hero-answered",
  "compare", "compare-answered", "plan", "plan-src", "plan-approved", "zero",
] as const;

export const VIEWPORT = { w: 1280, h: 800 } as const;
export const DSF = 2;

// Hides the build line, the caret blink and the toast's hover state.
const CSS = "#build{display:none!important}*{caret-color:transparent!important}";

// A part names elements: a selector (first match), { sel, all } or { els } (a JS expression giving elements).
export type Part = string | { sel: string; all?: boolean } | { els: string };
// Anchors are the union of their parts. inScroll anchors are measured at scrollTop 0.
export interface Anchor {
  parts: Part[];
  inScroll?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  inScroll: boolean;
}

export interface ScrollSeries {
  el: string;
  ys: number[];
  files: string[];
  anchors: Record<string, Rect>;
}

export interface ManifestShot {
  file: string;
  title: string;
  favicon: string | null;
  scrollTop: number;
  anchors: Record<string, Rect>;
  toast?: string;
  scroll?: ScrollSeries;
}

export interface Manifest {
  lang: Lang;
  viewport: { w: number; h: number };
  dsf: number;
  repos: Record<string, string>;
  shots: Record<string, ManifestShot>;
}

const partsJs = (parts: Part[]) =>
  parts
    .map((p) => {
      if (typeof p === "string") return `[document.querySelector(${JSON.stringify(p)})]`;
      if ("els" in p) return `(${p.els})`;
      return p.all
        ? `[...document.querySelectorAll(${JSON.stringify(p.sel)})]`
        : `[document.querySelector(${JSON.stringify(p.sel)})]`;
    })
    .join(",");

const rectJs = (a: Anchor) => `(() => {
  const els = [${partsJs(a.parts)}].flat().filter(Boolean);
  if (!els.length) return null;
  const rs = els.map(e => e.getBoundingClientRect());
  const l = Math.min(...rs.map(r => r.left)), t = Math.min(...rs.map(r => r.top));
  const r = Math.max(...rs.map(r => r.right)), b = Math.max(...rs.map(r => r.bottom));
  return { x: l, y: t, w: r - l, h: b - t };
})()`;

const round = (v: number) => Math.round(v * 10) / 10;

const SEL = {
  empty: `document.querySelector("#empty")`,
  emptyVisible: `getComputedStyle(document.querySelector("#empty")).display !== "none"`,
  drawerOpen: `document.querySelector("#drawer.open")`,
  rows3: `document.querySelectorAll("#pending-list .row").length === 3`,
  framesReady: `document.querySelectorAll("iframe.doc-frame-view").length === 2 && [...document.querySelectorAll("iframe.doc-frame-view")].every(f => typeof f._natural === "number")`,
  steps: `[...document.querySelectorAll("#background details.plan-sec")].filter(d => /Steps|手順/.test(d.querySelector("summary")?.textContent ?? ""))`,
};

const heroTarget = `(() => { const b = document.querySelector("#background"); const r = document.querySelector("#background .rec");
  const want = r.getBoundingClientRect().top - b.getBoundingClientRect().top - 16 + b.scrollTop;
  return Math.min(Math.round(want), b.scrollHeight - b.clientHeight); })()`;

const stepsTarget = `(() => { const b = document.querySelector("#background");
  const d = ${SEL.steps}[0];
  const want = d.getBoundingClientRect().top - b.getBoundingClientRect().top - 16 + b.scrollTop;
  return Math.min(Math.round(want), b.scrollHeight - b.clientHeight); })()`;

const STEPS_ANCHOR: Anchor = {
  parts: [{ els: `${SEL.steps}.flatMap(d => [d.querySelector("summary"), ...d.querySelectorAll("pre.diff, .ver-old, code.hljs")])` }],
  inScroll: true,
};

export interface TakeShotsOptions {
  repoRoot: string;
  browser: Browser;
  serve: Serve;
  lang: Lang;
  outDir: string;
  cacheDir: string;
  frozenNow: number;
  log: (msg: string) => void;
}

export async function takeShots(o: TakeShotsOptions): Promise<Manifest> {
  checkPublicUrls(readFileSync(join(o.repoRoot, "public", "index.html"), "utf8"));
  await ensureCache(o.cacheDir);
  mkdirSync(o.outDir, { recursive: true });

  // Plan v1 is sent and answered with an instruction before the GUI opens, so v2 later shows the version bar.
  await o.serve.seedPlan(o.lang, 1);

  const page: Page = await o.browser.page({ width: VIEWPORT.w, height: VIEWPORT.h, dsf: DSF });
  await page.addInitScript(`Date.now = () => ${o.frozenNow};`);
  await interceptCdnjs(page, o.cacheDir);
  await page.goto(o.serve.base + "/");
  await page.waitFor(`${SEL.empty} && ${SEL.emptyVisible}`, "#empty");
  await page.ev("document.fonts.ready.then(() => true)");
  await page.addStyle(CSS);

  const manifest: Manifest = { lang: o.lang, viewport: { ...VIEWPORT }, dsf: DSF, repos: {}, shots: {} };

  const rectOf = async (name: string, k: string, a: Anchor): Promise<Rect> => {
    const r = await page.ev<{ x: number; y: number; w: number; h: number } | null>(rectJs(a));
    if (!r) throw new DemoError(`anchor ${k} of ${name} not found`);
    return { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), inScroll: !!a.inScroll };
  };

  const capture = async (name: string, anchors: Record<string, Anchor>): Promise<ManifestShot> => {
    const chip = await page.ev(`document.querySelector(".chip.branch, .chip.worktree") !== null`);
    if (chip) throw new DemoError(`shot ${name}: a branch or worktree chip is shown (the temp root must not be a git checkout)`);
    const file = `${name}.png`;
    writeFileSync(join(o.outDir, file), await page.png());
    const entry: ManifestShot = {
      file,
      title: await page.ev("document.title"),
      favicon: await page.ev(`document.querySelector("link#favicon")?.getAttribute("href") ?? null`),
      scrollTop: await page.ev(`document.querySelector("#background")?.scrollTop ?? 0`),
      anchors: {},
    };
    const toast = await page.ev<string | null>(`document.querySelector(".toast")?.textContent ?? null`);
    if (toast) entry.toast = toast;
    for (const [k, a] of Object.entries(anchors)) entry.anchors[k] = await rectOf(name, k, a);
    o.log(`shot ${name}`);
    return entry;
  };

  const rAF2 = () => page.ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);

  // Keeps the one toast on screen: the GUI's timer removes the detached original, the clone stays.
  const keepToast = async () => {
    await page.waitFor(`document.querySelector(".toast")`, "toast", 3000);
    await page.ev(`(() => { const t = document.querySelector(".toast"); t.replaceWith(t.cloneNode(true)); return true; })()`);
  };
  const dropToast = async () => {
    await page.ev(`(document.querySelectorAll(".toast").forEach(e => e.remove()), true)`);
    await page.waitFor(`!document.querySelector(".toast")`, "toast to go away", 4000);
  };

  const scrollSeries = async (name: string, el: string, anchors: Record<string, Anchor>, target: string): Promise<ScrollSeries> => {
    await page.ev(`document.querySelector(${JSON.stringify(el)}).scrollTop = 0`);
    await rAF2();
    const measured: Record<string, Rect> = {};
    for (const [k, a] of Object.entries(anchors)) measured[k] = await rectOf(name, k, a);
    const end = await page.ev<number>(target);
    const ys: number[] = [];
    for (let y = 0; y < end; y += 4) ys.push(y);
    ys.push(end);
    const files: string[] = [];
    for (const y of ys) {
      await page.ev(`document.querySelector(${JSON.stringify(el)}).scrollTop = ${y}`);
      await rAF2();
      const file = `${name}@${y}.png`;
      writeFileSync(join(o.outDir, file), await page.png());
      files.push(file);
    }
    o.log(`shot ${name} scroll ${ys.length} frames`);
    return { el, ys, files, anchors: measured };
  };

  // One shot: poll the Claude sessions, run the action, wait for the conditions and the network, capture.
  const step = async (
    name: string,
    s: { act?: () => Promise<void>; wait: string; label: string; anchors?: Record<string, Anchor>; toast?: boolean },
  ): Promise<ManifestShot> => {
    try {
      await o.serve.pollClaude();
      if (s.act) await s.act();
      try {
        await page.waitFor(s.wait, s.label);
      } catch (e) {
        const dump = await page.ev<string>(`[document.title, document.querySelectorAll(".ver-bar").length, [...(document.querySelector("#background")?.children ?? [])].map(e => e.className).join(","), document.querySelector("#pending-btn")?.innerText].join(" | ")`).catch(() => "(no page state)");
        throw new DemoError(`${(e as Error).message}; page: ${dump}`);
      }
      await page.waitNetworkIdle();
      if (s.toast) {
        const n = await page.ev<number>(`document.querySelectorAll(".toast").length`);
        if (n !== 1) throw new DemoError(`expected 1 toast, found ${n}`);
      }
      const entry = await capture(name, s.anchors ?? {});
      manifest.shots[name] = entry;
      return entry;
    } catch (e) {
      if (e instanceof DemoError) throw new DemoError(`shot ${name}: ${e.message}`);
      throw new DemoError(`shot ${name}: ${(e as Error).message}`);
    }
  };

  // 0: nothing pending yet.
  await step("empty", { wait: SEL.emptyVisible, label: "#empty visible" });

  await step("q1", {
    act: () => o.serve.seedHero(o.lang),
    wait: `document.querySelector("#background .mermaid-ok svg") && document.querySelector("#decision .opt") && document.querySelector("#background > .hd-goal")`,
    label: `"#background .mermaid-ok svg"`,
    anchors: { title: { parts: ["#head .v2-title"] } },
  });

  await step("q2", {
    act: () => o.serve.seedCompare(o.lang),
    wait: `document.title.startsWith("(2)")`,
    label: `title "(2)"`,
    anchors: { pending: { parts: ["#pending-btn"] } },
  });

  await step("q3", {
    act: () => o.serve.seedPlan(o.lang, 2),
    wait: `document.title.startsWith("(3)")`,
    label: `title "(3)"`,
    anchors: { pending: { parts: ["#pending-btn"] } },
  });

  await step("inbox", {
    act: async () => page.key("b"),
    wait: `${SEL.drawerOpen} && ${SEL.rows3}`,
    label: "drawer with 3 rows",
    anchors: { drawer: { parts: ["#drawer"] }, items: { parts: [{ sel: "#pending-list .row", all: true }] } },
  });
  manifest.repos = await page.ev(`Object.fromEntries([...document.querySelectorAll("#pending-list .row")].map(r => [r.querySelector(".where b")?.textContent, getComputedStyle(r.querySelector(".repo-dot")).backgroundColor]))`);

  const heroAnchors: Record<string, Anchor> = {
    mermaid: { parts: ["#background .mermaid-ok"], inScroll: true },
    options: { parts: [{ sel: "#decision .opt", all: true }] },
    pane: { parts: ["#background"] },
  };
  await step("hero", {
    act: async () => page.key("Enter"),
    wait: `!${SEL.drawerOpen} && document.querySelector("#decision .opt") && document.querySelector("#background .mermaid-ok svg")`,
    label: "drawer closed with the hero shown",
    anchors: heroAnchors,
  });
  manifest.shots.hero!.scroll = await scrollSeries(
    "hero",
    "#background",
    {
      callout: { parts: ["#background .callout"], inScroll: true },
      rec: { parts: ["#background .rec"], inScroll: true },
      lower: { parts: ["#background .callout", "#background .rec"], inScroll: true },
    },
    heroTarget,
  );

  await step("pick2", {
    act: async () => page.key("j"),
    wait: `document.querySelectorAll("#decision .opt")[1]?.classList.contains("cursor")`,
    label: "second option at the cursor",
    anchors: { options: { parts: [{ sel: "#decision .opt", all: true }] } },
  });
  await step("pick1", {
    act: async () => page.key("k"),
    wait: `document.querySelectorAll("#decision .opt")[0]?.classList.contains("cursor")`,
    label: "first option at the cursor",
    anchors: { options: { parts: [{ sel: "#decision .opt", all: true }] } },
  });

  await step("hero-answered", {
    act: async () => {
      await page.key("Enter");
      await keepToast();
    },
    wait: SEL.framesReady,
    label: "compare frames",
    anchors: { toast: { parts: [".toast"] } },
    toast: true,
  });

  await step("compare", {
    act: dropToast,
    wait: SEL.framesReady,
    label: "compare frames",
    anchors: {
      frames: { parts: ["#background .cols"] },
      options: { parts: [{ sel: "#decision .opt", all: true }] },
      body: { parts: ["#background .cols", { sel: "#decision .opt", all: true }] },
    },
  });

  await step("compare-answered", {
    act: async () => {
      await page.key("1");
      await keepToast();
    },
    wait: `document.querySelector("#background .ver-bar") && document.querySelector("#background > .hd-goal")`,
    label: "plan version bar",
    anchors: { toast: { parts: [".toast"] } },
    toast: true,
  });

  await step("plan", {
    act: dropToast,
    wait: `document.querySelector("#background details.plan-sec") && document.querySelector("#background .ver-bar") && document.querySelector("#background .hd-goal") && document.querySelector("#background code.hljs")`,
    label: "plan with highlighted code",
    anchors: {
      top: { parts: ["#background .ver-bar", "#background details.plan-sec[open]"] },
      toggle: { parts: ['#background .fr-toggle[data-ref="src/orders/checkout.ts:57"]'] },
      actions: { parts: [{ sel: "#decision [data-card]", all: true }] },
      approve: { parts: ["[data-card=approve]"] },
    },
  });

  // Click the file reference's ▸ once, then move the pointer away so no hover is left.
  const toggle = manifest.shots.plan!.anchors.toggle!;
  await step("plan-src", {
    act: async () => {
      await page.click(toggle.x + toggle.w / 2, toggle.y + toggle.h / 2);
      await page.move(1279, 799);
    },
    wait: `document.querySelector("#background .src-snip .src-lines")`,
    label: "source snippet",
    anchors: { snip: { parts: ["#background .src-snip"] } },
  });
  manifest.shots["plan-src"]!.scroll = await scrollSeries("plan-src", "#background", { steps: STEPS_ANCHOR }, stepsTarget);

  await step("plan-approved", {
    act: async () => {
      await page.key("y");
      await keepToast();
    },
    wait: SEL.emptyVisible,
    label: "empty inbox",
    anchors: { toast: { parts: [".toast"] } },
    toast: true,
  });

  await step("zero", {
    act: dropToast,
    wait: SEL.emptyVisible,
    label: "empty inbox",
  });

  const file = join(o.outDir, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  o.log(`wrote ${file}`);
  return manifest;
}
