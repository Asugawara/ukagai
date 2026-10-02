import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookOptions } from "./options.js";

const HEALTHZ_TIMEOUT_MS = 300;
const START_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 100;

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void };

export interface AutostartDeps {
  fetch: typeof fetch;
  spawn: SpawnFn;
  now: () => Date;
  platform: NodeJS.Platform;
  cliPath: string;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: AutostartDeps = {
  fetch: (...a) => fetch(...a),
  spawn: (cmd, args, o) => nodeSpawn(cmd, args, o),
  now: () => new Date(),
  platform: process.platform,
  cliPath: fileURLToPath(new URL("../cli.js", import.meta.url)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function healthy(server: string, deps: AutostartDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(`${server}/healthz`, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** SessionStart: server を起こし、その日最初なら GUI を開く。例外は投げない */
export async function autostart(opts: HookOptions, deps: AutostartDeps = defaultDeps): Promise<void> {
  if (opts.noAutostart) return;
  try {
    let up = await healthy(opts.server, deps);
    if (!up) {
      const url = new URL(opts.server);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return;
      mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
      const fd = openSync(join(opts.dataDir, "serve.log"), "a");
      try {
        const args = [deps.cliPath, "serve", "--port", url.port || "80", "--data-dir", opts.dataDir];
        deps.spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] }).unref();
      } finally {
        closeSync(fd);
      }
      for (let waited = 0; !up && waited < START_WAIT_MS; waited += POLL_INTERVAL_MS) {
        await deps.sleep(POLL_INTERVAL_MS);
        up = await healthy(opts.server, deps);
      }
      if (!up) return;
    }
    const today = localDate(deps.now());
    const marker = join(opts.dataDir, "gui-opened");
    let last = "";
    try {
      last = readFileSync(marker, "utf8").trim();
    } catch {
      // 無ければ初回
    }
    if (last === today) return;
    const opener = deps.platform === "darwin" ? "open" : deps.platform === "linux" ? "xdg-open" : undefined;
    if (!opener) return;
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, today + "\n");
    deps.spawn(opener, [`${opts.server}/`], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // フェイルオープン
  }
}
