// Entry point: npm run demo [-- flags]. This step implements --shots-only; the other modes are not built yet.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findChrome, launchBrowser } from "./lib/cdp.js";
import { renderInputs } from "./lib/inputs.js";
import { startServe, prepareHome } from "./lib/serve.js";
import { LANGS, type Lang } from "./seeds.js";
import { takeShots, DemoError } from "./shots.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const OUT_ROOT = join(REPO_ROOT, "demo", "out");

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

async function shotsOnly(lang: Lang, chrome: string, tempRoot: string) {
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

async function main(): Promise<number> {
  if (!values["shots-only"]) {
    console.error("demo: not implemented yet; use --shots-only (the frame loop, encoder and stage come in later steps)");
    return 1;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error("demo: Chrome not found. Set UKAGAI_DEMO_CHROME to the Chrome binary.");
    return 1;
  }
  const langs: Lang[] = values.lang ? [values.lang as Lang] : [...LANGS];
  if (values.lang && !LANGS.includes(values.lang as Lang)) {
    console.error(`demo: --lang must be en or ja, got ${values.lang}`);
    return 1;
  }
  const inputs = renderInputs(REPO_ROOT);
  const tempRoot = mkdtempSync(join(realpathSync("/private/tmp"), "ukagai-demo-"));
  try {
    const rows = [];
    for (const lang of langs) rows.push(await shotsOnly(lang, chrome, tempRoot));
    console.log("");
    console.log(`inputs ${inputs.hash.slice(0, 12)} (${inputs.files} files) head ${inputs.head}${inputs.dirty ? " dirty" : ""}`);
    console.log("lang  serve port  shots  output");
    for (const r of rows) console.log(`${r.lang.padEnd(5)} ${String(r.port).padEnd(11)} ${String(r.shots).padEnd(6)} ${r.outDir}`);
    for (const r of rows) console.log(`${r.lang} repos: ${JSON.stringify(r.repos)}`);
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
