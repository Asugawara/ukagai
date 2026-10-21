import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDenied, SOURCE_LINE_MAX } from "../../src/serve/source.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ukagai-source-")));
  roots.push(d);
  return d;
};
const put = (path: string, body: Buffer | string): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const numbered = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

/** A server with one decision whose session runs in `<repo>/app` (the repository root is `<repo>`) */
async function env() {
  const home = tmp();
  const dataDir = tmp();
  const repo = tmp();
  const cwd = join(repo, "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const seed = async (sessionCwd: string, n: string): Promise<string> => {
    const res = await fetch(url + "/api/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tool_use_id: `tu-src-${n}`,
        kind: "approve_plan",
        session: { session_id: `sess-${n}`, cwd: sessionCwd, transcript_path: join(home, ".claude", "projects", "p", `sess-${n}.jsonl`) },
        request: { plan: "# P\n", planFilePath: "/p/plan.md" },
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return ((await res.json()) as { id: string }).id;
  };
  const id = await seed(cwd, "a");
  const get = (q: string, auth = true) => fetch(`${url}/api/source?${q}`, { headers: auth ? { authorization: `Bearer ${h.token}` } : {} });
  const src = (path: string, line: string | number = 1, extra = "", who = id, auth = true) => get(`decision=${who}&path=${encodeURIComponent(path)}&line=${line}${extra}`, auth);
  return { repo, cwd, id, seed, get, src };
}

const NOT_FOUND = { error: "not found" };

test("reads around the line: relative to the cwd, then to the repository root; headers", async () => {
  const e = await env();
  put(join(e.cwd, "mod.py"), numbered(30));
  put(join(e.repo, "top", "deep", "a.ts"), numbered(30));
  const r = await e.src("mod.py", 12);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await r.json(), { path: "app/mod.py", start: 7, end: 17, hit: [12, 12], total: 30, lines: Array.from({ length: 11 }, (_, i) => `line ${i + 7}`) });
  // not under the cwd: found from the repository root
  const top = (await (await e.src("top/deep/a.ts", 2)).json()) as { path: string; start: number; end: number; hit: number[] };
  assert.deepEqual([top.path, top.start, top.end, top.hit], ["top/deep/a.ts", 1, 7, [2, 2]]);
  // an absolute path inside the root is as good as a relative one
  assert.equal((await e.src(join(e.repo, "top", "deep", "a.ts"), 30)).status, 200);
});

test("a range shows exactly that range, at most 40 lines; lines past the end are cut; CRLF and long lines", async () => {
  const e = await env();
  put(join(e.cwd, "big.txt"), numbered(100));
  const a = (await (await e.src("big.txt", 10, "&end=20")).json()) as { start: number; end: number; hit: number[]; lines: string[] };
  assert.deepEqual([a.start, a.end, a.hit, a.lines.length], [10, 20, [10, 20], 11]);
  const b = (await (await e.src("big.txt", 10, "&end=90")).json()) as { start: number; end: number; hit: number[]; lines: string[] };
  assert.deepEqual([b.start, b.end, b.hit, b.lines.length], [10, 49, [10, 49], 40]);
  const c = (await (await e.src("big.txt", 98, "&end=120")).json()) as { end: number; hit: number[] };
  assert.deepEqual([c.end, c.hit], [100, [98, 100]]);
  const first = (await (await e.src("big.txt", 1)).json()) as { start: number; end: number };
  assert.deepEqual([first.start, first.end], [1, 6]);
  put(join(e.cwd, "crlf.txt"), "a\r\nb\r\nc\r\n");
  const crlf = (await (await e.src("crlf.txt", 2)).json()) as { total: number; lines: string[] };
  assert.deepEqual([crlf.total, crlf.lines], [3, ["a", "b", "c"]]);
  put(join(e.cwd, "wide.txt"), "x".repeat(SOURCE_LINE_MAX + 50) + "\n");
  const wide = (await (await e.src("wide.txt", 1)).json()) as { lines: string[] };
  assert.equal(wide.lines[0], "x".repeat(SOURCE_LINE_MAX) + "…");
});

test("a line beyond the end of the file is 404", async () => {
  const e = await env();
  put(join(e.cwd, "short.txt"), numbered(3));
  assert.equal((await e.src("short.txt", 3)).status, 200);
  const r = await e.src("short.txt", 4);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), NOT_FOUND);
  assert.equal((await e.src("short.txt", 4, "&end=9")).status, 404);
  put(join(e.cwd, "empty.txt"), "");
  assert.equal((await e.src("empty.txt", 1)).status, 404);
});

test("escapes are 404: ../, an absolute path outside the root, a symlink out of the root", async () => {
  const e = await env();
  const outside = tmp();
  put(join(outside, "secret.txt"), numbered(5));
  put(join(e.repo, "..", `ukagai-sibling-${process.pid}.txt`), numbered(5));
  roots.push(join(e.repo, "..", `ukagai-sibling-${process.pid}.txt`));
  symlinkSync(join(outside, "secret.txt"), join(e.cwd, "link.txt"));
  symlinkSync(outside, join(e.cwd, "linkdir"));
  for (const p of ["../../secret.txt", `../../ukagai-sibling-${process.pid}.txt`, "../../../../../../../../etc/hosts", join(outside, "secret.txt"), "/etc/hosts", "link.txt", "linkdir/secret.txt"]) {
    const r = await e.src(p, 1);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), NOT_FOUND, p);
  }
  // a symlink that stays inside the root is fine
  put(join(e.repo, "real.txt"), numbered(5));
  symlinkSync(join(e.repo, "real.txt"), join(e.cwd, "inside.txt"));
  assert.equal((await e.src("inside.txt", 1)).status, 200);
});

test("secrets and repository internals are 404, also behind a symlink; examples are readable", async () => {
  const e = await env();
  for (const p of [".env", ".env.local", "app/.env.production", ".git/config", ".git/HEAD", "sub/.ssh/id_rsa", ".aws/credentials", ".gnupg/pubring.kbx", ".npmrc", ".netrc", "k/server.pem", "k/server.KEY", "k/a.p12", "k/a.pfx", "k/id_rsa", "k/id_rsa.pub", "k/id_ed25519", "k/ID_ED25519"]) {
    put(join(e.repo, p), numbered(3));
    const r = await e.src(p, 1);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), NOT_FOUND, p);
  }
  put(join(e.cwd, "link-to-env.txt"), "");
  symlinkSync(join(e.repo, ".env"), join(e.cwd, "env-link.txt"));
  symlinkSync(join(e.repo, ".git"), join(e.cwd, "gitlink"));
  assert.equal((await e.src("env-link.txt", 1)).status, 404, "the real file is .env");
  assert.equal((await e.src("gitlink/config", 1)).status, 404, "the real file is under .git");
  put(join(e.repo, ".env.example"), numbered(3));
  put(join(e.repo, ".env.sample"), numbered(3));
  assert.equal((await e.src(".env.example", 1)).status, 200);
  assert.equal((await e.src(".env.sample", 1)).status, 200);
  assert.equal(isDenied("a/.env"), true);
  assert.equal(isDenied("environment.ts"), false);
});

test("binary files, files over 2 MB, directories, and NUL in the path are 404", async () => {
  const e = await env();
  put(join(e.cwd, "bin.dat"), Buffer.concat([Buffer.from("abc\n"), Buffer.from([0, 1, 2]), Buffer.from("\ndef\n")]));
  put(join(e.cwd, "huge.txt"), "x\n".repeat(1024 * 1024 + 10));
  mkdirSync(join(e.cwd, "dir"));
  put(join(e.cwd, "edge.txt"), "x".repeat(2 * 1024 * 1024 - 1) + "\n");
  for (const p of ["bin.dat", "huge.txt", "dir", ".", "app", "nope.txt", ""]) assert.equal((await e.src(p, 1)).status, 404, p);
  assert.equal((await e.src("edge.txt", 1)).status, 200, "exactly 2 MB is still read");
  assert.equal((await e.get(`decision=${e.id}&path=${encodeURIComponent("mod.py\0")}&line=1`)).status, 404);
  assert.equal((await e.get(`decision=${e.id}&path=mod.py%00.txt&line=1`)).status, 404);
  assert.equal((await e.get(`decision=${e.id}&line=1`)).status, 404, "no path");
});

test("a bad line or end is 400", async () => {
  const e = await env();
  put(join(e.cwd, "a.txt"), numbered(10));
  for (const q of ["line=0", "line=-1", "line=abc", "line=1.5", "line=", "line=99999999", "line=1e3"]) assert.equal((await e.get(`decision=${e.id}&path=a.txt&${q}`)).status, 400, q);
  assert.equal((await e.get(`decision=${e.id}&path=a.txt`)).status, 400, "no line");
  for (const x of ["end=abc", "end=3", "end=-4", "end="]) assert.equal((await e.src("a.txt", 5, `&${x}`)).status, 400, x);
  assert.equal((await e.src("a.txt", 5, "&end=5")).status, 200);
});

test("a decision that cannot be resolved is 404: unknown id, no decision, an empty cwd; a cwd without .git is its own root", async () => {
  const e = await env();
  put(join(e.cwd, "a.txt"), numbered(3));
  assert.equal((await e.src("a.txt", 1, "", "no-such-decision")).status, 404);
  assert.equal((await e.get(`path=a.txt&line=1`)).status, 404, "no decision");
  const noCwd = await e.seed("", "nocwd");
  assert.equal((await e.src("a.txt", 1, "", noCwd)).status, 404);
  // a cwd that holds no .git: its own directory is the root
  const plain = tmp();
  put(join(plain, "p.txt"), numbered(3));
  const other = await e.seed(plain, "plain");
  assert.equal((await e.src("p.txt", 1, "", other)).status, 200);
  assert.equal((await e.src("../a.txt", 1, "", other)).status, 404);
});

test("authorization: no credential is 401, before the 400", async () => {
  const e = await env();
  put(join(e.cwd, "a.txt"), numbered(3));
  const r = await e.src("a.txt", 1, "", e.id, false);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "unauthorized" });
  assert.equal((await e.src("../x", 0, "", e.id, false)).status, 401, "401 comes before the 400");
});
