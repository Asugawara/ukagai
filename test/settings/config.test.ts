import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/contract.js";
import { DEFAULT_CONFIG, configPath, readConfig, writeConfig } from "../../src/settings/config.js";

test("readConfig: missing or malformed file yields the defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-cfg-"));
  try {
    assert.deepEqual(await readConfig(dir), DEFAULT_CONFIG);
    writeFileSync(configPath(dir), "{ not json");
    assert.deepEqual(await readConfig(dir), DEFAULT_CONFIG);
    writeFileSync(configPath(dir), JSON.stringify({ lang: "fr" }));
    assert.deepEqual(await readConfig(dir), DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeConfig then readConfig round-trips and creates the directory", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ukagai-cfg-")), "nested");
  try {
    await writeConfig(dir, { ...DEFAULT_CONFIG, lang: "ja" });
    assert.deepEqual(await readConfig(dir), { ...DEFAULT_CONFIG, lang: "ja" });
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("readConfig: unknown keys are stripped, and a repo_colors key from an older version is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-cfg-"));
  try {
    writeFileSync(configPath(dir), JSON.stringify({ theme: "dark", repo_colors: { ukagai: 120, dotfiles: "grey" }, extra: { x: 1 }, checkpoints: { other: true } }));
    const c = await readConfig(dir);
    assert.equal(c.theme, "dark");
    assert.equal("repo_colors" in c, false);
    assert.equal(Settings.safeParse(c).success, true, "what is read always passes the PUT schema");
    assert.equal("extra" in c, false);
    assert.deepEqual(Object.keys(c.checkpoints).sort(), ["codex_delay_s", "enabled", "terminal_delivery"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
