// The user's version of the skill: <data-dir>/skill/{SKILL.md, base.md, meta.json}
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customSkillPath, readSkill, resetSkill, skillDir, writeSkill } from "../../src/settings/skill.js";
import { getVersion } from "../../src/version.js";

const roots: string[] = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function setup(def = "default v1\n") {
  const root = mkdtempSync(join(tmpdir(), "ukagai-skill-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const defaultPath = join(root, "SKILL.md");
  writeFileSync(defaultPath, def);
  return { dataDir, defaultPath };
}

test("nothing saved: custom / base are null, not stale; the default is read", async () => {
  const { dataDir, defaultPath } = setup();
  assert.deepEqual(await readSkill(dataDir, defaultPath), { default: "default v1\n", custom: null, base: null, baseVersion: null, stale: false });
  assert.equal(customSkillPath(dataDir), join(dataDir, "skill", "SKILL.md"));
});

test("first save writes SKILL.md, base.md (the default) and meta.json (this version); no temp files are left", async () => {
  const { dataDir, defaultPath } = setup();
  await writeSkill(dataDir, "mine\n", "default v1\n");
  const st = await readSkill(dataDir, defaultPath);
  assert.deepEqual(st, { default: "default v1\n", custom: "mine\n", base: "default v1\n", baseVersion: getVersion(), stale: false });
  assert.deepEqual(readdirSync(skillDir(dataDir)).sort(), ["SKILL.md", "base.md", "meta.json"]);
});

test("a later save keeps the base and the version from the first save", async () => {
  const { dataDir, defaultPath } = setup();
  await writeSkill(dataDir, "mine\n", "default v1\n");
  writeFileSync(join(skillDir(dataDir), "meta.json"), JSON.stringify({ version: "0.0.1" }));
  writeFileSync(defaultPath, "default v2\n");
  await writeSkill(dataDir, "mine 2\n", "default v2\n");
  const st = await readSkill(dataDir, defaultPath);
  assert.equal(st.custom, "mine 2\n");
  assert.equal(st.base, "default v1\n");
  assert.equal(st.baseVersion, "0.0.1");
});

test("stale: only with a custom version whose base differs from the default", async () => {
  const { dataDir, defaultPath } = setup();
  assert.equal((await readSkill(dataDir, defaultPath)).stale, false);
  await writeSkill(dataDir, "mine\n", "default v1\n");
  assert.equal((await readSkill(dataDir, defaultPath)).stale, false);
  writeFileSync(defaultPath, "default v2\n");
  assert.equal((await readSkill(dataDir, defaultPath)).stale, true);
  // base.md edited by hand to match: not stale
  writeFileSync(join(skillDir(dataDir), "base.md"), "default v2\n");
  assert.equal((await readSkill(dataDir, defaultPath)).stale, false);
  // no custom version (only a leftover base.md): not stale
  rmSync(customSkillPath(dataDir));
  writeFileSync(join(skillDir(dataDir), "base.md"), "old\n");
  assert.equal((await readSkill(dataDir, defaultPath)).stale, false);
});

test("resetSkill removes the directory; a second reset (nothing there) is fine", async () => {
  const { dataDir, defaultPath } = setup();
  await writeSkill(dataDir, "mine\n", "default v1\n");
  await resetSkill(dataDir);
  assert.equal(existsSync(skillDir(dataDir)), false);
  await resetSkill(dataDir);
  assert.equal((await readSkill(dataDir, defaultPath)).custom, null);
  // after a reset the next save takes a fresh base
  writeFileSync(defaultPath, "default v2\n");
  await writeSkill(dataDir, "mine\n", "default v2\n");
  assert.equal((await readSkill(dataDir, defaultPath)).base, "default v2\n");
});

test("unreadable default: default is null and nothing throws; a damaged meta.json only loses the version", async () => {
  const { dataDir } = setup();
  const missing = join(dataDir, "no-such", "SKILL.md");
  assert.equal((await readSkill(dataDir, missing)).default, null);
  await writeSkill(dataDir, "mine\n", "x\n");
  writeFileSync(join(skillDir(dataDir), "meta.json"), "{ not json");
  const asDir = join(dataDir, "adir");
  mkdirSync(asDir, { recursive: true });
  const st = await readSkill(dataDir, asDir); // a directory is not readable as text
  assert.deepEqual({ default: st.default, custom: st.custom, baseVersion: st.baseVersion, stale: st.stale }, { default: null, custom: "mine\n", baseVersion: null, stale: true });
});

test("concurrent saves end with the last one and the files are whole", async () => {
  const { dataDir } = setup();
  await Promise.all([1, 2, 3, 4, 5].map((i) => writeSkill(dataDir, `v${i}\n`, "d\n")));
  assert.equal(readFileSync(customSkillPath(dataDir), "utf8"), "v5\n");
  assert.deepEqual(readdirSync(skillDir(dataDir)).sort(), ["SKILL.md", "base.md", "meta.json"]);
});
