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

test("--help exits 0 and lists the subcommand names", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  for (const name of ["serve", "hook", "install", "uninstall", "doctor"]) {
    assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
  }
});

test("unknown subcommand exits 2", () => {
  const r = runCli(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});

test("hook reads JSON on stdin, prints nothing, exits 0", () => {
  const r = runCli(["hook"], JSON.stringify({ tool_name: "Bash" }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("tui --help exits 0; without a TTY, tui exits 1", () => {
  const h = runCli(["tui", "--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--data-dir/);
  const r = runCli(["tui"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});
