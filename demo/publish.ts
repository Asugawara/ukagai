// npm run demo:publish -- <pr> [--lang en|ja] [--dry-run]
// Attaches the rendered demo (WebP and MP4) to a PR comment per language, reads the URLs back, checks their bytes,
// and points the README at the WebP. It never commits and never deletes a comment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALT, parseAttachments, README, rewriteReadme, sizeProblems } from "./lib/attachments.js";
import { renderInputs } from "./lib/inputs.js";
import { LANGS, type Lang } from "./seeds.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(REPO_ROOT, "demo", "out");
const PUBLISHED = "demo/published.json";
const WRITES = ["README.md", "README.ja.md", PUBLISHED];

interface RenderRecord {
  lang: Lang;
  webp: { file: string; bytes: number; sha256: string };
  mp4: { file: string; bytes: number; sha256: string };
  chrome: string;
  head: string;
  inputs: string;
  reused_shots: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function run(cmd: string, args: string[], cwd = REPO_ROOT): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") + err.message };
  }
}

const git = (args: string[]) => run("git", args).out.trim();

function loadRender(lang: Lang): RenderRecord | null {
  const path = join(OUT, lang, "render.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RenderRecord) : null;
}

function checks(pr: number): { rows: Check[]; renders: Record<Lang, RenderRecord | null>; branch: string; head: string } {
  const rows: Check[] = [];
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "HEAD"]);

  const help = run("gh", ["pr", "comment", "--help"]).out;
  rows.push({ name: "gh --attach", ok: help.includes("--attach"), detail: help.includes("--attach") ? "available" : "gh pr comment has no --attach" });

  const view = run("gh", ["pr", "view", String(pr), "--json", "state,headRefName,headRefOid"]);
  const pv = view.ok ? (JSON.parse(view.out) as { state: string; headRefName: string; headRefOid: string }) : null;
  rows.push({
    name: "PR open, this branch, this HEAD",
    ok: !!pv && pv.state === "OPEN" && pv.headRefName === branch && pv.headRefOid === head,
    detail: pv ? `${pv.state} ${pv.headRefName} ${pv.headRefOid.slice(0, 12)} (local ${branch} ${head.slice(0, 12)})` : view.out.trim(),
  });

  const upstream = run("git", ["rev-parse", "@{u}"]);
  rows.push({
    name: "pushed",
    ok: upstream.ok && upstream.out.trim() === head,
    detail: upstream.ok ? (upstream.out.trim() === head ? "upstream = HEAD" : "upstream differs from HEAD") : "no upstream",
  });

  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  const others = dirty.filter((l) => !WRITES.some((w) => l.slice(3) === w));
  rows.push({ name: "clean tree", ok: others.length === 0, detail: others.length === 0 ? "only the files publish writes" : others.join(", ") });

  const inputs = renderInputs(REPO_ROOT);
  const renders = { en: loadRender("en"), ja: loadRender("ja") } as Record<Lang, RenderRecord | null>;
  for (const lang of LANGS) {
    const r = renders[lang];
    if (!r) {
      rows.push({ name: `render.json (${lang})`, ok: false, detail: "missing: run npm run demo" });
      continue;
    }
    const problems: string[] = [];
    if (r.reused_shots) problems.push("shots were reused");
    if (r.inputs !== inputs.hash) problems.push("inputs changed since the render");
    for (const k of ["webp", "mp4"] as const) {
      const file = join(OUT, lang, r[k].file);
      if (!existsSync(file)) problems.push(`${r[k].file} missing`);
      else if (sha256(readFileSync(file)) !== r[k].sha256) problems.push(`${r[k].file} sha256 differs from render.json`);
    }
    rows.push({ name: `render.json (${lang})`, ok: problems.length === 0, detail: problems.join("; ") || `inputs ${r.inputs.slice(0, 12)}, head ${r.head}` });
    const sizes = sizeProblems({ webp: r.webp.bytes, mp4: r.mp4.bytes });
    rows.push({ name: `sizes (${lang})`, ok: sizes.length === 0, detail: sizes.join("; ") || `WebP ${r.webp.bytes}, MP4 ${r.mp4.bytes}` });
  }

  const owner = run("gh", ["repo", "view", "--json", "owner", "--jq", ".owner.login"]).out.trim();
  const user = run("gh", ["api", "user", "--jq", ".login"]).out.trim();
  rows.push({
    name: "uploader is the repository owner",
    ok: owner === user,
    detail: owner === user ? `${user}` : `warning: uploader ${user}, owner ${owner}: the assets are tied to ${user}`,
  });
  return { rows, renders, branch, head };
}

const commentBody = (lang: Lang, r: RenderRecord, inputs: string, head: string) =>
  `${lang}: WebP ${r.webp.bytes} bytes sha256 ${r.webp.sha256}; MP4 ${r.mp4.bytes} bytes sha256 ${r.mp4.sha256}; inputs ${inputs.slice(0, 12)}; HEAD ${head.slice(0, 12)}`;

function fetchBytes(url: string): Promise<Buffer> {
  return fetch(url, { redirect: "follow" }).then(async (res) => {
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
}

async function publishLang(pr: number, lang: Lang, r: RenderRecord, inputs: string, head: string): Promise<{ webp: string; mp4: string; comment: string; uploader: string }> {
  const dir = join("demo", "out", lang);
  const posted = run(
    "gh",
    ["pr", "comment", String(pr), "--body", commentBody(lang, r, inputs, head), "--attach", `${dir}/${r.webp.file}#${ALT[lang]}`, "--attach", `${dir}/${r.mp4.file}`],
  );
  if (!posted.ok) throw new Error(`gh pr comment failed: ${posted.out.trim()}`);
  const id = /issuecomment-(\d+)/.exec(posted.out)?.[1];
  const url = id ? posted.out.match(/https:\/\/github\.com\/\S+#issuecomment-\d+/)![0] : run("gh", ["pr", "view", String(pr), "--json", "comments", "--jq", ".comments[-1].url"]).out.trim();
  const commentId = id ?? /issuecomment-(\d+)/.exec(url)?.[1];
  if (!commentId) throw new Error(`no comment id from: ${posted.out.trim()}`);
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).out.trim();
  const body = run("gh", ["api", `repos/${repo}/issues/comments/${commentId}`, "--jq", ".body"]);
  if (!body.ok) throw new Error(`cannot read the comment back: ${body.out.trim()}`);
  const { webp, mp4 } = parseAttachments(body.out);
  const uploader = run("gh", ["api", "user", "--jq", ".login"]).out.trim();
  return { webp, mp4, comment: url, uploader };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const only = args.includes("--lang") ? (args[args.indexOf("--lang") + 1] as Lang) : null;
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  if (!pr) {
    console.error("usage: npm run demo:publish -- <pr> [--lang en|ja] [--dry-run]");
    return 1;
  }
  const langs = only ? [only] : [...LANGS];
  const { rows, renders, head } = checks(pr);
  const inputs = renderInputs(REPO_ROOT);

  console.log("| check | result | detail |\n|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.ok ? "ok" : "fail"} | ${r.detail} |`);

  for (const lang of langs) {
    const r = renders[lang];
    if (!r) continue;
    const dir = join("demo", "out", lang);
    console.log(`\n${lang}: ${`gh pr comment ${pr} --body ${JSON.stringify(commentBody(lang, r, inputs.hash, head))} --attach ${JSON.stringify(`${dir}/${r.webp.file}#${ALT[lang]}`)} --attach ${JSON.stringify(`${dir}/${r.mp4.file}`)}`}`);
  }
  if (dry) return 0;

  const failed = rows.filter((r) => !r.ok && r.name !== "clean tree" && r.name !== "pushed");
  if (failed.length > 0 || rows.some((r) => r.name === "clean tree" && !r.ok) || rows.some((r) => r.name === "pushed" && !r.ok)) {
    console.error("\nprerequisites failed: nothing uploaded");
    return 1;
  }

  const published = existsSync(join(REPO_ROOT, PUBLISHED)) ? JSON.parse(readFileSync(join(REPO_ROOT, PUBLISHED), "utf8")) : {};
  for (const lang of langs) {
    const r = renders[lang]!;
    try {
      const up = await publishLang(pr, lang, r, inputs.hash, head);
      const webpBytes = await fetchBytes(up.webp);
      const mp4Bytes = await fetchBytes(up.mp4);
      const want = { webp: r.webp.sha256, mp4: r.mp4.sha256 };
      if (sha256(webpBytes) !== want.webp || sha256(mp4Bytes) !== want.mp4) {
        console.error(`${lang}: the uploaded bytes differ from the render; nothing written (URLs: ${up.webp} ${up.mp4})`);
        return 1;
      }
      published[lang] = {
        pr,
        comment: up.comment,
        published_at: new Date().toISOString(),
        uploader: up.uploader,
        head: r.head,
        inputs: r.inputs,
        chrome: r.chrome,
        webp: { url: up.webp, bytes: r.webp.bytes, sha256: r.webp.sha256, verified: true },
        mp4: { url: up.mp4, bytes: r.mp4.bytes, sha256: r.mp4.sha256, verified: true },
      };
      writeFileSync(join(REPO_ROOT, PUBLISHED), JSON.stringify(published, null, 2) + "\n");
      const readme = join(REPO_ROOT, README[lang]);
      writeFileSync(readme, rewriteReadme(readFileSync(readme, "utf8"), lang, up.webp));
      console.log(`${lang}: published ${up.comment}`);
    } catch (e) {
      console.error(`${lang}: ${(e as Error).message}`);
      return 1;
    }
  }
  console.log(`\nto commit (not committed here): ${WRITES.join(" ")}`);
  return 0;
}

main().then((code) => process.exit(code));
