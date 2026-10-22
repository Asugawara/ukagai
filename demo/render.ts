// Entry point: npm run demo [-- flags]. Captures the GUI, plays the stage frame by frame and encodes WebP / MP4.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findChrome, launchBrowser, type Page } from "./lib/cdp.js";
import { contactSheet, encodeMp4, encodePreview, encodeWebp, have, MP4_MAX_BYTES, WEBP_MAX_BYTES } from "./lib/encode.js";
import { serveStatic } from "./lib/http.js";
import { renderInputs } from "./lib/inputs.js";
import { startServe, prepareHome } from "./lib/serve.js";
import { LANGS, type Lang } from "./seeds.js";
import { takeShots, DemoError } from "./shots.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const OUT_ROOT = join(REPO_ROOT, "demo", "out");
const PREVIEW_FPS = 12;

const { values } = parseArgs({
  options: {
    lang: { type: "string" },
    preview: { type: "boolean" },
    "reuse-shots": { type: "boolean" },
    at: { type: "string" },
    scale: { type: "string" },
    "no-mp4": { type: "boolean" },
    "shots-only": { type: "boolean" },
  },
  strict: true,
});

async function capture(lang: Lang, chrome: string, tempRoot: string) {
  const langRoot = join(tempRoot, lang);
  const home = join(langRoot, "home");
  const dataDir = join(langRoot, "data");
  mkdirSync(home, { recursive: true });
  prepareHome(home, lang);
  const serve = await startServe({ repoRoot: REPO_ROOT, tempRoot, home, dataDir, logFile: join(langRoot, "serve.log"), lang });
  try {
    const browser = await launchBrowser({ chrome, profileDir: join(langRoot, "chrome") });
    try {
      const outDir = join(OUT_ROOT, lang, "shots");
      const manifest = await takeShots({
        repoRoot: REPO_ROOT,
        browser,
        serve,
        lang,
        outDir,
        cacheDir: join(OUT_ROOT, "cache"),
        frozenNow: Date.now() - 60_000,
        log: (m) => console.log(`[${lang}] ${m}`),
      });
      return { lang, port: serve.port, shots: Object.keys(manifest.shots).length, repos: manifest.repos, outDir };
    } finally {
      await browser.close();
    }
  } finally {
    await serve.stop();
  }
}

interface StageInfo {
  story: number;
  speed: number;
  frames: number;
  fps: number;
  scenes: { name: string; playStart: number; playEnd: number }[];
  problems: string[];
}

const frameName = (i: number) => `f${String(i).padStart(5, "0")}.png`;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const bytes = (file: string) => statSync(file).size;

function fresh(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Frame i of n shows script time i * story / n, so the n-th frame lands exactly on the start of the loop
async function frames(page: Page, info: StageInfo, n: number, dir: string) {
  fresh(dir);
  for (let i = 0; i < n; i++) {
    await page.ev(`stage.render(${(i * info.story) / n})`);
    writeFileSync(join(dir, frameName(i)), await page.png());
  }
}

async function stillAt(page: Page, t: number, file: string) {
  await page.ev(`stage.render(${t})`);
  writeFileSync(file, await page.png());
}

interface Row {
  lang: string;
  frames: number;
  seconds: number;
  webp?: number;
  mp4?: number;
  note: string;
}

async function stageRun(lang: Lang, chrome: string, tempRoot: string, inputs: ReturnType<typeof renderInputs>, servePort: number | null, reused: boolean): Promise<Row> {
  const langOut = join(OUT_ROOT, lang);
  const shotsDir = join(langOut, "shots");
  if (!existsSync(join(shotsDir, "manifest.json"))) throw new DemoError(`no shots for ${lang}: run without --reuse-shots first`);
  const dsf = values.preview ? 0.5 : values.scale ? Number(values.scale) : 1;
  if (!(dsf > 0)) throw new DemoError(`--scale must be a positive number, got ${values.scale}`);
  const server = await serveStatic({
    "/stage/": join(REPO_ROOT, "demo", "stage"),
    "/timeline.js": join(REPO_ROOT, "demo", "timeline.js"),
    "/shots/": shotsDir,
    "/public/": join(REPO_ROOT, "public"),
  });
  const browser = await launchBrowser({ chrome, profileDir: join(tempRoot, lang, "stage-chrome") });
  try {
    const page = await browser.page({ width: 1280, height: 720, dsf });
    await page.goto(`${server.origin}/stage/index.html?lang=${lang}`);
    const info: StageInfo = await page.ev(`window.stage.ready`);
    if (info.problems.length > 0) throw new DemoError(`timeline problems:\n  ${info.problems.join("\n  ")}`);
    const playSeconds = info.story / info.speed;
    const toStory = (playT: number) => (playT * info.story) / playSeconds;
    const row: Row = { lang, frames: info.frames, seconds: playSeconds, note: "" };

    if (values.at) {
      const dir = join(langOut, "stills");
      mkdirSync(dir, { recursive: true });
      for (const x of values.at.split(",").map(Number)) await stillAt(page, toStory(x), join(dir, `${x}.png`));
      row.note = `stills in ${dir}`;
      return row;
    }

    // Contact sheet: three frames per scene, named by playback second
    const contact = async () => {
      const dir = join(langOut, "contact");
      fresh(dir);
      const files: string[] = [];
      for (const s of info.scenes) {
        for (const p of [s.playStart + 0.05, (s.playStart + s.playEnd) / 2, s.playEnd - 0.05]) {
          const file = join(dir, `${p.toFixed(2).padStart(5, "0")}-${s.name}.png`);
          await stillAt(page, toStory(p), file);
          files.push(file);
        }
      }
      if (have("magick")) contactSheet(files, join(langOut, "contact.png"));
      else console.warn("demo: magick not found, skipping contact.png");
    };

    if (values.preview) {
      const n = Math.round(playSeconds * PREVIEW_FPS);
      const dir = join(langOut, "preview-frames");
      await frames(page, info, n, dir);
      if (have("ffmpeg")) encodePreview(dir, PREVIEW_FPS, join(langOut, "preview.mp4"));
      else console.warn("demo: ffmpeg not found, skipping preview.mp4");
      await contact();
      row.frames = n;
      row.note = "preview.mp4, contact.png";
      return row;
    }

    if (values.scale) {
      const dir = join(langOut, "frames-scaled");
      await frames(page, info, info.frames, dir);
      encodeMp4(dir, info.fps, join(langOut, `demo-${values.scale}x.mp4`));
      row.mp4 = bytes(join(langOut, `demo-${values.scale}x.mp4`));
      row.note = `demo-${values.scale}x.mp4`;
      return row;
    }

    if (!have("img2webp")) throw new DemoError("img2webp not found (brew install webp)");
    const dir = join(langOut, "frames");
    await frames(page, info, info.frames, dir);
    const webp = join(langOut, "demo.webp");
    encodeWebp(dir, info.frames, info.fps, webp);
    row.webp = bytes(webp);
    const record: Record<string, unknown> = {
      lang,
      frames: info.frames,
      duration_s: playSeconds,
      story_s: info.story,
      speed: info.speed,
      fps: info.fps,
      width: 1280,
      height: 720,
      webp: { file: "demo.webp", bytes: row.webp, sha256: sha(webp) },
      mp4: null,
      chrome: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
      head: inputs.head,
      inputs: inputs.hash,
      dirty: inputs.dirty,
      reused_shots: reused,
      serve_port: servePort,
      rendered_at: new Date().toISOString(),
    };
    if (!values["no-mp4"]) {
      if (have("ffmpeg")) {
        const mp4 = join(langOut, "demo.mp4");
        encodeMp4(dir, info.fps, mp4);
        row.mp4 = bytes(mp4);
        record.mp4 = { file: "demo.mp4", bytes: row.mp4, sha256: sha(mp4) };
      } else console.warn("demo: ffmpeg not found, skipping demo.mp4");
    }
    await contact();
    const over: string[] = [];
    if (row.webp > WEBP_MAX_BYTES) over.push(`WebP ${row.webp} > ${WEBP_MAX_BYTES}`);
    if (row.mp4 !== undefined && row.mp4 > MP4_MAX_BYTES) over.push(`MP4 ${row.mp4} > ${MP4_MAX_BYTES}`);
    if (over.length) console.warn(`demo: [${lang}] over the size budget: ${over.join(", ")}. Trim in the order of the plan (20 fps, cut two in-GUI moves, q62, 1152x648).`);
    row.note = over.length ? `over budget: ${over.join(", ")}` : "";
    writeFileSync(join(langOut, "render.json"), JSON.stringify(record, null, 2) + "\n");
    return row;
  } finally {
    await browser.close();
    await server.close();
  }
}

async function main(): Promise<number> {
  const chrome = findChrome();
  if (!chrome) {
    console.error("demo: Chrome not found. Set UKAGAI_DEMO_CHROME to the Chrome binary.");
    return 1;
  }
  if (values.lang && !LANGS.includes(values.lang as Lang)) {
    console.error(`demo: --lang must be en or ja, got ${values.lang}`);
    return 1;
  }
  const langs: Lang[] = values.lang ? [values.lang as Lang] : [...LANGS];
  const inputs = renderInputs(REPO_ROOT);
  const tempRoot = mkdtempSync(join(realpathSync("/private/tmp"), "ukagai-demo-"));
  try {
    const reuse = values["reuse-shots"] === true && langs.every((l) => existsSync(join(OUT_ROOT, l, "shots", "manifest.json")));
    const ports = new Map<Lang, number>();
    const shotRows = [];
    if (!reuse) {
      for (const lang of langs) {
        const r = await capture(lang, chrome, tempRoot);
        ports.set(lang, r.port);
        shotRows.push(r);
      }
    }
    if (values["shots-only"]) {
      console.log("");
      console.log(`inputs ${inputs.hash.slice(0, 12)} (${inputs.files} files) head ${inputs.head}${inputs.dirty ? " dirty" : ""}`);
      console.log("lang  serve port  shots  output");
      for (const r of shotRows) console.log(`${r.lang.padEnd(5)} ${String(r.port).padEnd(11)} ${String(r.shots).padEnd(6)} ${r.outDir}`);
      for (const r of shotRows) console.log(`${r.lang} repos: ${JSON.stringify(r.repos)}`);
      return 0;
    }
    const rows: Row[] = [];
    for (const lang of langs) rows.push(await stageRun(lang, chrome, tempRoot, inputs, ports.get(lang) ?? null, reuse));
    console.log("");
    console.log(`inputs ${inputs.hash.slice(0, 12)} (${inputs.files} files) head ${inputs.head}${inputs.dirty ? " dirty" : ""}${reuse ? " (shots reused)" : ""}`);
    console.log("lang  frames  play s  story s/speed  serve port  webp bytes  mp4 bytes  note");
    for (const r of rows) {
      const file = join(OUT_ROOT, r.lang, "render.json");
      const j = existsSync(file) && !values.preview && !values.at && !values.scale ? JSON.parse(readFileSync(file, "utf8")) : null;
      const speed = j ? `${j.story_s}/${j.speed}` : "";
      console.log(`${r.lang.padEnd(5)} ${String(r.frames).padEnd(7)} ${r.seconds.toFixed(2).padEnd(7)} ${speed.padEnd(14)} ${String(ports.get(r.lang as Lang) ?? "-").padEnd(11)} ${String(r.webp ?? "-").padEnd(11)} ${String(r.mp4 ?? "-").padEnd(10)} ${r.note}`);
    }
    if (!values.preview && !values.at && !values.scale) for (const r of rows) console.log(`${r.lang} webp sha256 ${sha(join(OUT_ROOT, r.lang, "demo.webp"))}`);
    return 0;
  } catch (e) {
    const msg = e instanceof DemoError || e instanceof Error ? e.message : String(e);
    console.error(`demo: ${msg}`);
    return 1;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

process.exitCode = await main();
