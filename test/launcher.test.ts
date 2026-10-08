import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER_SRC = resolve("bin/ukagai");
const SH = "/bin/sh";

/** A throwaway install tree: <root>/bin/ukagai (the real launcher, with the fixed system node paths removed) + a fake dist/cli.js */
function tree(): { root: string; launcher: string; home: string; tools: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-launcher-"));
  const root = join(dir, "root");
  const home = join(dir, "home");
  const tools = join(dir, "tools");
  for (const d of [join(root, "bin"), join(root, "dist"), home, tools]) mkdirSync(d, { recursive: true });
  // the machine's own /opt/homebrew or /usr/local node must not make "no node" cases find one
  const src = readFileSync(LAUNCHER_SRC, "utf8").replace("/opt/homebrew/bin/node /usr/local/bin/node", "/nonexistent/node");
  assert.ok(src.includes("/nonexistent/node"));
  const launcher = join(root, "bin", "ukagai");
  writeFileSync(launcher, src, { mode: 0o755 });
  writeFileSync(join(root, "dist", "cli.js"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launcher: process.env.UKAGAI_LAUNCHER }));\n");
  for (const t of ["dirname", "readlink", "cat", "tr", "sleep", "timeout"]) {
    for (const d of ["/usr/bin", "/bin", "/opt/homebrew/bin"]) {
      if (existsSync(join(d, t))) {
        symlinkSync(join(d, t), join(tools, t));
        break;
      }
    }
  }
  symlinkSync(SH, join(tools, "sh"));
  return { root, launcher, home, tools, dir };
}

function run(t: ReturnType<typeof tree>, args: string[], o: { env?: Record<string, string>; input?: string; launcher?: string; cwd?: string } = {}) {
  const r = spawnSync(SH, [o.launcher ?? t.launcher, ...args], {
    cwd: o.cwd ?? t.dir,
    input: o.input ?? "",
    encoding: "utf8",
    env: { PATH: t.tools, HOME: t.home, ...o.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A fake node: a script that answers `-p process.versions.node` with `version` and otherwise runs the real node */
function fakeNode(path: string, version: string): string {
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${version}; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

test("direct call: runs dist/cli.js of its own tree with the args", () => {
  const t = tree();
  const r = run(t, ["hook", "--x", "y"], { env: { UKAGAI_NODE: process.execPath } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { argv: ["hook", "--x", "y"], launcher: t.launcher });
});

test("absolute and relative symlink chains resolve the root; UKAGAI_LAUNCHER is the unresolved link", () => {
  const t = tree();
  const abs = join(t.dir, "abs-link");
  symlinkSync(t.launcher, abs);
  const r1 = run(t, ["a"], { launcher: abs, env: { UKAGAI_NODE: process.execPath } });
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(JSON.parse(r1.stdout), { argv: ["a"], launcher: abs });

  // relative target through a second link in another directory: link2 -> ../links/link1 -> ../root/bin/ukagai
  mkdirSync(join(t.dir, "links"));
  mkdirSync(join(t.dir, "other"));
  symlinkSync("../root/bin/ukagai", join(t.dir, "links", "link1"));
  symlinkSync("../links/link1", join(t.dir, "other", "link2"));
  const link2 = join(t.dir, "other", "link2");
  const r2 = run(t, ["b"], { launcher: link2, env: { UKAGAI_NODE: process.execPath } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout), { argv: ["b"], launcher: link2 });

  // invoked by a relative path from another cwd
  const r3 = run(t, ["c"], { launcher: "other/link2", cwd: t.dir, env: { UKAGAI_NODE: process.execPath } });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(JSON.parse(r3.stdout).argv[0], "c");
});

test("UKAGAI_NODE wins over a node on PATH", () => {
  const t = tree();
  const marked = join(t.dir, "marked-node");
  writeFileSync(marked, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo 23.0.0; exit 0; fi\necho marked-node\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(t.tools, "node"));
  const r = run(t, [], { env: { UKAGAI_NODE: marked } });
  assert.equal(r.stdout.trim(), "marked-node");
});

test("a node-path file under UKAGAI_DATA_DIR is used", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  writeFileSync(join(data, "node-path"), process.execPath + "\n");
  const r = run(t, ["v"], { env: { UKAGAI_DATA_DIR: data } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).argv, ["v"]);
});

test("a node-path pointing at an old node is skipped (next candidate wins)", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  writeFileSync(join(data, "node-path"), fakeNode(join(t.dir, "old-node"), "18.0.0") + "\n");
  symlinkSync(process.execPath, join(t.tools, "node"));
  const r = run(t, ["w"], { env: { UKAGAI_DATA_DIR: data } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).argv, ["w"]);
  // and with no other candidate it is not used either
  rmNode(t);
  const r2 = run(t, ["--version"], { env: { UKAGAI_DATA_DIR: data } });
  assert.equal(r2.status, 127);
});

function rmNode(t: ReturnType<typeof tree>): void {
  spawnSync("rm", ["-f", join(t.tools, "node")]);
}

test("known locations: the newest nvm-style node >= 22 is picked", () => {
  const t = tree();
  const base = join(t.home, ".nvm", "versions", "node");
  for (const v of ["v18.19.0", "v22.3.0", "v22.10.1", "v9.9.9"]) {
    mkdirSync(join(base, v, "bin"), { recursive: true });
  }
  fakeNode(join(base, "v18.19.0", "bin", "node"), "18.19.0");
  writeFileSync(join(base, "v22.3.0", "bin", "node"), `#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22.3.0; exit 0; fi\necho v22.3.0\n`, { mode: 0o755 });
  writeFileSync(join(base, "v22.10.1", "bin", "node"), `#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22.10.1; exit 0; fi\necho v22.10.1\n`, { mode: 0o755 });
  fakeNode(join(base, "v9.9.9", "bin", "node"), "9.9.9");
  const r = run(t, []);
  assert.equal(r.stdout.trim(), "v22.10.1");
});

test("no node + hook SessionStart: exit 0 and exactly the one line", () => {
  const t = tree();
  const r = run(t, ["hook"], { input: JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ukagai: Node.js 22 or newer was not found; the ukagai hooks are inactive. Re-run install.sh or set UKAGAI_NODE.\n");
});

test("no node + hook of another event: exit 0 and empty stdout", () => {
  const t = tree();
  const r = run(t, ["hook", "--agent", "codex"], { input: JSON.stringify({ hook_event_name: "PreToolUse" }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("no node + any other command: exit 127 with a message on stderr", () => {
  const t = tree();
  const r = run(t, ["--version"]);
  assert.equal(r.status, 127);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /node \(>= 22\) not found: set UKAGAI_NODE or put node on PATH/);
});

test("no node + pretty-printed SessionStart JSON (spaces around the colon): the same one line", () => {
  const t = tree();
  const r = run(t, ["hook"], { input: '{\n  "session_id": "s",\n  "hook_event_name" : "SessionStart"\n}\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ukagai: Node\.js 22 or newer was not found/);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("a login shell that hangs is cut off after the limit and the launcher falls through (watchdog without `timeout`)", () => {
  const t = tree();
  rmSync(join(t.tools, "timeout"), { force: true }); // force the watchdog branch
  const fakeShell = join(t.dir, "slow-shell");
  writeFileSync(fakeShell, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  const r = run(t, ["hook"], { input: JSON.stringify({ hook_event_name: "SessionStart" }), env: { SHELL: fakeShell } });
  const took = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Node\.js 22 or newer was not found/);
  assert.ok(took < 9000, `took ${took} ms`);
});

test("known locations include fnm's macOS directory (a path with a space)", () => {
  const t = tree();
  const bin = join(t.home, "Library", "Application Support", "fnm", "node-versions", "v22.4.0", "installation", "bin");
  mkdirSync(bin, { recursive: true });
  fakeNode(join(bin, "node"), "22.4.0");
  const r = run(t, ["x"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).argv, ["x"]);
});
