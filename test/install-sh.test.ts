import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL_SH = resolve("install.sh");
const SYSTEM_PATH = "/usr/bin:/bin";

let root: string;
let server: Server;
let base: string;
let requests: string[] = [];
const files = new Map<string, Buffer>();

/**
 * A release tarball whose bin/ukagai is a sh script printing the version read from ../package.json.
 * `install` records its argv; `install --help` mentions --refresh unless UKAGAI_TEST_OLD=1 (an old version);
 * `install` exits 1 when UKAGAI_TEST_FAIL=1.
 */
function addRelease(version: string, o: { corruptSums?: boolean } = {}): void {
  const work = mkdtempSync(join(root, "tar-"));
  const top = join(work, `ukagai-${version}`);
  mkdirSync(join(top, "bin"), { recursive: true });
  writeFileSync(join(top, "package.json"), JSON.stringify({ name: "ukagai", version }) + "\n");
  writeFileSync(
    join(top, "bin", "ukagai"),
    [
      "#!/bin/sh",
      'self=$0; while [ -h "$self" ]; do self=$(readlink "$self"); done',
      'root=$(cd "$(dirname "$self")/.." && pwd)',
      'if [ "${1:-}" = install ] && [ "${2:-}" = --help ]; then',
      '  echo "usage: ukagai install [--timeout <s>] [--force]"',
      '  [ "${UKAGAI_TEST_OLD:-}" = 1 ] || echo "       --refresh   re-register the registered agents"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = install ]; then',
      '  echo "$*" >> "${UKAGAI_TEST_ARGV:-/dev/null}"',
      '  [ "${UKAGAI_TEST_FAIL:-}" != 1 ] || { echo "boom" >&2; exit 1; }',
      "  exit 0",
      "fi",
      "sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' \"$root/package.json\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const tarball = join(work, `ukagai-${version}.tar.gz`);
  const r = spawnSync("tar", ["-czf", tarball, "-C", work, `ukagai-${version}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const buf = readFileSync(tarball);
  const sum = o.corruptSums ? "0".repeat(64) : createHash("sha256").update(buf).digest("hex");
  const sums = Buffer.from(`${sum}  ukagai-${version}.tar.gz\n`);
  files.set(`/download/v${version}/ukagai-${version}.tar.gz`, buf);
  files.set(`/download/v${version}/SHA256SUMS`, sums);
  files.set("/latest/download/SHA256SUMS", sums);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ukagai-installsh-"));
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const f = files.get(req.url ?? "");
    if (!f) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-length": f.length }).end(f);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

interface Env {
  dir: string;
  home: string;
  libdir: string;
  bindir: string;
  datadir: string;
  nodedir: string;
  argv: string;
}

/** A fresh sandbox: HOME, UKAGAI_HOME, UKAGAI_BIN_DIR, UKAGAI_DATA_DIR all under one temp dir; `node` = this node via a symlink */
function sandbox(): Env {
  files.clear();
  requests = [];
  const dir = mkdtempSync(join(root, "env-"));
  const e: Env = {
    dir,
    home: join(dir, "home"),
    libdir: join(dir, "lib"),
    bindir: join(dir, "bin"),
    datadir: join(dir, "data"),
    nodedir: join(dir, "nodebin"),
    argv: join(dir, "argv.log"),
  };
  mkdirSync(e.home, { recursive: true });
  mkdirSync(e.nodedir, { recursive: true });
  symlinkSync(process.execPath, join(e.nodedir, "node"));
  return e;
}

function runInstall(e: Env, args: string[] = [], extra: Record<string, string> = {}, cwd = e.dir): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string> = {
    PATH: `${e.nodedir}:${SYSTEM_PATH}`,
    HOME: e.home,
    UKAGAI_HOME: e.libdir,
    UKAGAI_BIN_DIR: e.bindir,
    UKAGAI_DATA_DIR: e.datadir,
    UKAGAI_BASE_URL: base,
    UKAGAI_PORT: "1", // the server probed while pruning: a closed port, never the real 4818
    UKAGAI_TEST_ARGV: e.argv,
    ...extra,
  };
  return new Promise((res) => {
    execFile("/bin/sh", [INSTALL_SH, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 }, (err, out, errOut) => {
      res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out, err: errOut });
    });
  });
}

const versions = (e: Env): string[] => (existsSync(join(e.libdir, "versions")) ? readdirSync(join(e.libdir, "versions")).sort() : []);

const argvLines = (e: Env): string[] => (existsSync(e.argv) ? readFileSync(e.argv, "utf8").split("\n").filter(Boolean) : []);

test("fresh install: symlink to the version, node-path (absolute, resolved), --version smoke, no Next: lines", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const r = await runInstall(e);
  assert.equal(r.code, 0, r.err);
  const link = join(e.bindir, "ukagai");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), join(e.libdir, "versions", "1.0.0", "bin", "ukagai"));
  assert.equal(readFileSync(join(e.datadir, "node-path"), "utf8").trim(), realpathSync(process.execPath));
  const v = spawnSync(link, ["--version"], { encoding: "utf8", env: { PATH: SYSTEM_PATH, HOME: e.home } });
  assert.equal(v.stdout.trim(), "1.0.0");
  assert.doesNotMatch(r.err, /Next:/);
  assert.match(r.err, /not on your PATH/);
});

test("second run: already installed, and the tarball is not downloaded again", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  assert.equal((await runInstall(e)).code, 0);
  requests = [];
  const r = await runInstall(e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /already installed/);
  assert.deepEqual(requests, ["/latest/download/SHA256SUMS"]);
});

test("corrupted SHA256SUMS: exit 1 and nothing is left in versions/", async () => {
  const e = sandbox();
  addRelease("1.0.0", { corruptSums: true });
  const r = await runInstall(e);
  assert.equal(r.code, 1);
  assert.match(r.err, /checksum mismatch/);
  assert.deepEqual(versions(e), []);
  assert.equal(existsSync(join(e.bindir, "ukagai")), false);
});

test("a foreign regular file at the bin path: exit 1 before any download; --force replaces it", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  mkdirSync(e.bindir, { recursive: true });
  const link = join(e.bindir, "ukagai");
  writeFileSync(link, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const r = await runInstall(e);
  assert.equal(r.code, 1);
  assert.match(r.err, /not ours \(use --force\)/);
  assert.deepEqual(requests, [], "nothing was requested from the mirror");
  assert.equal(existsSync(join(e.libdir, "versions")), false);
  assert.equal(existsSync(join(e.datadir, "node-path")), false);
  assert.equal(readFileSync(link, "utf8"), "#!/bin/sh\necho mine\n");

  const f = await runInstall(e, ["--force"]);
  assert.equal(f.code, 0, f.err);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(versions(e), ["1.0.0"]);
});

test("UKAGAI_NODE pointing at a Node 18: exit 1 with the Node message, before any download", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const old = join(e.dir, "node18");
  writeFileSync(old, "#!/bin/sh\necho 18.0.0\n", { mode: 0o755 });
  const r = await runInstall(e, [], { UKAGAI_NODE: old });
  assert.equal(r.code, 1);
  assert.match(r.err, /Node\.js 22 or newer is required \(found: 18\.0\.0\)/);
  assert.deepEqual(requests, []);
});

test("a relative UKAGAI_NODE is recorded as an absolute path", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  symlinkSync(process.execPath, join(e.dir, "mynode"));
  const r = await runInstall(e, [], { UKAGAI_NODE: "./mynode" });
  assert.equal(r.code, 0, r.err);
  const recorded = readFileSync(join(e.datadir, "node-path"), "utf8").trim();
  assert.ok(recorded.startsWith("/"), recorded);
  assert.equal(recorded, realpathSync(process.execPath));
});

test("first install runs `ukagai install --data-dir <dir>`; a non-default UKAGAI_DATA_DIR is forwarded", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const r = await runInstall(e);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvLines(e), [`install --data-dir ${e.datadir}`]);
});

test("the default data dir ($HOME/.ukagai) is not forwarded", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const r = await runInstall(e, [], { UKAGAI_DATA_DIR: join(e.home, ".ukagai") });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvLines(e), ["install"]);
});

test("a second run (same version) and an upgrade run `ukagai install --refresh --data-dir <dir>`", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  addRelease("1.1.0");
  assert.equal((await runInstall(e, ["--version", "1.0.0"])).code, 0);
  assert.equal((await runInstall(e, ["--version", "1.0.0"])).code, 0);
  const up = await runInstall(e, ["--version", "1.1.0"]);
  assert.equal(up.code, 0, up.err);
  assert.deepEqual(argvLines(e), [
    `install --data-dir ${e.datadir}`,
    `install --refresh --data-dir ${e.datadir}`,
    `install --refresh --data-dir ${e.datadir}`,
  ]);
  assert.match(up.err, /upgraded 1\.0\.0 -> 1\.1\.0/);
});

test("a version whose `install --help` lacks --refresh registers nothing and prints the hint", async () => {
  const e = sandbox();
  addRelease("0.1.0");
  const r = await runInstall(e, [], { UKAGAI_TEST_OLD: "1" });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvLines(e), []);
  assert.match(r.err, /registers hooks with: ukagai install --claude \/ --codex/);
  assert.ok(lstatSync(join(e.bindir, "ukagai")).isSymbolicLink());
});

test("a failing `ukagai install` is a warning naming the command; exit 0 and the upgrade note still appear", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  addRelease("1.1.0");
  const first = await runInstall(e, ["--version", "1.0.0"], { UKAGAI_TEST_FAIL: "1" });
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /boom/);
  assert.match(first.err, new RegExp(`warning: hook registration failed; fix the above and run: ukagai install --data-dir ${e.datadir}`));
  assert.match(first.err, /ukagai 1\.0\.0 installed/);

  const up = await runInstall(e, ["--version", "1.1.0"], { UKAGAI_TEST_FAIL: "1" });
  assert.equal(up.code, 0, up.err);
  assert.match(up.err, new RegExp(`run: ukagai install --refresh --data-dir ${e.datadir}`));
  assert.match(up.err, /upgraded 1\.0\.0 -> 1\.1\.0/);
});

for (const args of [["--lang", "ja"], ["--lang=ja"], ["--lang", "--force"], ["--codex"], ["--claude"], ["--lang", "ja", "--codex", "--claude"]]) {
  test(`old flag ${args.join(" ")}: a warning, ignored; install goes on with no extra arguments`, async () => {
    const e = sandbox();
    addRelease("1.0.0");
    const r = await runInstall(e, args);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /warning: --(lang|codex|claude) is ignored/);
    assert.deepEqual(argvLines(e), [`install --data-dir ${e.datadir}`]);
  });
}

test("`--lang --force`: --force is still honoured (the value is not swallowed when it starts with -)", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  mkdirSync(e.bindir, { recursive: true });
  const link = join(e.bindir, "ukagai");
  writeFileSync(link, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const r = await runInstall(e, ["--lang", "--force"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(lstatSync(link).isSymbolicLink());
});

test("an unknown argument: usage and exit 2, nothing downloaded", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const r = await runInstall(e, ["--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: install\.sh/);
  assert.deepEqual(requests, []);
});

test("an unwritable data dir is a warning, not a failure", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const blocker = join(e.dir, "blocker");
  writeFileSync(blocker, "a file, not a directory");
  const r = await runInstall(e, [], { UKAGAI_DATA_DIR: join(blocker, "data") });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: cannot create/);
  assert.ok(lstatSync(join(e.bindir, "ukagai")).isSymbolicLink());
});

test("prune keeps the current and the previous version, removes an older one; a young *.tmp is left alone, an old one goes", async () => {
  const e = sandbox();
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) addRelease(v);
  assert.equal((await runInstall(e, ["--version", "1.0.0"])).code, 0);
  assert.equal((await runInstall(e, ["--version", "1.1.0"])).code, 0);
  const young = join(e.libdir, "versions", "9.9.9.tmp");
  const old = join(e.libdir, "versions", "8.8.8.tmp");
  mkdirSync(young);
  mkdirSync(old);
  const longAgo = new Date(Date.now() - 3600_000);
  utimesSync(old, longAgo, longAgo);
  const r = await runInstall(e, ["--version", "1.2.0"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(versions(e), ["1.1.0", "1.2.0", "9.9.9.tmp"]);
  assert.match(r.err, /upgraded 1\.1\.0 -> 1\.2\.0/);
});

test("--help prints the usage to stdout (exit 0): only --version and --force, and where the language is set", async () => {
  const e = sandbox();
  const r = await runInstall(e, ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: install\.sh \[--version vX\.Y\.Z\] \[--force\]/);
  assert.doesNotMatch(r.out, /--codex|--claude|--lang +/);
  assert.match(r.out, /Settings page/);
  assert.match(r.out, /real ~\/\.claude and ~\/\.codex/);
  assert.deepEqual(requests, []);
});

test("the sandbox never reached the real home: nothing outside the temp dir was needed", async () => {
  // a guard on the test itself: every location install.sh uses is under the sandbox
  const e = sandbox();
  addRelease("1.0.0");
  chmodSync(e.home, 0o755);
  const r = await runInstall(e);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(e.home), [], "HOME stays empty: install.sh wrote only to the UKAGAI_* locations");
  rmSync(e.dir, { recursive: true, force: true });
});
