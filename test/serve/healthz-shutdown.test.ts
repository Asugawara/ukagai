import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { VERSION } from "../../src/version.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

async function setup(onShutdown?: () => void, cliPath?: string): Promise<{ h: ServeHandle; url: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "ukagai-hz-"));
  const home = mkdtempSync(join(tmpdir(), "ukagai-hz-home-"));
  roots.push(dataDir, home);
  const h = await start({ port: 0, dataDir, home, onShutdown, cliPath });
  handles.push(h);
  return { h, url: `http://127.0.0.1:${h.port}`, dataDir };
}

test("GET /healthz reports the version; under tsx dist/cli.js does not exist, so `cli` is absent", async () => {
  const { url } = await setup();
  const body = (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean; version: string; cli?: string };
  assert.equal(body.ok, true);
  assert.equal(body.version, VERSION);
  assert.equal(body.version, JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version);
  assert.equal(existsSync(fileURLToPath(new URL("../../src/cli.js", import.meta.url))), false, "premise: no src/cli.js under tsx");
  assert.equal("cli" in body, false);
});

test("GET /healthz reports `cli` equal to the path when that file exists, and omits it when it is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-hz-cli-"));
  roots.push(dir);
  const cli = join(dir, "cli.js");
  writeFileSync(cli, "// stub\n");
  const { url } = await setup(undefined, cli);
  assert.equal(((await (await fetch(`${url}/healthz`)).json()) as { cli?: string }).cli, cli);
  const missing = await setup(undefined, join(dir, "nope.js"));
  assert.equal("cli" in ((await (await fetch(`${missing.url}/healthz`)).json()) as object), false);
});

test("serve writes its node to <data-dir>/node-path", async () => {
  const { dataDir } = await setup();
  assert.equal(readFileSync(join(dataDir, "node-path"), "utf8").trim(), process.execPath);
  assert.ok(existsSync(join(dataDir, "node-path")));
  assert.equal(statSync(join(dataDir, "node-path")).mode & 0o777, 0o644);
});

test("POST /api/shutdown: 401 without Bearer, 415 without JSON, 200 then the server stops accepting connections", async () => {
  let shutdownCalled: () => void = () => {};
  const done = new Promise<void>((r) => (shutdownCalled = r));
  const { h, url } = await setup(() => shutdownCalled());
  const post = (headers: Record<string, string>) => fetch(`${url}/api/shutdown`, { method: "POST", headers, body: "{}" });

  assert.equal((await post({ "content-type": "application/json" })).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong", "content-type": "application/json" })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${h.token}`, "content-type": "text/plain" })).status, 415);
  assert.equal((await fetch(`${url}/healthz`)).status, 200, "refused calls leave the server up");

  const res = await post({ authorization: `Bearer ${h.token}`, "content-type": "application/json" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await done;
  await assert.rejects(fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }));
});
