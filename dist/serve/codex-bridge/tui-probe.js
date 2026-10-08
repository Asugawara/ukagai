import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";
import { basename } from "node:path";
const TIMEOUT_MS = 5000;
/** On a non-zero exit the rejection carries stdout (lsof exits 1 when a pid is gone, with the rest on stdout). SIGKILL so a stuck child cannot hold the checkpoint forever */
const runWith = (timeout) => (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)));
});
/** Splits on whitespace; enough to read the executable and spot `app-server` (no quoting rules needed) */
function tokens(command) {
    return command.trim().split(/\s+/).filter(Boolean);
}
/**
 * `ps -axo pid=,command=` → pids of Codex CLI processes (the `node …/bin/codex` wrapper and the native `…/codex` binary).
 * `codex app-server …` (the daemon, an IDE extension's own server) is not a TUI.
 */
export function parsePsCodexPids(out) {
    const pids = [];
    for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m)
            continue;
        const toks = tokens(m[2]);
        let exe = toks[0] ?? "";
        let rest = toks.slice(1);
        if (/^node(\.exe)?$/.test(basename(exe)) && toks.length > 1) {
            // node's own flags (`--no-warnings`) come before the script
            const i = toks.findIndex((tok, n) => n > 0 && !tok.startsWith("-"));
            if (i > 0) {
                exe = toks[i];
                rest = toks.slice(i + 1);
            }
        }
        const name = basename(exe);
        if (name !== "codex" && name !== "codex.js" && !name.startsWith("codex-"))
            continue;
        // Only the subcommand: a prompt that mentions app-server is still a TUI
        if (rest.find((tok) => !tok.startsWith("-") && !tok.includes("=")) === "app-server")
            continue;
        pids.push(Number(m[1]));
    }
    return pids;
}
/** `lsof -a -p … -d cwd -Fn` records: `p<pid>` then `n<path>` → cwd per pid */
export function parseLsofCwds(out) {
    const cwds = new Map();
    let pid;
    for (const line of out.split("\n")) {
        if (line.startsWith("p"))
            pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid !== undefined && Number.isFinite(pid))
            cwds.set(pid, line.slice(1));
    }
    return cwds;
}
const real = (p) => realpath(p).catch(() => p);
async function cwdsOf(pids, platform, exec) {
    if (pids.length === 0)
        return [];
    if (platform === "linux") {
        const all = await Promise.all(pids.map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => undefined)));
        const cwds = all.filter((c) => c !== undefined);
        // Processes but no readable cwd (hidepid, other uid): cannot tell
        if (cwds.length === 0)
            throw new Error("no readable cwd");
        return cwds;
    }
    // lsof exits 1 when some pid is gone meanwhile; its stdout still holds the others
    const out = await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]).catch((err) => (typeof err?.stdout === "string" && err.stdout ? err.stdout : Promise.reject(err)));
    return [...parseLsofCwds(out).values()];
}
/**
 * Is a Codex TUI process running with `cwd` as its working directory?
 * undefined = cannot tell (unsupported platform, ps / lsof missing or failed, timeout).
 */
export async function tuiRunningIn(cwd, opts = {}) {
    const platform = opts.platform ?? process.platform;
    const exec = opts.exec ?? runWith(opts.timeoutMs ?? TIMEOUT_MS);
    if (platform !== "linux" && platform !== "darwin")
        return undefined;
    try {
        const pids = parsePsCodexPids(await exec("ps", ["-axo", "pid=,command="]));
        const cwds = await cwdsOf(pids, platform, exec);
        const want = await real(cwd);
        for (const c of cwds)
            if ((await real(c)) === want)
                return true;
        return false;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=tui-probe.js.map