import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { appendLogLine } from "../log.js";
import { LEASE_GRACE_MS, plansDir } from "../contract.js";
import { startCodexBridge } from "./codex-bridge/index.js";
import { collectContext } from "./context.js";
import { startCheckpointDelivery } from "./deliver.js";
import { GuiOpener } from "./gui-open.js";
import { PlanReadStore } from "./plan-read.js";
import { startPlanWatcher } from "./plan-watch.js";
import { startRecapWatcher } from "./recap-watch.js";
import { PlanSessions } from "./plan-session.js";
import { PlanReady } from "./plan-ready.js";
import { listPlans, planNameOfPath, planSummary, planSummarySync } from "./plans.js";
import { createApp } from "./routes.js";
import { SettingsStore } from "./settings.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";
import { HerdrTerminal, NoTerminal } from "./terminal.js";
const DEFAULT_PORT = 4818;
const HOST = "127.0.0.1";
export async function start(opts = {}) {
    const dataDir = opts.dataDir ?? join(homedir(), ".ukagai");
    const home = opts.home ?? homedir();
    const dir = plansDir(home);
    const hub = new SseHub();
    const planRead = new PlanReadStore(dataDir, dir);
    const log = (event, fields) => appendLogLine(join(dataDir, "serve.log"), event, fields);
    // First run (no plans-read.json): plans already on disk are not new
    if (!planRead.exists())
        planRead.seed(await listPlans(home));
    let planReady;
    const store = new Store({
        dir: dataDir,
        leaseGraceMs: opts.leaseGraceMs ?? LEASE_GRACE_MS,
        handoffGraceMs: opts.handoffGraceMs,
        broadcast: (event, data) => {
            hub.broadcast(event, data);
            // A session's state or decisions changed: a plan of it may have become ready (or stopped being so) without its file changing
            if (event === "session.updated")
                planReady?.recheck(data.session_id);
            else if (event === "decision.created" || event === "decision.updated")
                planReady?.recheck(data.session.session_id);
        },
        log,
        planNameOf: (filePath) => planNameOfPath(dir, filePath),
        // A plan decision that leaves `pending` marks its plan read at the current mtime, synchronously and before the store
        // emits decision.updated, so the other UI never sees the closed decision with the plan still new
        onTransition: (d, from) => {
            if (d.kind !== "approve_plan" || from !== "pending" || !d.plan_name)
                return;
            const summary = planSummarySync(dir, d.plan_name);
            if (!summary)
                return;
            planRead.mark(d.plan_name, summary.mtime);
            const session_id = planSessions.cached(d.plan_name);
            planReady?.announce({ ...summary, read: true, ...(session_id ? { session_id } : {}) });
        },
    });
    store.load();
    // A plan whose session is found after the plan was announced (the transcript gets its slug lazily): tell the UIs
    const planSessions = new PlanSessions(() => store.listSessions(), home, Date.now, (name, session_id) => {
        void planSummary(dir, name, planRead.isRead).then((summary) => {
            if (summary)
                planReady?.announce({ ...summary, session_id });
        });
    });
    planReady = new PlanReady(store, planSessions, (event, data) => hub.broadcast(event, data), dataDir);
    const settings = await SettingsStore.load(dataDir);
    const { lang } = settings.get();
    const token = randomBytes(32).toString("hex");
    let port = opts.port ?? DEFAULT_PORT;
    const guiOpener = new GuiOpener({
        dataDir,
        port: () => port,
        hub,
        spawn: (cmd, args, o) => nodeSpawn(cmd, args, o),
        platform: process.platform,
        now: () => new Date(),
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
        log,
    });
    const app = createApp({
        planRead,
        store,
        hub,
        token,
        home,
        planSessions,
        planReady,
        dataDir,
        lang,
        settings,
        publicDir: fileURLToPath(new URL("../../public/", import.meta.url)),
        getPort: () => port,
        cliPath: ((p) => (existsSync(p) ? p : undefined))(opts.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url))),
        shutdown: () => {
            void close().then(() => opts.onShutdown?.());
        },
        guiOpener,
        log,
        collect: (session) => collectContext(session, { home }),
    });
    // Assigned below once the pieces to stop exist; POST /api/shutdown and the handle share it (idempotent)
    let closing;
    const close = () => (closing ??= doClose());
    let doClose = () => Promise.resolve();
    const server = await new Promise((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port, hostname: HOST }, (info) => {
            port = info.port;
            s.off("error", reject);
            resolve(s);
        });
        s.once("error", reject);
    });
    // Write only after listening succeeds (a second server that dies on a busy port must not clobber the running server's token)
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // The launcher's last resort for plugin-only installs: the node that runs this server
    try {
        writeFileSync(join(dataDir, "node-path"), process.execPath + "\n", { mode: 0o644 });
    }
    catch {
        // best effort
    }
    const tokenFile = join(dataDir, "token");
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    store.startMonitor();
    const planWatcher = startPlanWatcher({
        plansDir: dir,
        pollMs: opts.planPollMs,
        debounceMs: opts.planDebounceMs,
        isRead: planRead.isRead,
        // The lookup comes first: it records what this announcement carries, so a later find is a change
        onChange: (summary) => {
            void planSessions.find(summary.name).then((session_id) => planReady.announce(session_id ? { ...summary, session_id } : summary));
        },
        onRemove: (name) => {
            planRead.remove(name);
            planReady.forget(name);
            hub.broadcast("plan.removed", { name });
        },
    });
    // UKAGAI_TERMINAL=none: no terminal at all (the test script sets it so no test asks the real herdr)
    const terminal = opts.terminal ?? (process.env.UKAGAI_TERMINAL === "none" ? new NoTerminal() : new HerdrTerminal("herdr", (error) => log("herdr_failed", { error })));
    // Looks for the session of every plan file on a timer: without a client asking, nobody else would
    const sessionPoll = setInterval(() => {
        void listPlans(home, planRead.isRead).then((plans) => Promise.all(plans.map((p) => planSessions.find(p.name)))).catch(() => { });
    }, opts.planPollMs ?? 10000);
    sessionPoll.unref();
    startCheckpointDelivery({ store, terminal, log, settings, pollMs: opts.terminalPollMs });
    const recapWatcher = startRecapWatcher({ store, home, pollMs: opts.recapPollMs, settings, log });
    const codexBridge = opts.codexBridge
        ? startCodexBridge({ store, dataDir, lang, settings, codexHome: opts.codexHome, checkpointDelayMs: opts.codexCheckpointDelayMs, collect: (session) => collectContext(session, { home }) })
        : undefined;
    doClose = () => new Promise((resolve) => {
        codexBridge?.close();
        planWatcher.stop();
        clearInterval(sessionPoll);
        recapWatcher.stop();
        store.close();
        hub.closeAll();
        void settings.flush();
        server.close(() => resolve());
        server.closeAllConnections();
    });
    return {
        port,
        token,
        dataDir,
        store,
        settings,
        codexBridge,
        close,
    };
}
export async function run(argv) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                port: { type: "string" },
                host: { type: "string" },
                "data-dir": { type: "string" },
                "lease-grace-ms": { type: "string" },
                "no-codex-bridge": { type: "boolean" },
                "codex-home": { type: "string" },
            },
            strict: true,
        }));
    }
    catch (err) {
        process.stderr.write(`ukagai serve: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
    }
    if (values.host !== undefined && values.host !== HOST) {
        process.stderr.write(`ukagai serve: --host is fixed to ${HOST}\n`);
        return 2;
    }
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write("ukagai serve: invalid --port\n");
        return 2;
    }
    const leaseGraceMs = values["lease-grace-ms"] === undefined ? undefined : Number(values["lease-grace-ms"]);
    if (leaseGraceMs !== undefined && !(leaseGraceMs >= 0)) {
        process.stderr.write("ukagai serve: invalid --lease-grace-ms\n");
        return 2;
    }
    let handle;
    let onShutdown = () => { };
    try {
        handle = await start({
            onShutdown: () => onShutdown(),
            port,
            dataDir: values["data-dir"],
            leaseGraceMs,
            codexBridge: !values["no-codex-bridge"],
            codexHome: values["codex-home"],
        });
    }
    catch (err) {
        const e = err;
        const msg = e?.code === "EADDRINUSE" ? `Port ${port} is in use (a server may already be running)` : err instanceof Error ? err.message : String(err);
        process.stderr.write(`ukagai serve: ${msg}\n`);
        return 1;
    }
    process.stdout.write(`ukagai serve: http://${HOST}:${handle.port}\n`);
    await new Promise((resolve) => {
        onShutdown = resolve;
        const onSignal = () => resolve();
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
    });
    await handle.close();
    return 0;
}
//# sourceMappingURL=index.js.map