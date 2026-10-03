import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { writeConfig, type Lang } from "../../src/settings/config.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];

after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

async function boot(lang?: Lang): Promise<{ url: string; token: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-cfg-serve-"));
  roots.push(dir);
  if (lang) await writeConfig(dir, { lang });
  const h = await start({ port: 0, dataDir: dir, home: dir });
  handles.push(h);
  return { url: `http://127.0.0.1:${h.port}`, token: h.token };
}

test("GET / injects lang / data-lang from config.json", async () => {
  const { url } = await boot("ja");
  const html = await (await fetch(url + "/")).text();
  assert.match(html, /<html[^>]*\blang="ja"/);
  assert.match(html, /<html[^>]*\bdata-lang="ja"/);
  assert.equal((html.match(/(?<![-\w])lang="/g) ?? []).length, 1);
});

test("GET / defaults to en without a config", async () => {
  const { url } = await boot();
  const html = await (await fetch(url + "/")).text();
  assert.match(html, /<html[^>]*\blang="en"[^>]*\bdata-lang="en"/);
});

test("GET /api/config returns the language to a cookie or Bearer, 401 otherwise", async () => {
  const { url, token } = await boot("ja");
  assert.equal((await fetch(url + "/api/config")).status, 401);
  const viaBearer = await fetch(url + "/api/config", { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual({ ...(await viaBearer.json()), build: "x" }, { lang: "ja", build: "x" });
  const cookie = ((await fetch(url + "/")).headers.get("set-cookie") ?? "").split(";")[0]!;
  const viaCookie = await fetch(url + "/api/config", { headers: { cookie } });
  assert.equal(viaCookie.status, 200);
  assert.deepEqual({ ...(await viaCookie.json()), build: "x" }, { lang: "ja", build: "x" });
});
