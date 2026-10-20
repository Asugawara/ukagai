import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LAUNCHER_SRC = resolve("bin/ukagai");
const SH = "/bin/sh";

/** A throwaway install tree: <root>/bin/ukagai (the real launcher, with the fixed system node paths removed) + a fake dist/cli.js */
function tree(): { root: string; launcher: string; home: string; tools: string; dir: string; noShell: string } {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-launcher-"));
  const root = join(dir, "root");
  const home = join(dir, "home");
  const tools = join(dir, "tools");
  for (const d of [join(root, "bin"), join(root, "dist"), home, tools]) mkdirSync(d, { recursive: true });
  // The launcher's last resort is `$SHELL -lc 'command -v node'`. bash (macOS /bin/sh) sets SHELL to the user's login
  // shell when the environment has none, and a login shell on a CI runner finds the machine's node; a fake SHELL that
  // prints nothing keeps the "no node" cases deterministic (the fallback itself is tested with its own fake shell).
  const noShell = join(dir, "noshell");
  writeFileSync(noShell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // the machine's own /opt/homebrew or /usr/local node must not make "no node" cases find one
  const src = readFileSync(LAUNCHER_SRC, "utf8").replace("/opt/homebrew/bin/node /usr/local/bin/node", "/nonexistent/node");
  assert.ok(src.includes("/nonexistent/node"));
  const launcher = join(root, "bin", "ukagai");
  writeFileSync(launcher, src, { mode: 0o755 });
  writeFileSync(join(root, "dist", "cli.js"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launcher: process.env.UKAGAI_LAUNCHER }));\n");
  for (const t of ["dirname", "readlink", "cat", "tr", "sleep", "timeout", "find", "mv", "rm", "ls", "dd"]) {
    for (const d of ["/usr/bin", "/bin", "/opt/homebrew/bin"]) {
      if (existsSync(join(d, t))) {
        symlinkSync(join(d, t), join(tools, t));
        break;
      }
    }
  }
  symlinkSync(SH, join(tools, "sh"));
  return { root, launcher, home, tools, dir, noShell };
}

function run(t: ReturnType<typeof tree>, args: string[], o: { env?: Record<string, string>; input?: string; launcher?: string; cwd?: string } = {}) {
  const r = spawnSync(SH, [o.launcher ?? t.launcher, ...args], {
    cwd: o.cwd ?? t.dir,
    input: o.input ?? "",
    encoding: "utf8",
    env: { PATH: t.tools, HOME: t.home, SHELL: t.noShell, ...o.env },
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

/**
 * A fake node that counts its version probes in <path>.probes. The file starts with a blank line, not "#!": the launcher
 * never notes a script (it may be a shim), and the shell still runs a file without a shebang as a script.
 */
function countingNode(where: string, version: string): string {
  // the launcher only notes a file named node: a name that does not end in /node is made a directory holding one
  const path = basename(where) === "node" ? where : join(where, "node");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `\n#!/bin/sh\nif [ "$1" = "-p" ]; then echo probe >>"${path}.probes"; echo ${version}; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}
const probes = (node: string): number => (existsSync(`${node}.probes`) ? readFileSync(`${node}.probes`, "utf8").trim().split("\n").length : 0);

test("fast path: the first run probes the cached node once and notes it; later runs exec it with no probe", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "cached-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  for (let i = 0; i < 3; i++) {
    const r = run(t, ["hook", String(i)], { env: { UKAGAI_DATA_DIR: data } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).argv, ["hook", String(i)]);
  }
  assert.equal(probes(node), 1);
  assert.equal(readFileSync(join(data, "node-ok"), "utf8").split("\n")[0], node);
});

test("fast path: UKAGAI_NODE is noted too", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "env-node"), "23.0.0");
  for (let i = 0; i < 2; i++) assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data, UKAGAI_NODE: node } }).status, 0);
  assert.equal(probes(node), 1);
});

test("fast path: a note for another path is ignored (node-path changed)", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const a = countingNode(join(t.dir, "node-a"), "22.1.0");
  const b = countingNode(join(t.dir, "node-b"), "22.2.0");
  writeFileSync(join(data, "node-path"), a + "\n");
  run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
  writeFileSync(join(data, "node-path"), b + "\n");
  const r = run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(probes(b), 1);
  assert.equal(readFileSync(join(data, "node-ok"), "utf8").split("\n")[0], b);
});

test("fail-open: a noted node that was deleted or made non-executable makes hook print nothing and exit 0", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "gone-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
  chmodSync(node, 0o644);
  const input = JSON.stringify({ hook_event_name: "PreToolUse" });
  for (const step of ["not executable", "deleted"]) {
    if (step === "deleted") rmSync(node);
    const r = run(t, ["hook", "--checkpoint"], { env: { UKAGAI_DATA_DIR: data }, input });
    assert.equal(r.status, 0, step);
    assert.equal(r.stdout, "", step);
  }
  const start = run(t, ["hook"], { env: { UKAGAI_DATA_DIR: data }, input: JSON.stringify({ hook_event_name: "SessionStart" }) });
  assert.match(start.stdout, /Node\.js 22 or newer was not found/);
});

test("fast path: the hot path starts one node and no sleep / watchdog", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "hot-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
  // a `sleep` / `timeout` that leaves a trace would show up when the hot path used them
  for (const tool of ["sleep", "timeout"]) {
    rmSync(join(t.tools, tool), { force: true });
    writeFileSync(join(t.tools, tool), `#!/bin/sh\necho ${tool} >>"${t.dir}/spawned"\nexit 1\n`, { mode: 0o755 });
  }
  const r = run(t, ["y"], { env: { UKAGAI_DATA_DIR: data } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(t.dir, "spawned")), false);
  assert.equal(probes(node), 1);
});

const PRE = JSON.stringify({ hook_event_name: "PreToolUse" });
const noted = (data: string): string[] => readFileSync(join(data, "node-ok"), "utf8").split("\n");

test("fast path: the note holds the path and a fingerprint (real path + ls line)", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "fp-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
  const [path, fp] = noted(data);
  assert.equal(path, node);
  assert.ok(fp.startsWith(node + " "), fp);
});

test("fast path: a symlink retargeted to an older node with an older mtime is probed again and rejected (hook silent, exit 0)", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const long = new Date(Date.now() - 365 * 86_400_000);
  mkdirSync(join(t.dir, "v22"));
  mkdirSync(join(t.dir, "v18"));
  const n22 = countingNode(join(t.dir, "v22", "node"), "22.5.0");
  const n18 = countingNode(join(t.dir, "v18", "node"), "18.0.0");
  utimesSync(n18, long, long);
  const link = join(t.dir, "node-link");
  symlinkSync(n22, link);
  writeFileSync(join(data, "node-path"), link + "\n");
  assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
  assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
  assert.equal(probes(n22), 1);
  rmSync(link);
  symlinkSync(n18, link); // brew link --overwrite style: the old target keeps its old mtime
  const r = run(t, ["hook", "--checkpoint"], { env: { UKAGAI_DATA_DIR: data }, input: PRE });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(probes(n18), 1);
});

test("fast path: a node replaced in place by an older one with an older mtime is probed again and rejected", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "inplace-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
  countingNode(node, "18.0.0");
  const long = new Date(Date.now() - 365 * 86_400_000);
  utimesSync(node, long, long);
  const r = run(t, ["hook", "--checkpoint"], { env: { UKAGAI_DATA_DIR: data }, input: PRE });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(probes(node), 2);
});

test("fast path: a note older than a day is probed again once, then fast again", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = countingNode(join(t.dir, "aged-node"), "22.5.0");
  writeFileSync(join(data, "node-path"), node + "\n");
  const go = () => assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
  go();
  go();
  assert.equal(probes(node), 1);
  const old = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(join(data, "node-ok"), old, old);
  go();
  assert.equal(probes(node), 2);
  go();
  go();
  assert.equal(probes(node), 2);
});

test("fast path: a shim (script path, /shims/ directory, volta-shim symlink) is probed on every call and never noted", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  mkdirSync(join(t.dir, "shims"));
  const shimScript = join(t.dir, "shims", "node");
  writeFileSync(shimScript, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo probe >>"${shimScript}.probes"; echo 22.5.0; exit 0; fi\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const shimsDir = join(t.dir, "x", "shims");
  mkdirSync(shimsDir, { recursive: true });
  const inShims = countingNode(join(shimsDir, "node"), "22.5.0"); // not a script, named node: only the directory rules it out
  const volta = join(t.dir, "volta-shim");
  const voltaCounter = countingNode(join(t.dir, "volta-dir", "node"), "22.5.0"); // probes are logged next to this path
  renameSync(voltaCounter, volta);
  const voltaLink = join(t.dir, "node");
  symlinkSync(volta, voltaLink);
  for (const [shim, counter] of [
    [shimScript, shimScript],
    [inShims, inShims],
    [voltaLink, voltaCounter],
  ] as const) {
    writeFileSync(join(data, "node-path"), shim + "\n");
    for (let i = 0; i < 3; i++) assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
    assert.equal(probes(counter), 3, shim);
    assert.equal(existsSync(join(data, "node-ok")), false, shim);
  }
});

test("fast path: a script named node is never noted even when nothing else marks it as a shim", () => {
  const t = tree();
  const data = join(t.dir, "data");
  mkdirSync(data);
  const node = join(t.dir, "node");
  writeFileSync(node, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo probe >>"${node}.probes"; echo 22.5.0; exit 0; fi\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(data, "node-path"), node + "\n");
  for (let i = 0; i < 2; i++) assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
  assert.equal(probes(node), 2);
});

test("fast path: when find (or ls) is missing the note is not trusted and the node is probed", () => {
  for (const tool of ["find", "ls"]) {
    const t = tree();
    const data = join(t.dir, "data");
    mkdirSync(data);
    const node = countingNode(join(t.dir, `no-${tool}-node`), "22.5.0");
    writeFileSync(join(data, "node-path"), node + "\n");
    run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } });
    assert.equal(probes(node), 1);
    rmSync(join(t.tools, tool));
    for (let i = 0; i < 2; i++) assert.equal(run(t, ["x"], { env: { UKAGAI_DATA_DIR: data } }).status, 0);
    assert.equal(probes(node), 3, tool);
  }
});
