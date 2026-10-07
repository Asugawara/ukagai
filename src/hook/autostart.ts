import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "./client.js";
import type { HookOptions } from "./options.js";

const HEALTHZ_TIMEOUT_MS = 300;
const START_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 100;
const GUI_OPEN_TIMEOUT_MS = 300;

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void };

export interface AutostartDeps {
  fetch: typeof fetch;
  spawn: SpawnFn;
  cliPath: string;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: AutostartDeps = {
  fetch: (...a) => fetch(...a),
  spawn: (cmd, args, o) => nodeSpawn(cmd, args, o),
  cliPath: fileURLToPath(new URL("../cli.js", import.meta.url)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function healthy(server: string, deps: AutostartDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(`${server}/healthz`, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** SessionStart: start the server and ask it to open the GUI (the server decides, once a day). Never throws */
export async function autostart(opts: HookOptions, deps: AutostartDeps = defaultDeps, client: Client = new Client(opts.server, opts.dataDir)): Promise<void> {
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
    // The server decides whether a GUI tab is already there; the answer is ignored
    await client.requestGuiOpen(GUI_OPEN_TIMEOUT_MS);
  } catch {
    // fail open
  }
}
