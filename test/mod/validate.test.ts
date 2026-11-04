import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeMod } from "../../src/mod/files.js";

const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

// The engine statically checks how a hooks module uses `$` and refuses to load a module that breaks the rules
// (e.g. reading `$.ui` as a value, passing `$` to a function nested inside `register`). `claude plugin validate`
// reports it, so a break shows here instead of as a silently missing mod in a real session.
test("claude plugin validate accepts the mod folder placeMod writes", { skip: !hasClaude && "claude is not on PATH" }, () => {
  const d = join(mkdtempSync(join(tmpdir(), "ukagai-modvalidate-")), "ukagai-mod");
  placeMod(d, { version: "0.0.0" });
  const r = spawnSync("claude", ["plugin", "validate", d], { encoding: "utf8", timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.ok(!/Found \d+ error/.test(out), out);
});
