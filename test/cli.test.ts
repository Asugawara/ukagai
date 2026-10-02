import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    input,
    encoding: "utf8",
  });
}

test("--help は exit 0 で 5 つのサブコマンド名を含む", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  for (const name of ["serve", "hook", "install", "uninstall", "doctor"]) {
    assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
  }
});

test("未知のサブコマンドは exit 2", () => {
  const r = runCli(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});

test("hook スタブは JSON を stdin で受けて stdout 空・exit 0", () => {
  const r = runCli(["hook"], JSON.stringify({ tool_name: "Bash" }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
