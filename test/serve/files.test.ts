import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTag } from "../../src/serve/files.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-files-"));
  roots.push(d);
  return d;
};
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const put = (path: string, body: Buffer | string = PNG): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};

async function env() {
  const home = tmp();
  const dataDir = tmp();
  const top = mkdtempSync(join(tmpdir(), "claude-ukagai-files-")); // <tmp>/claude-*/<project>/<session>/scratchpad, like Claude Code
  roots.push(top);
  const scratch = join(top, "-proj", "sess-1", "scratchpad");
  const doc = join(scratch, "ukagai", "ex.md");
  mkdirSync(join(scratch, "ukagai"), { recursive: true });
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const res = await fetch(url + "/api/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_use_id: "tu-files",
      kind: "answer_question",
      session: { session_id: "sess-1", cwd: "/nonexistent-ukagai-cwd", transcript_path: join(home, ".claude", "projects", "p", "sess-1.jsonl"), scratchpad_dir: scratch },
      request: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
      explanation: { path: doc, markdown: "---\nukagai: 1\n---\n## Why this decision is needed now\nx\n", has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
    }),
  });
  const { id } = (await res.json()) as { id: string };
  const session = { session_id: "sess-2", cwd: "/nonexistent-ukagai-cwd", transcript_path: join(home, ".claude", "projects", "p", "sess-2.jsonl"), scratchpad_dir: scratch };
  /** Another decision of the same server: a plan approval (planFilePath as given) or a question whose explanation sits at `explanationPath` */
  const seed = async (extra: Record<string, unknown>, n: string): Promise<string> => {
    const r = await fetch(url + "/api/decisions", { method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: JSON.stringify({ tool_use_id: `tu-${n}`, session: { ...session, session_id: `sess-${n}` }, ...extra }) });
    assert.equal(r.status, 201, await r.clone().text());
    return ((await r.json()) as { id: string }).id;
  };
  const approve = (planFilePath: string, n: string) => seed({ kind: "approve_plan", request: { plan: "# P\n", planFilePath } }, n);
  const explained = (path: string, n: string) => seed({
    kind: "answer_question",
    request: { questions: [{ question: `Q ${n}?`, header: "Q", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    explanation: { path, markdown: "---\nukagai: 1\n---\n## Why this decision is needed now\nx\n", has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
  }, n);
  const get = (q: string, auth = true) => fetch(`${url}/api/files?${q}`, { headers: auth ? { authorization: `Bearer ${h.token}` } : {} });
  const file = (path: string, auth = true) => get(`decision=${id}&path=${encodeURIComponent(path)}`, auth);
  const fileOf = (id: string, path: string) => get(`decision=${id}&path=${encodeURIComponent(path)}`);
  return { home, dataDir, scratch, id, url, h, get, file, approve, explained, fileOf };
}

test("served: relative to the document dir, scratchpad (absolute and ../), plans dir, data dir; headers", async () => {
  const e = await env();
  put(join(e.scratch, "ukagai", "shots", "a.png"));
  put(join(e.scratch, "other", "b.JPG"));
  put(join(e.dataDir, "c.webp"));
  put(join(e.home, ".claude", "plans", "img", "d.gif"));

  const a = await e.file("shots/a.png");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("content-type"), "image/png");
  assert.equal(a.headers.get("x-content-type-options"), "nosniff");
  assert.equal(a.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), PNG);

  assert.equal((await e.file("../other/b.JPG")).status, 200); // scratchpad root, outside the document dir
  assert.equal((await e.file(join(e.scratch, "other", "b.JPG"))).headers.get("content-type"), "image/jpeg");
  assert.equal((await e.file(join(e.dataDir, "c.webp"))).headers.get("content-type"), "image/webp");
  const plan = await e.get(`plan=${encodeURIComponent("p.md")}&path=${encodeURIComponent("img/d.gif")}`);
  assert.equal(plan.status, 200);
  assert.equal(plan.headers.get("content-type"), "image/gif");
});

test("forbidden and missing are all 404 with the same body", async () => {
  const e = await env();
  const outside = put(join(tmp(), "secret.png"));
  put(join(e.scratch, "ukagai", "note.txt"), "text");
  put(join(e.scratch, "ukagai", "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  mkdirSync(join(e.scratch, "ukagai", "dir.png"));
  symlinkSync(outside, join(e.scratch, "ukagai", "link.png"));
  put(join(e.home, "home.png"));

  for (const p of [outside, "link.png", "dir.png", "note.txt", "big.png", "missing.png", "../../../../../../etc/passwd.png", join(e.home, "home.png"), "", "a\0.png"]) {
    const r = await e.file(p);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: "not found" });
  }
  assert.equal((await e.get(`decision=nope&path=a.png`)).status, 404);
  assert.equal((await e.get(`path=a.png`)).status, 404);
  assert.equal((await e.get(`plan=${encodeURIComponent("../x.md")}&path=a.png`)).status, 404);
  assert.equal((await e.get(`plan=p.md&path=${encodeURIComponent(outside)}`)).status, 404);
});

test("a plan's image outside the plans dir is not served; a symlink in the plans dir cannot escape", async () => {
  const e = await env();
  const outside = put(join(tmp(), "secret.png"));
  mkdirSync(join(e.home, ".claude", "plans"), { recursive: true });
  symlinkSync(outside, join(e.home, ".claude", "plans", "esc.png"));
  assert.equal((await e.get(`plan=p.md&path=esc.png`)).status, 404);
});

test("401 without a cookie or bearer; the GUI cookie works", async () => {
  const e = await env();
  put(join(e.scratch, "ukagai", "a.png"));
  assert.equal((await e.file("a.png", false)).status, 401);
  const bad = await fetch(`${e.url}/api/files?decision=${e.id}&path=a.png`, { headers: { authorization: "Bearer wrong" } });
  assert.equal(bad.status, 401);
  const page = await fetch(e.url + "/");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const ok = await fetch(`${e.url}/api/files?decision=${e.id}&path=a.png`, { headers: { cookie } });
  assert.equal(ok.status, 200);
});

test("the document's own directory is a root only for a standalone explanation file", async () => {
  const e = await env();
  const plans = join(e.home, ".claude", "plans");
  const outsideImg = put(join(tmp(), "victim", "evil.png"));
  put(join(e.home, "Pictures", "p.png"));
  put(join(plans, "img", "a.png"));
  put(join(plans, "p.md"), "# P\n"); // plan_name is set only for an existing plan file

  // a plan approval whose planFilePath is not in the plans dir has no plan_name: nothing is served, whatever the path says
  const foreign = await e.approve("/x.md", "foreign");
  assert.equal((await e.fileOf(foreign, outsideImg)).status, 404);
  const foreign2 = await e.approve(join(tmp(), "victim", "evil.md"), "foreign2");
  assert.equal((await e.fileOf(foreign2, "evil.png")).status, 404);
  assert.equal((await e.fileOf(foreign2, outsideImg)).status, 404);
  // one inside the plans dir resolves against the plans dir
  const own = await e.approve(join(plans, "p.md"), "own");
  assert.equal((await e.fileOf(own, "img/a.png")).status, 200);
  assert.equal((await e.fileOf(own, outsideImg)).status, 404);

  // a plan-block explanation (allowed anywhere under $HOME) resolves relative paths but does not make $HOME a root
  const block = await e.explained(join(e.home, "x.md#ukagai-explain"), "block");
  assert.equal((await e.fileOf(block, "Pictures/p.png")).status, 404);
  assert.equal((await e.fileOf(block, join(e.home, "Pictures", "p.png"))).status, 404);
  const blockInPlans = await e.explained(join(plans, "x.md#ukagai-explain"), "block2");
  assert.equal((await e.fileOf(blockInPlans, "img/a.png")).status, 200);
  assert.equal((await e.fileOf(blockInPlans, "../../Pictures/p.png")).status, 404);
});

test("look-alike roots are not roots: scratchpad2/, plans-evil/, ~/.claude/ outside plans, a directory in the scratchpad", async () => {
  const e = await env();
  const sibling = (name: string) => join(e.scratch, "..", name);
  put(join(sibling("scratchpad2"), "a.png"));
  put(join(e.home, ".claude", "plans-evil", "a.png"));
  put(join(e.home, ".claude", "x.png"));
  mkdirSync(join(e.scratch, "other", "dir.png"), { recursive: true });
  const top = join(e.scratch, "..", "..", "..");
  put(join(top, "notscratchpad", "a.png"));
  for (const p of [join(sibling("scratchpad2"), "a.png"), join(e.home, ".claude", "plans-evil", "a.png"), join(e.home, ".claude", "x.png"), join(e.scratch, "other", "dir.png"), join(top, "notscratchpad", "a.png")]) {
    assert.equal((await e.file(p)).status, 404, p);
  }
  const plan = await e.get(`plan=p.md&path=${encodeURIComponent(join(e.home, ".claude", "plans-evil", "a.png"))}`);
  assert.equal(plan.status, 404);
});

test("html: served with the CSP sandbox and nosniff; scripts stay; relative src / href / url() are rewritten, absolute / data: / # are not", async () => {
  const e = await env();
  const page = [
    '<img src="shots/a.png"> <img src=\'b.png\'> <a href="other.html#top">x</a> <link href="a.css">',
    '<div style="background:url(bg.png)"></div><style>.x{background:url("../up.png")}</style>',
    '<img src="data:image/png;base64,AAAA"><a href="https://example.com/x">e</a><a href="#frag">f</a><img src="/abs.png"><a href="mailto:a@b.c">m</a><img src="//cdn.example/x.png">',
    "<script>document.title = 'x'</script>",
  ].join("\n");
  put(join(e.scratch, "ukagai", "cmp.html"), page);
  put(join(e.scratch, "ukagai", "shots", "a.png"));
  const r = await e.file("cmp.html");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("content-security-policy"), "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const body = await r.text();
  const dir = realpathSync(join(e.scratch, "ukagai"));
  const u = (rel: string, amp = "&amp;") => {
    const abs = join(dir, rel);
    return `/api/files?decision=${e.id}${amp}path=${encodeURIComponent(abs)}${amp}tag=${fileTag(`decision=${e.id}`, abs)}`;
  };
  assert.ok(body.includes(`<img src="${u("shots/a.png")}">`), body);
  assert.ok(body.includes(`<img src="${u("b.png")}">`));
  assert.ok(body.includes(`href="${u("other.html")}"`)); // the fragment is dropped: the file is what is asked for
  assert.ok(body.includes(`href="${u("a.css")}"`));
  assert.ok(body.includes(`url("${u("bg.png", "&")}")`));
  assert.ok(body.includes(`url("${u("../up.png", "&").replace(encodeURIComponent(join(dir, "../up.png")), encodeURIComponent(join(dir, "..", "up.png")))}")`));
  for (const keep of ['src="data:image/png;base64,AAAA"', 'href="https://example.com/x"', 'href="#frag"', 'src="/abs.png"', 'href="mailto:a@b.c"', 'src="//cdn.example/x.png"', "<script>document.title = 'x'</script>"]) {
    assert.ok(body.includes(keep), keep);
  }
  // a rewritten URL resolves through the same route
  const q = u("shots/a.png").slice("/api/files?".length).replace(/&amp;/g, "&");
  assert.equal((await e.get(q, false)).status, 200); // no cookie, no bearer: the tag authorises this one file (a sandboxed frame sends no cookie)
  assert.equal((await e.get(q.replace(/tag=.*/, "tag=bad"), false)).status, 401);
  assert.equal((await e.get(q.replace("a.png", "b.png"), false)).status, 401); // the tag is bound to the path
  assert.equal((await e.get(q.replace(`decision=${e.id}`, "decision=other"), false)).status, 401); // and to the document
  const img = await e.get(q);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-security-policy"), null); // only pages carry the CSP
});

test("html: 2 MB cap, .htm too, roots still enforced, a plan's page works through plan=", async () => {
  const e = await env();
  put(join(e.scratch, "ukagai", "ok.htm"), "<p>hi</p>");
  put(join(e.scratch, "ukagai", "big.html"), "x".repeat(2 * 1024 * 1024 + 1));
  put(join(e.scratch, "ukagai", "edge.html"), "x".repeat(2 * 1024 * 1024));
  const outside = put(join(tmp(), "evil.html"), "<p>no</p>");
  put(join(e.home, "home.html"), "<p>no</p>");
  put(join(e.home, ".claude", "plans", "page.html"), '<img src="img/d.gif">');
  assert.equal((await e.file("ok.htm")).status, 200);
  assert.equal((await e.file("edge.html")).status, 200);
  for (const p of ["big.html", outside, join(e.home, "home.html"), "../../../../../../etc/hosts.html"]) assert.equal((await e.file(p)).status, 404, p);
  const plan = await e.get(`plan=p.md&path=${encodeURIComponent("page.html")}`);
  assert.equal(plan.status, 200);
  assert.match(await plan.text(), /src="\/api\/files\?plan=p\.md&amp;path=/);
});
