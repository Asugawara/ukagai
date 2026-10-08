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

/** A release tarball whose bin/ukagai is a sh script printing the version read from ../package.json (and recording `install` argv) */
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
      'if [ "${1:-}" = install ]; then echo "$*" >> "${UKAGAI_TEST_ARGV:-/dev/null}"; exit 0; fi',
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

test("fresh install: symlink to the version, node-path (absolute, resolved), --version smoke, Next: hint", async () => {
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
  assert.match(r.err, /Next:/);
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

test("--lang ja with UKAGAI_DATA_DIR set: `ukagai install --lang ja --data-dir <dir>` is run", async () => {
  const e = sandbox();
  addRelease("1.0.0");
  const r = await runInstall(e, ["--lang", "ja"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(e.argv, "utf8").trim(), `install --lang ja --data-dir ${e.datadir}`);
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

test("--help prints the usage to stdout (exit 0) and says --codex is Codex only", async () => {
  const e = sandbox();
  const r = await runInstall(e, ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: install\.sh/);
  assert.match(r.out, /--codex +register the Codex CLI hooks \(Codex only; add --claude for Claude Code too\)/);
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
