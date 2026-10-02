import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, readConfig, writeConfig } from "../../src/settings/config.js";

test("readConfig: missing or malformed file yields the defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-cfg-"));
  try {
    assert.deepEqual(await readConfig(dir), { lang: "en" });
    writeFileSync(configPath(dir), "{ not json");
    assert.deepEqual(await readConfig(dir), { lang: "en" });
    writeFileSync(configPath(dir), JSON.stringify({ lang: "fr" }));
    assert.deepEqual(await readConfig(dir), { lang: "en" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeConfig then readConfig round-trips and creates the directory", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ukagai-cfg-")), "nested");
  try {
    await writeConfig(dir, { lang: "ja" });
    assert.deepEqual(await readConfig(dir), { lang: "ja" });
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
