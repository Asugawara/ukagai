import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLsofCwds, parsePsCodexPids, tuiRunningIn } from "../../src/serve/codex-bridge/tui-probe.js";

const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const PS = [
  "    1 /sbin/launchd",
  "  101 node /Users/x/.nvm/v24/bin/codex fix the bug",
  "  102 /Users/x/.nvm/v24/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex fix the bug",
  "  103 /Users/x/.nvm/v24/lib/node_modules/@openai/codex/vendor/bin/codex app-server --listen unix://",
  "  104 node /Users/x/.nvm/v24/bin/codex app-server daemon start",
  "  105 python3 /opt/serena/serena.py --project codex",
  "  106 /Applications/ChatGPT Meetings.app/Contents/MacOS/ChatGPT Meetings",
  "  107 node /Users/x/proj/server.js",
  "  108 /usr/local/bin/codex",
  "  109 node /Users/x/.nvm/v24/bin/codex fix the app-server bug",
  "  110 /Users/x/.nvm/v24/vendor/bin/codex fix the app-server bug",
  "  111 node --no-warnings /Users/x/.nvm/v24/bin/codex review",
  "  112 /Applications/Visual Studio Code.app/x/bin/codex -c k=v app-server --analytics-default-enabled",
  "  113 /Users/x/.codex/plugins/cache/p/Python -u /Users/x/.codex/plugins/cache/p/run.py",
  "  114 /Users/x/.local/bin/codex app-server daemon pid-update-loop",
].join("\n");

test("ps parsing keeps the node wrapper and the native binary, drops app-server and unrelated lines", () => {
  assert.deepEqual(parsePsCodexPids(PS), [101, 102, 108, 109, 110, 111]);
});

test("lsof -Fn parsing maps pid → cwd", () => {
  const out = "p101\nfcwd\nn/private/tmp/a\np102\nfcwd\nn/Users/x/my proj\n";
  assert.deepEqual([...parseLsofCwds(out)], [
    [101, "/private/tmp/a"],
    [102, "/Users/x/my proj"],
  ]);
});

/** A fake `ps` / `lsof` pair on exec: the probe is given a runner instead of PATH lookups for the happy paths */
const fakeExec = (cwdOf: Record<number, string>) => async (cmd: string, args: string[]) => {
  if (cmd === "ps") return PS;
  assert.equal(cmd, "lsof");
  const pids = args[args.indexOf("-p") + 1]!.split(",").map(Number);
  return pids.map((p) => `p${p}\nfcwd\nn${cwdOf[p]}\n`).join("");
};

test("a TUI whose cwd is the thread's folder: true; another folder: false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-tp-"));
  cleanup.push(dir);
  const exec = fakeExec({ 101: dir, 102: dir, 108: "/elsewhere", 109: "/elsewhere", 110: "/elsewhere", 111: "/elsewhere" });
  assert.equal(await tuiRunningIn(dir, { platform: "darwin", exec }), true);
  assert.equal(await tuiRunningIn(join(dir, "nope"), { platform: "darwin", exec }), false);
});

test("symlinked and real paths of the same folder match (/tmp vs /private/tmp style)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-tp-"));
  cleanup.push(dir);
  const real = realpathSync(dir);
  const link = join(dir, "..", `${dir.split("/").pop()}-link`);
  symlinkSync(real, link);
  cleanup.push(link);
  const exec = fakeExec({ 101: real, 102: real, 108: real, 109: real, 110: real, 111: real });
  assert.equal(await tuiRunningIn(link, { platform: "darwin", exec }), true);
  assert.equal(await tuiRunningIn(real, { platform: "darwin", exec: fakeExec({ 101: link, 102: link, 108: link, 109: link, 110: link, 111: link }) }), true);
});

test("lsof exiting non-zero keeps the stdout of the pids that are still there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-tp-"));
  cleanup.push(dir);
  const exec = async (cmd: string) => {
    if (cmd === "ps") return PS;
    throw Object.assign(new Error("exit 1"), { stdout: `p101\nfcwd\nn${dir}\n` });
  };
  assert.equal(await tuiRunningIn(dir, { platform: "darwin", exec }), true);
  assert.equal(await tuiRunningIn("/nowhere-else", { platform: "darwin", exec }), false);
  // nothing on stdout: cannot tell
  const bare = async (cmd: string) => {
    if (cmd === "ps") return PS;
    throw Object.assign(new Error("exit 1"), { stdout: "" });
  };
  assert.equal(await tuiRunningIn(dir, { platform: "darwin", exec: bare }), undefined);
});

test("linux: codex processes whose cwd cannot be read: undefined", async () => {
  const exec = async () => "  999999991 node /x/bin/codex hi\n";
  assert.equal(await tuiRunningIn("/tmp", { platform: "linux", exec }), undefined);
});

test("no Codex process at all: false", async () => {
  const exec = async () => "  1 /sbin/launchd\n";
  assert.equal(await tuiRunningIn("/tmp", { platform: "darwin", exec }), false);
});

test("unsupported platform, or a failing runner: undefined", async () => {
  assert.equal(await tuiRunningIn("/tmp", { platform: "win32" }), undefined);
  assert.equal(await tuiRunningIn("/tmp", { platform: "darwin", exec: async () => Promise.reject(new Error("boom")) }), undefined);
});

test("the real runner with a fake ps on PATH: exit 1 → undefined; hang → undefined after the timeout", async () => {
  const bin = mkdtempSync(join(tmpdir(), "ukagai-tp-bin-"));
  cleanup.push(bin);
  const old = process.env["PATH"];
  try {
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "ps"), 0o755);
    process.env["PATH"] = `${bin}:${old}`;
    assert.equal(await tuiRunningIn("/tmp", { platform: "darwin" }), undefined);
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nexec sleep 30\n");
    const t0 = Date.now();
    assert.equal(await tuiRunningIn("/tmp", { platform: "darwin", timeoutMs: 300 }), undefined);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    process.env["PATH"] = old;
  }
});
