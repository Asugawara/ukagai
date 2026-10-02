import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate, type AutostartDeps } from "../../src/hook/autostart.js";
import { sessionContext } from "../../src/hook/context-hooks.js";
import { parseArgs } from "../../src/hook/options.js";
import { tmpDir } from "./helpers.js";

const NOW = new Date(2026, 9, 2, 12, 0, 0);
const TODAY = localDate(NOW);
const RAW = { session_id: "s", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart" };

function setup(opts: { up: boolean | "after-spawn"; extra?: string[]; server?: string }) {
  const dd = tmpDir();
  const spawns: { cmd: string; args: string[]; o: any }[] = [];
  let fetches = 0;
  let started = false;
  const deps: AutostartDeps = {
    fetch: (async () => {
      fetches++;
      const ok = opts.up === true || (opts.up === "after-spawn" && started);
      if (!ok) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    spawn: (cmd, args, o) => {
      spawns.push({ cmd, args, o });
      if (args.includes("serve")) started = true;
      return { unref() {} };
    },
    now: () => NOW,
    platform: "darwin",
    cliPath: "/x/dist/cli.js",
    sleep: async () => {},
  };
  const hookOpts = parseArgs(["--data-dir", dd, "--server", opts.server ?? "http://127.0.0.1:4831", ...(opts.extra ?? [])]);
  return { dd, spawns, deps, hookOpts, fetches: () => fetches };
}

const marker = (dd: string) => join(dd, "gui-opened");

test("到達できる + gui-opened が今日: spawn なし", async () => {
  const s = setup({ up: true });
  writeFileSync(marker(s.dd), TODAY + "\n");
  const out = await sessionContext(RAW, s.hookOpts, s.deps);
  assert.ok(out);
  assert.equal(s.spawns.length, 0);
});

test("到達できる + gui-opened が昨日: open が呼ばれ今日に更新", async () => {
  const s = setup({ up: true });
  writeFileSync(marker(s.dd), "2026-10-01\n");
  await sessionContext(RAW, s.hookOpts, s.deps);
  assert.deepEqual(s.spawns.map((x) => [x.cmd, x.args]), [["open", ["http://127.0.0.1:4831/"]]]);
  assert.equal(readFileSync(marker(s.dd), "utf8").trim(), TODAY);
});

test("到達できない: serve を期待の引数で起動し、healthz が通れば open", async () => {
  const s = setup({ up: "after-spawn" });
  const out = await sessionContext(RAW, s.hookOpts, s.deps);
  assert.ok(out);
  assert.equal(s.spawns.length, 2);
  assert.equal(s.spawns[0]!.cmd, process.execPath);
  assert.deepEqual(s.spawns[0]!.args, ["/x/dist/cli.js", "serve", "--port", "4831", "--data-dir", s.dd]);
  assert.equal(s.spawns[0]!.o.detached, true);
  assert.equal(s.spawns[1]!.cmd, "open");
  assert.ok(existsSync(join(s.dd, "serve.log")));
});

test("起動しても healthz が通らない: open なし、additionalContext は返る", async () => {
  const s = setup({ up: false });
  const out = await sessionContext(RAW, s.hookOpts, s.deps);
  assert.ok((out as any).hookSpecificOutput.additionalContext);
  assert.equal(s.spawns.length, 1);
  assert.ok(!existsSync(marker(s.dd)));
});

test("server が別ホストなら自動起動しない", async () => {
  const s = setup({ up: false, server: "http://example.com:4818" });
  const out = await sessionContext(RAW, s.hookOpts, s.deps);
  assert.ok(out);
  assert.equal(s.spawns.length, 0);
});

test("--no-autostart: fetch も spawn もしない", async () => {
  const s = setup({ up: false, extra: ["--no-autostart"] });
  const out = await sessionContext(RAW, s.hookOpts, s.deps);
  assert.ok(out);
  assert.equal(s.fetches(), 0);
  assert.equal(s.spawns.length, 0);
});

test("SubagentStart: 何もしない", async () => {
  const s = setup({ up: false });
  const out = await sessionContext({ ...RAW, hook_event_name: "SubagentStart" }, s.hookOpts, s.deps);
  assert.ok(out);
  assert.equal(s.fetches(), 0);
  assert.equal(s.spawns.length, 0);
});
