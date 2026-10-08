import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "./client.js";
import { VERSION } from "../version.js";
const HEALTHZ_TIMEOUT_MS = 300;
const START_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 100;
const GUI_OPEN_TIMEOUT_MS = 300;
const SHUTDOWN_TIMEOUT_MS = 1000;
const STOP_WAIT_MS = 3000;
export const defaultDeps = {
    fetch: (...a) => fetch(...a),
    spawn: (cmd, args, o) => nodeSpawn(cmd, args, o),
    cliPath: fileURLToPath(new URL("../cli.js", import.meta.url)),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
async function probe(server, deps) {
    // A referenced timer rather than AbortSignal.timeout (whose timer is unref'd): see Client.requestOnce
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${HEALTHZ_TIMEOUT_MS} ms`)), HEALTHZ_TIMEOUT_MS);
    try {
        const res = await deps.fetch(`${server}/healthz`, { signal: ac.signal });
        if (res.status !== 200)
            return { up: false };
        try {
            const j = (await res.json());
            return { up: true, ...(typeof j?.version === "string" ? { version: j.version } : {}), ...(typeof j?.cli === "string" ? { cli: j.cli } : {}) };
        }
        catch {
            return { up: true };
        }
    }
    catch {
        return { up: false };
    }
}
/** The running server is another version than this hook, or its dist/cli.js was replaced: it should be restarted */
function stale(h, deps) {
    if (h.version !== undefined && h.version !== (deps.version ?? VERSION))
        return true;
    return h.cli !== undefined && !(deps.exists ?? existsSync)(h.cli);
}
/** SessionStart: start the server and ask it to open the GUI (the server decides, once a day). Never throws */
export async function autostart(opts, deps = defaultDeps, client = new Client(opts.server, opts.dataDir)) {
    if (opts.noAutostart)
        return;
    try {
        let health = await probe(opts.server, deps);
        if (health.up && stale(health, deps) && (await client.shutdown(SHUTDOWN_TIMEOUT_MS))) {
            for (let waited = 0; health.up && waited < STOP_WAIT_MS; waited += POLL_INTERVAL_MS) {
                await deps.sleep(POLL_INTERVAL_MS);
                health = await probe(opts.server, deps);
            }
        }
        let up = health.up;
        if (!up) {
            const url = new URL(opts.server);
            if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
                return;
            mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
            const fd = openSync(join(opts.dataDir, "serve.log"), "a");
            try {
                const args = [deps.cliPath, "serve", "--port", url.port || "80", "--data-dir", opts.dataDir];
                deps.spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] }).unref();
            }
            finally {
                closeSync(fd);
            }
            for (let waited = 0; !up && waited < START_WAIT_MS; waited += POLL_INTERVAL_MS) {
                await deps.sleep(POLL_INTERVAL_MS);
                up = (await probe(opts.server, deps)).up;
            }
            if (!up)
                return;
        }
        // The server decides whether a GUI tab is already there; the answer is ignored
        await client.requestGuiOpen(GUI_OPEN_TIMEOUT_MS);
    }
    catch {
        // fail open
    }
}
//# sourceMappingURL=autostart.js.map