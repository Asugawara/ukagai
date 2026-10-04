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

test("readConfig: at most 500 repo colours are kept (the schema's cap), unknown keys are stripped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-cfg-"));
  try {
    const colors: Record<string, number> = {};
    for (let i = 0; i < 600; i++) colors[`repo-${i}`] = i % 360;
    writeFileSync(configPath(dir), JSON.stringify({ repo_colors: colors, extra: { x: 1 }, checkpoints: { other: true } }));
    const c = await readConfig(dir);
    assert.equal(Object.keys(c.repo_colors).length, 500);
    assert.equal(Settings.safeParse(c).success, true, "what is read always passes the PUT schema");
    assert.equal("extra" in c, false);
    assert.deepEqual(Object.keys(c.checkpoints).sort(), ["codex_delay_s", "enabled", "terminal_delivery"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
