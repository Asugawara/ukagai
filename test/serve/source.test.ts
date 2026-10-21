import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, renameSync, unlinkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDenied, readLines, readSource, SOURCE_LINE_MAX } from "../../src/serve/source.js";
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
async function env(dataIn?: (repo: string) => string) {
  const home = tmp();
  const repo = tmp();
  const dataDir = dataIn ? dataIn(repo) : tmp();
  mkdirSync(dataDir, { recursive: true });
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
  return { home, dataDir, repo, cwd, id, seed, get, src, url };
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
  // a lone CR is not a line break (git and the agent's Read tool count the same way); only one trailing CR per line is dropped
  put(join(e.cwd, "cr.txt"), "x = '\r'\r\ny\r\n");
  const cr = (await (await e.src("cr.txt", 1)).json()) as { total: number; lines: string[] };
  assert.deepEqual([cr.total, cr.lines], [2, ["x = '\r'", "y"]]);
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
  // `../../secret.txt` from <repo>/app is <tmp>/secret.txt: it must exist, or the 404 below would prove nothing
  put(join(e.repo, "..", "secret.txt"), numbered(5));
  roots.push(join(e.repo, "..", "secret.txt"));
  symlinkSync(join(outside, "secret.txt"), join(e.cwd, "link.txt"));
  symlinkSync(outside, join(e.cwd, "linkdir"));
  assert.equal(realpathSync(join(e.cwd, "..", "..", "secret.txt")).length > 0, true);
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

/** (name, refused): the name rules and the dot-segment rule, on a path relative to the project root */
const NAMES: Array<[string, boolean]> = [
  [".env", true], [".env.local", true], [".env-prod", true], [".env_local", true], [".envrc", true], ["db.env", true], ["prod.env", true], [".dev.vars", true],
  [".env.example", false], [".env.sample", false], [".env.local.example", false], [".env.prod.sample", false],
  ["credentials.json", true], ["service-account.json", true], ["service-account-prod.json", true], ["secrets.yaml", true], ["secrets.json", true], ["my-credentials.yml", true], ["credentials", true],
  ["credentials.ts", false], ["secrets.py", false], ["secret_santa.md", false], ["credential-store.go", false],
  ["app.keystore", true], ["release.jks", true], ["vault.kdbx", true], ["a.pem", true], ["a.KEY", true], ["a.p12", true], ["a.pfx", true],
  ["terraform.tfstate", true], ["terraform.tfstate.backup", true], ["prod.tfvars", true], ["kubeconfig", true], [".htpasswd", true], [".vault-token", true], ["local.properties", true],
  ["id_rsa", true], ["id_rsa.pub", true], ["id_ed25519", true], ["id_ecdsa", true], ["id_dsa", true], ["ID_RSA", true], ["id_rſa", true],
  [".npmrc", true], [".netrc", true], [".pypirc", true], [".pgpass", true], [".git-credentials", true], [".yarnrc.yml", true], [".zsh_history", true], [".bash_history", true],
  [".git", true], [".git/config", true], [".GIT/HEAD", true], [".ssh/config", true], [".awſ/credentials", true], [".aws/credentials", true], [".gnupg/gpg.conf", true], [".hidden/notes.txt", true],
  [".github/workflows/ci.yml", false], [".gitlab/ci.md", false], [".circleci/config.yml", false], [".vscode/settings.json", false], [".devcontainer/devcontainer.json", false],
  [".husky/pre-commit", false], [".changeset/config.json", false], [".storybook/main.ts", false], [".claude/settings.md", false],
  [".gitignore", false], [".gitattributes", false], [".editorconfig", false], [".nvmrc", false], [".node-version", false], [".tool-versions", false], [".eslintrc.json", false], [".prettierrc", false],
  ["secrets/prod.yaml", true], ["credentials/gcp.json", true], ["config/secrets/database.yml", true], ["k8s/secret/db.yaml", true], ["internal/secrets/vault.go", false], ["docs/secrets.mdx", false],
  ["scripts/rotate-credentials.sh", false], ["credentials.sh", false], ["credentials.mts", false], ["notes/credentials.txt", false],
  [".github/workflows/secrets-check.yml", false], [".github/workflows/credentials/deploy.yml", false],
  ["env.local", true], ["production.env.local", true], ["app.env.bak", true], ["config/env.yaml", true], ["src/env.ts", false], ["src/env.py", false], ["config.env.example", false], ["prod.env.template", false],
  [".claude/settings.local.json", true], [".claude/settings.json", false], [".claude/skills/x/SKILL.md", false],
  ["id_utils.ts", false], ["src/id_token.ts", false], ["id_rsa.bak", true], ["id_ed25519.pub", true], ["id_custom", true], ["id_custom.pub", true],
  [".gitlab-ci.yml", false], [".pre-commit-config.yaml", false], [".dockerignore", false], [".npmignore", false], [".gitmodules", false], [".python-version", false], [".ruby-version", false],
  [".release-please-manifest.json", false], [".gitleaks.toml", false], [".babelrc", false], [".babelrc.json", false], [".stylelintrc", false], [".markdownlint.json", false], [".golangci.yml", false], [".golangci.yaml", false], [".rubocop.yml", false],
  [".agents/skills/x.md", false], [".claude-plugin/plugin.json", false], [".cursor/rules/a.mdc", false],
  ["src/environment.ts", false], ["src/identity.ts", false], ["README.md", false], ["src/deep/nested/dir/articles.py", false], ["Makefile", false],
];

test("the name rules: every name of the table is refused or allowed as listed (also behind a folder)", () => {
  for (const [name, refused] of NAMES) {
    assert.equal(isDenied(name), refused, name);
    assert.equal(isDenied(`pkg/sub/${name}`), refused, `pkg/sub/${name}`);
  }
  // an absolute path is judged without the dot-segment rule: the repository may live under ~/.herdr/worktrees
  assert.equal(isDenied("/Users/x/.herdr/worktrees/p/src/a.ts", false), false);
  assert.equal(isDenied("/Users/x/.herdr/worktrees/p/src/a.ts", true), true);
  assert.equal(isDenied("/Users/x/.herdr/worktrees/p/.env", false), true);
  assert.equal(isDenied("/Users/x/.herdr/worktrees/p/.git/config", false), true);
});

test("the table holds over HTTP too: files that exist are refused, source files named like secrets are served", async () => {
  const e = await env();
  const put1 = (p: string) => put(join(e.repo, p), numbered(3));
  for (const [name, refused] of NAMES) {
    if (name === ".git" || name === "credentials" || name.includes("ſ")) continue; // `credentials` is also a folder of another row; the others are the unit table only
    put1(name);
    assert.equal((await e.src(name, 1)).status, refused ? 404 : 200, name);
  }
});

test("the Unicode fold: a spelling that macOS folds onto a denied name is refused (the real path is judged, in NFKC)", async () => {
  const e = await env();
  put(join(e.repo, ".aws", "credentials"), numbered(3));
  put(join(e.repo, "k", "id_rsa"), numbered(3));
  for (const p of [".awſ/credentials", "k/id_rſa", ".AWS/credentials", "k/ID_RSA", "K/id_rsa"]) assert.equal((await e.src(p, 1)).status, 404, p);
  assert.equal(isDenied(".awſ/credentials"), true);
  assert.equal(isDenied("k/id_rſa"), true);
});

test("a repository at the home directory does not widen the root: the session's directory is the root, and ukagai's own files stay out", async () => {
  const e = await env();
  mkdirSync(join(e.home, ".git"), { recursive: true });
  mkdirSync(join(e.home, "proj"), { recursive: true });
  put(join(e.home, "proj", "a.txt"), numbered(3));
  put(join(e.home, "notes.txt"), numbered(3));
  put(join(e.home, ".ukagai", "token"), "secret-token\n");
  put(join(e.home, ".config", "gh", "hosts.yml"), "oauth_token: x\n");
  put(join(e.home, ".zsh_history"), numbered(3));
  const id = await e.seed(join(e.home, "proj"), "dot");
  assert.equal((await e.src("a.txt", 1, "", id)).status, 200);
  assert.equal(((await (await e.src("a.txt", 1, "", id)).json()) as { path: string }).path, "a.txt", "the root is proj, not home");
  for (const p of ["../notes.txt", "../.ukagai/token", "../.config/gh/hosts.yml", "../.zsh_history", join(e.home, "notes.txt"), join(e.home, ".ukagai", "token")]) assert.equal((await e.src(p, 1, "", id)).status, 404, p);
});

test("a session in the home directory, above it, or in / reads nothing", async () => {
  const e = await env();
  put(join(e.home, "notes.txt"), numbered(3));
  put(join(e.home, "..", `ukagai-above-${process.pid}.txt`), numbered(3));
  roots.push(join(e.home, "..", `ukagai-above-${process.pid}.txt`));
  const inHome = await e.seed(e.home, "home");
  const above = await e.seed(join(e.home, ".."), "above");
  const slash = await e.seed("/", "slash");
  assert.equal((await e.src("notes.txt", 1, "", inHome)).status, 404);
  assert.equal((await e.src(join(e.home, "notes.txt"), 1, "", inHome)).status, 404);
  assert.equal((await e.src(`ukagai-above-${process.pid}.txt`, 1, "", above)).status, 404);
  assert.equal((await e.src("etc/hosts", 1, "", slash)).status, 404);
  assert.equal((await e.src("/etc/hosts", 1, "", slash)).status, 404);
  assert.equal(readSource("/", "/etc/hosts", 1, undefined, { home: e.home }), null);
});

test("a session inside a refused folder of the home directory, or in the data directory, reads nothing", async () => {
  const e = await env();
  for (const d of [".aws", ".ssh", ".gnupg", ".kube", ".docker", ".config", ".claude", ".codex", ".ukagai", "Library/Keychains", "Library/Cookies", "Library/Application Support", "Library/Containers", "Library/Group Containers", "Library/Mail", "Library/Messages", "Library/Safari"]) {
    put(join(e.home, d, "credentials"), numbered(3));
    put(join(e.home, d, "sub", "x.txt"), numbered(3));
    const id = await e.seed(join(e.home, d), `h${d.replace("/", "-")}`);
    assert.equal((await e.src("credentials", 1, "", id)).status, 404, d);
    assert.equal((await e.src("sub/x.txt", 1, "", id)).status, 404, d);
    assert.equal((await e.src(join(e.home, d, "sub", "x.txt"), 1, "", id)).status, 404, d);
  }
  // a project below the home directory that refers into a refused folder with an absolute path
  const proj = join(e.home, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
  const inProj = await e.seed(proj, "proj");
  assert.equal((await e.src(join(e.home, ".aws", "credentials"), 1, "", inProj)).status, 404);
  assert.equal((await e.src("../.aws/credentials", 1, "", inProj)).status, 404);
  put(join(e.dataDir, "token"), "tok\n");
  const inData = await e.seed(e.dataDir, "data");
  assert.equal((await e.src("token", 1, "", inData)).status, 404);
  assert.equal((await e.src(join(e.dataDir, "token"), 1)).status, 404);
  // a symlink from the project into the data directory
  symlinkSync(join(e.dataDir, "token"), join(e.cwd, "tok.txt"));
  assert.equal((await e.src("tok.txt", 1)).status, 404);
});

test("a line past the end of the cwd's file goes on to the repository root's file; a denied name still stops", async () => {
  const e = await env();
  put(join(e.cwd, "README.md"), numbered(2));
  put(join(e.repo, "README.md"), numbered(50));
  const r = await e.src("README.md", 40);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { path: string; total: number };
  assert.deepEqual([body.path, body.total], ["README.md", 50]);
  assert.equal((await e.src("README.md", 60)).status, 404, "past the end of both");
  assert.equal((await e.src("README.md", 1)).status, 200);
  assert.equal(((await (await e.src("README.md", 1)).json()) as { path: string }).path, "app/README.md", "the cwd's file wins when the line is there");
  put(join(e.cwd, ".env"), numbered(2));
  put(join(e.repo, ".env"), numbered(50));
  assert.equal((await e.src(".env", 40)).status, 404);
});

test("headers on a 404, and a path of more than 1024 characters", async () => {
  const e = await env();
  const r = await e.src("nope.txt", 1);
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  put(join(e.cwd, "a.txt"), numbered(3));
  assert.equal((await e.src("a/".repeat(600) + "a.txt", 1)).status, 404);
  assert.equal((await e.src("./".repeat(520) + "a.txt", 1)).status, 404, "over 1024 characters, though it resolves");
  assert.equal((await e.src("a.txt", 1)).status, 200);
});

test("a FIFO in the project is 404 at once and the server keeps answering", async () => {
  if (process.platform === "win32") return;
  const e = await env();
  assert.equal(spawnSync("mkfifo", [join(e.cwd, "pipe.txt")]).status, 0);
  put(join(e.cwd, "a.txt"), numbered(3));
  const t0 = Date.now();
  const r = await e.src("pipe.txt", 1);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), NOT_FOUND);
  assert.ok(Date.now() - t0 < 3000, "answered without waiting for a writer");
  assert.equal(readLines(join(e.cwd, "pipe.txt")), null);
  const health = await fetch(`${e.url}/healthz`, { signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200);
  assert.equal((await e.src("a.txt", 1)).status, 200);
});

test("a cwd that vanished is 404, not an error", async () => {
  const e = await env();
  const gone = join(e.repo, "gone");
  mkdirSync(gone);
  const id = await e.seed(gone, "gone");
  rmSync(gone, { recursive: true });
  assert.equal((await e.src("a.txt", 1, "", id)).status, 404);
  assert.equal(readSource(gone, "a.txt", 1, undefined, { home: e.home }), null);
});

test("the data directory is refused wherever it sits, also without a dot in its name and inside the project", async () => {
  const e = await env((repo) => join(repo, "ukagai-data"));
  mkdirSync(join(e.repo, ".git"), { recursive: true });
  assert.equal(existsSync(join(e.repo, "ukagai-data", "token")), true, "the server wrote its token there");
  assert.equal((await e.src("ukagai-data/token", 1, "", e.id)).status, 404, "refused by the data-directory rule, not by a name rule");
  assert.equal((await e.src(join(e.repo, "ukagai-data", "token"), 1)).status, 404);
  put(join(e.repo, "ukagai-data", "notes.txt"), numbered(3));
  assert.equal((await e.src("ukagai-data/notes.txt", 1)).status, 404);
  put(join(e.repo, "ok.txt"), numbered(3));
  assert.equal((await e.src("ok.txt", 1)).status, 200);
});

test("the Unicode fold: ſecrets.yaml is judged as secrets.yaml, by its spelling and by its real name", async () => {
  assert.equal(isDenied("ſecrets.yaml"), true);
  assert.equal(isDenied("a/ſecrets.yaml"), true);
  assert.equal(isDenied("config/ſecrets/db.yml"), true);
  const e = await env();
  put(join(e.repo, "secrets.yaml"), numbered(3));
  put(join(e.repo, "okay.yaml"), numbered(3));
  assert.equal((await e.src("secrets.yaml", 1)).status, 404);
  assert.equal((await e.src("ſecrets.yaml", 1)).status, 404);
  assert.equal((await e.src("okay.yaml", 1)).status, 200);
});

test("the re-resolve after open: a candidate that no longer names the real file is refused (the swap window, forced by a candidate that points elsewhere)", () => {
  const dir = tmp();
  put(join(dir, "a.txt"), "a\n");
  put(join(dir, "b.txt"), "b\n");
  symlinkSync(join(dir, "b.txt"), join(dir, "link.txt"));
  assert.deepEqual(readLines(join(dir, "a.txt"), join(dir, "a.txt")), ["a"]);
  assert.equal(readLines(join(dir, "a.txt"), join(dir, "link.txt")), null, "the candidate resolves to b.txt now");
  assert.equal(readLines(join(dir, "link.txt")), null, "a symlink is not opened (O_NOFOLLOW)");
  assert.equal(readLines(join(dir, "missing.txt")), null);
  assert.equal(readLines(dir), null, "a directory");
  // a hard link inside the root is accepted (documented)
  linkSync(join(dir, "a.txt"), join(dir, "hard.txt"));
  assert.deepEqual(readLines(join(dir, "hard.txt")), ["a"]);
});

test("a .git planted in a shared (sticky) parent does not widen the root", async () => {
  if (process.platform === "win32") return;
  const e = await env();
  const shared = tmp();
  mkdirSync(join(shared, ".git"));
  chmodSync(shared, 0o1777);
  put(join(shared, "other.txt"), numbered(3));
  const child = join(shared, "scratch");
  mkdirSync(child);
  put(join(child, "mine.txt"), numbered(3));
  const id = await e.seed(child, "shared");
  assert.equal((await e.src("mine.txt", 1, "", id)).status, 200);
  assert.equal(((await (await e.src("mine.txt", 1, "", id)).json()) as { path: string }).path, "mine.txt", "the root is the session's directory");
  assert.equal((await e.src("../other.txt", 1, "", id)).status, 404);
  // the same layout without the sticky bit: a repository the user owns is the root
  chmodSync(shared, 0o755);
  assert.equal((await e.src("../other.txt", 1, "", id)).status, 200);
});

test("a path alias of the home directory is the home directory (identity, not strings)", async () => {
  const alias = (p: string) => "/System/Volumes/Data" + p;
  if (!existsSync(alias(tmp()))) return; // macOS only
  const e = await env((repo) => join(repo, "ukagai-data"));
  put(join(e.home, "notes.txt"), numbered(3));
  put(join(e.home, ".config", "x.txt"), numbered(3));
  const inHome = await e.seed(alias(e.home), "alias-home");
  assert.equal((await e.src("notes.txt", 1, "", inHome)).status, 404);
  const inConfig = await e.seed(alias(join(e.home, ".config")), "alias-config");
  assert.equal((await e.src("x.txt", 1, "", inConfig)).status, 404);
  const inData = await e.seed(alias(join(e.repo, "ukagai-data")), "alias-data");
  assert.equal((await e.src("token", 1, "", inData)).status, 404);
  assert.equal(readSource(alias(e.home), "notes.txt", 1, undefined, { home: e.home }), null);
});

test("a project in a synced folder of ~/Library is readable", async () => {
  const e = await env();
  const proj = join(e.home, "Library", "Mobile Documents", "com~apple~CloudDocs", "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
  put(join(proj, "src", "a.ts"), numbered(3));
  const id = await e.seed(proj, "icloud");
  assert.equal((await e.src("src/a.ts", 1, "", id)).status, 200);
});

test("a swap between the open and the checks is refused: the path must still give the same real path and the same file", () => {
  const dir = tmp();
  put(join(dir, "real", "a.txt"), "inside\n");
  put(join(dir, "other", "a.txt"), "OUTSIDE\n");
  symlinkSync(join(dir, "real"), join(dir, "link"));
  const real = realpathSync(join(dir, "real", "a.txt"));
  const candidate = join(dir, "link", "a.txt");
  assert.deepEqual(readLines(real, candidate), ["inside"]);
  // the folder the candidate goes through is repointed after the open: the candidate no longer names `real`
  assert.equal(readLines(real, candidate, () => { unlinkSync(join(dir, "link")); symlinkSync(join(dir, "other"), join(dir, "link")); }), null);
  // another file takes the place of the opened one: same path, another device / inode
  put(join(dir, "swap.txt"), "swapped\n");
  assert.equal(readLines(real, real, () => renameSync(join(dir, "swap.txt"), real)), null);
});
