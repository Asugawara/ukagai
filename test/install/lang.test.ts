import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");

async function setup(): Promise<{ dir: string; settings: string; dataDir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-lang-"));
  return { dir, settings: join(dir, "settings.json"), dataDir: join(dir, "data"), home: join(dir, "home") };
}

// stdin is a pipe (not a TTY), so install never prompts here
function ukagai(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const child = execFile(process.execPath, ["--import", TSX, CLI, ...args], { env: { ...process.env, HOME: home } }, (e, out, err) => {
      res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err });
    });
    child.stdin?.end();
  });
}

const readLang = async (dataDir: string): Promise<unknown> => JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).lang;

test("install --lang ja writes config.json and reports it", async () => {
  const e = await setup();
  const r = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(await readLang(e.dataDir), "ja");
  assert.match(r.out, new RegExp(`lang: +ja \\(${join(e.dataDir, "config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("install without --lang and without a TTY writes en", async () => {
  const e = await setup();
  const r = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(await readLang(e.dataDir), "en");
  assert.match(r.out, /lang: +en /);
});

test("install without --lang keeps an existing config", async () => {
  const e = await setup();
  await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  const r = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(await readLang(e.dataDir), "ja");
  assert.match(r.out, /lang: +ja /);
});

test("install --lang overwrites an existing config", async () => {
  const e = await setup();
  await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "en"]);
  assert.equal(await readLang(e.dataDir), "en");
});

test("install --lang with an unknown value exits 2 and writes nothing", async () => {
  const e = await setup();
  const r = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "fr"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--lang/);
  await assert.rejects(readFile(join(e.dataDir, "config.json")));
});

test("install --dry-run does not write config.json", async () => {
  const e = await setup();
  const r = await ukagai(e.home, ["install", "--dry-run", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  assert.equal(r.code, 0, r.err);
  await assert.rejects(readFile(join(e.dataDir, "config.json")));
});

test("uninstall keeps config.json; doctor shows the lang row", async () => {
  const e = await setup();
  await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  await ukagai(e.home, ["uninstall", "--settings", e.settings, "--data-dir", e.dataDir]);
  assert.equal(await readLang(e.dataDir), "ja");
  const d = await ukagai(e.home, ["doctor", "--settings", e.settings, "--data-dir", e.dataDir, "--server", "http://127.0.0.1:1"]);
  assert.match(d.out, /lang +ja /);
});

test("install --help documents --lang", async () => {
  const r = await ukagai((await setup()).home, ["install", "--help"]);
  assert.match(r.out, /--lang <en\|ja>/);
});

test("install --lang keeps the other settings of an existing config.json (with and without --lang)", async () => {
  const e = await setup();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(e.dataDir, { recursive: true });
  const saved = {
    lang: "en", theme: "dark", hints: false,
    checkpoints: { enabled: false, codex_delay_s: 600, terminal_delivery: false },
    plans: { auto_show: false },
    notify: { sound: true, browser: false, title_badge: false },
    repo_colors: { ukagai: 120, dotfiles: "grey" },
  };
  await writeFile(join(e.dataDir, "config.json"), JSON.stringify(saved));
  const r = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir, "--lang", "ja"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(await readFile(join(e.dataDir, "config.json"), "utf8")), { ...saved, lang: "ja" });
  const r2 = await ukagai(e.home, ["install", "--settings", e.settings, "--data-dir", e.dataDir]);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(JSON.parse(await readFile(join(e.dataDir, "config.json"), "utf8")), { ...saved, lang: "ja" });
});
