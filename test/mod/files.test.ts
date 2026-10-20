import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasMod, missingModFiles, placeMod, removeMod } from "../../src/mod/files.js";
import { MOD_DIR } from "../../src/settings/target.js";

const dest = (): string => join(mkdtempSync(join(tmpdir(), "ukagai-modfiles-")), "ukagai-mod");

test("placeMod writes a mod-only plugin: no command hook, no tests, config.json only when asked", () => {
  const d = dest();
  placeMod(d, { version: "1.2.3" });
  const manifest = JSON.parse(readFileSync(join(d, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(manifest, { name: "ukagai-mod", version: "1.2.3", description: manifest.description, author: { name: "Asugawara" }, hooks: "./hooks/claude.json" });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "hooks", "claude.json"), "utf8")), { modules: ["./mod/register.ts"] });
  assert.ok(!existsSync(join(d, "hooks", "hooks.json")));
  const shipped = readdirSync(MOD_DIR).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(readdirSync(join(d, "hooks", "mod")).sort(), shipped.sort());
  assert.ok(shipped.includes("register.ts") && shipped.includes("core.ts"));
  assert.equal(readFileSync(join(d, "hooks", "mod", "core.ts"), "utf8"), readFileSync(join(MOD_DIR, "core.ts"), "utf8"));
  assert.ok(hasMod(d));
  assert.deepEqual(missingModFiles(d), []);
});

test("placeMod writes config.json with the given server and data dir only", () => {
  const d = dest();
  placeMod(d, { version: "1", server: "http://127.0.0.1:4919" });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "hooks", "mod", "config.json"), "utf8")), { server: "http://127.0.0.1:4919" });
  placeMod(d, { version: "1", dataDir: "/x/d" });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "hooks", "mod", "config.json"), "utf8")), { dataDir: "/x/d" });
  placeMod(d, { version: "1" });
  assert.ok(!existsSync(join(d, "hooks", "mod", "config.json")), "a re-run without the options drops the old config");
});

test("removeMod removes what placeMod wrote and the directories; a file the human added stays", () => {
  const d = dest();
  placeMod(d, { version: "1", server: "http://127.0.0.1:1" });
  assert.equal(removeMod(d), true);
  assert.ok(!existsSync(d));
  assert.equal(removeMod(d), false);

  placeMod(d, { version: "1" });
  writeFileSync(join(d, "notes.md"), "mine");
  removeMod(d);
  assert.deepEqual(readdirSync(d), ["notes.md"]);
});

test("hasMod is false for a directory that is not ours", () => {
  const d = dest();
  mkdirSync(join(d, ".claude-plugin"), { recursive: true });
  writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"someone-else"}');
  assert.equal(hasMod(d), false);
  assert.equal(removeMod(d), false);
  assert.ok(existsSync(join(d, ".claude-plugin", "plugin.json")));
});
