import { cleanEnv } from "./clean-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");

async function setup(): Promise<{ dir: string; settings: string; dataDir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-lang-"));
  return { dir, settings: join(dir, "settings.json"), dataDir: join(dir, "data"), home: join(dir, "home") };
}

/** Every case names its locale variables: cleanEnv drops the machine's, `locale` adds the case's */
function ukagai(home: string, args: string[], locale: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const child = execFile(process.execPath, ["--import", TSX, CLI, ...args], { env: cleanEnv({ HOME: home, ...locale }) }, (e, out, err) => {
      res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err });
    });
    child.stdin?.end();
  });
}

const readLang = async (dataDir: string): Promise<unknown> => JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).lang;
const install = (e: { settings: string; dataDir: string }, extra: string[] = []): string[] => ["install", "--settings", e.settings, "--data-dir", e.dataDir, ...extra];

test("first install without a locale writes en and points at the Settings page", async () => {
  const e = await setup();
  const r = await ukagai(e.home, install(e, ["--server", "http://127.0.0.1:9999"]), { LANG: "C" });
  assert.equal(r.code, 0, r.err);
  assert.equal(await readLang(e.dataDir), "en");
  const cfg = join(e.dataDir, "config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(r.out, new RegExp(`lang: +en \\(${cfg}\\); change it on the Settings page: http://127\\.0\\.0\\.1:9999/settings`));
});

test("first install with LANG=ja_JP.UTF-8 writes ja", async () => {
  const e = await setup();
  const r = await ukagai(e.home, install(e), { LANG: "ja_JP.UTF-8" });
  assert.equal(r.code, 0, r.err);
  assert.equal(await readLang(e.dataDir), "ja");
  assert.match(r.out, /lang: +ja /);
});

test("LC_ALL beats LC_MESSAGES beats LANG, and an empty value is skipped", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ LC_ALL: "en_US.UTF-8", LANG: "ja_JP.UTF-8" }, "en"],
    [{ LC_ALL: "", LC_MESSAGES: "ja_JP.UTF-8", LANG: "en_US.UTF-8" }, "ja"],
    [{ LC_ALL: "", LC_MESSAGES: "", LANG: "ja_JP.UTF-8" }, "ja"],
    [{}, "en"],
  ];
  for (const [locale, want] of cases) {
    const e = await setup();
    const r = await ukagai(e.home, install(e), locale);
    assert.equal(r.code, 0, r.err);
    assert.equal(await readLang(e.dataDir), want, JSON.stringify(locale));
  }
});

test("install leaves an existing config.json alone, whatever the locale", async () => {
  const e = await setup();
  await mkdir(e.dataDir, { recursive: true });
  const saved = {
    lang: "en", theme: "dark", hints: false,
    checkpoints: { enabled: false, codex_delay_s: 600, terminal_delivery: false },
    plans: { auto_show: false, instruction_presets: [] },
    notify: { sound: true, browser: false, title_badge: false },
  };
  await writeFile(join(e.dataDir, "config.json"), JSON.stringify(saved));
  const before = await readFile(join(e.dataDir, "config.json"), "utf8");
  const r = await ukagai(e.home, install(e), { LANG: "ja_JP.UTF-8" });
  assert.equal(r.code, 0, r.err);
  assert.equal(await readFile(join(e.dataDir, "config.json"), "utf8"), before);
  assert.match(r.out, /lang: +en /);
});

test("--lang is ignored with a warning, value included, and never validated", async () => {
  for (const args of [["--lang", "ja"], ["--lang=ja"], ["--lang", "fr"]]) {
    const e = await setup();
    const r = await ukagai(e.home, install(e, args), { LANG: "C" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /--lang is ignored/);
    assert.equal(await readLang(e.dataDir), "en", args.join(" "));
  }
});

test("--lang followed by another option does not swallow it", async () => {
  const e = await setup();
  const r = await ukagai(e.home, install(e, ["--lang", "--no-autostart"]), { LANG: "C" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /--lang is ignored/);
  assert.match(r.out, /autostart: off/);
});

test("install --dry-run does not write config.json", async () => {
  const e = await setup();
  const r = await ukagai(e.home, install(e, ["--dry-run"]), { LANG: "ja_JP.UTF-8" });
  assert.equal(r.code, 0, r.err);
  await assert.rejects(readFile(join(e.dataDir, "config.json")));
});

test("uninstall keeps config.json; doctor shows the lang row", async () => {
  const e = await setup();
  await ukagai(e.home, install(e), { LANG: "ja_JP.UTF-8" });
  await ukagai(e.home, ["uninstall", "--settings", e.settings, "--data-dir", e.dataDir]);
  assert.equal(await readLang(e.dataDir), "ja");
  const d = await ukagai(e.home, ["doctor", "--settings", e.settings, "--data-dir", e.dataDir, "--server", "http://127.0.0.1:1"]);
  assert.match(d.out, /lang +ja /);
});

test("install --help documents --refresh and no longer --lang", async () => {
  const r = await ukagai((await setup()).home, ["install", "--help"]);
  assert.match(r.out, /--refresh/);
  assert.doesNotMatch(r.out, /--lang/);
});
