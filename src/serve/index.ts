import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { LEASE_GRACE_MS, type Decision } from "../contract.js";
import { readConfig } from "../settings/config.js";
import { startCodexBridge, type CodexBridge } from "./codex-bridge/index.js";
import { collectContext } from "./context.js";
import { PlanReadStore } from "./plan-read.js";
import { startPlanWatcher } from "./plan-watch.js";
import { listPlans, planNameOfPath, planSummary, plansDir } from "./plans.js";
import { createApp } from "./routes.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";

const DEFAULT_PORT = 4818;
const HOST = "127.0.0.1";

export type ServeOptions = {
  port?: number;
  dataDir?: string;
  leaseGraceMs?: number;
  /** Base of the allowed range for transcript / explanation paths. Defaults to os.homedir() */
  home?: string;
  /** Plan watcher timings (tests shorten them) */
  planPollMs?: number;
  planDebounceMs?: number;
  /** Run the Codex plan-approval bridge (a second client of the Codex app-server). Off unless asked: `run` turns it on */
  codexBridge?: boolean;
  /** Codex home whose app-server socket the bridge connects to (default: $CODEX_HOME, else ~/.codex) */
  codexHome?: string;
};

export type ServeHandle = {
  port: number;
  token: string;
  dataDir: string;
  store: Store;
  codexBridge?: CodexBridge;
  close: () => Promise<void>;
};

export async function start(opts: ServeOptions = {}): Promise<ServeHandle> {
  const dataDir = opts.dataDir ?? join(homedir(), ".ukagai");
  const home = opts.home ?? homedir();
  const hub = new SseHub();
  const planRead = new PlanReadStore(dataDir, plansDir(home));
  // First run (no plans-read.json): plans already on disk are not new
  if (!planRead.exists()) planRead.seed(await listPlans(home));
  // A resolved approval marks its plan read at the current mtime, so it does not come back as new in the other UI
  const markPlanRead = async (d: Decision): Promise<void> => {
    const filePath = (d.request as { planFilePath?: unknown }).planFilePath;
    if (typeof filePath !== "string" || filePath === "") return;
    const dir = plansDir(home);
    const name = await planNameOfPath(dir, filePath);
    if (!name) return;
    const summary = await planSummary(dir, name);
    if (!summary) return;
    planRead.mark(name, summary.mtime);
    hub.broadcast("plan.updated", { ...summary, read: true });
  };
  const store = new Store({
    dir: dataDir,
    leaseGraceMs: opts.leaseGraceMs ?? LEASE_GRACE_MS,
    broadcast: (event, data) => hub.broadcast(event, data),
    onPlanDecisionClosed: (d) => void markPlanRead(d).catch(() => {}),
  });
  store.load();

  const { lang } = await readConfig(dataDir);
  const token = randomBytes(32).toString("hex");

  let port = opts.port ?? DEFAULT_PORT;
  const app = createApp({
    planRead,
    store,
    hub,
    token,
    home,
    dataDir,
    lang,
    publicDir: fileURLToPath(new URL("../../public/", import.meta.url)),
    getPort: () => port,
    collect: (session) => collectContext(session, { home }),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: HOST }, (info) => {
      port = info.port;
      s.off("error", reject);
      resolve(s as Server);
    });
    s.once("error", reject);
  });
  // Write only after listening succeeds (a second server that dies on a busy port must not clobber the running server's token)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dataDir, "token");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  store.startMonitor();
  const planWatcher = startPlanWatcher({
    plansDir: plansDir(home),
    pollMs: opts.planPollMs,
    debounceMs: opts.planDebounceMs,
    // Re-read through planSummary so `read` reflects the current mark
    onChange: (summary) => {
      void planSummary(plansDir(home), summary.name, (n, m) => planRead.isRead(n, m))
        .then((s) => hub.broadcast("plan.updated", s ?? { ...summary, read: false }))
        .catch(() => {});
    },
    onRemove: (name) => hub.broadcast("plan.removed", { name }),
  });
  const codexBridge = opts.codexBridge
    ? startCodexBridge({ store, dataDir, lang, codexHome: opts.codexHome, collect: (session) => collectContext(session, { home }) })
    : undefined;

  return {
    port,
    token,
    dataDir,
    store,
    codexBridge,
    close: () =>
      new Promise<void>((resolve) => {
        codexBridge?.close();
        planWatcher.stop();
        store.close();
        hub.closeAll();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function run(argv: string[]): Promise<number> {
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
  } catch (err) {
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

  let handle: ServeHandle;
  try {
    handle = await start({
      port,
      dataDir: values["data-dir"],
      leaseGraceMs,
      codexBridge: !values["no-codex-bridge"],
      codexHome: values["codex-home"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = e?.code === "EADDRINUSE" ? `Port ${port} is in use (a server may already be running)` : err instanceof Error ? err.message : String(err);
    process.stderr.write(`ukagai serve: ${msg}\n`);
    return 1;
  }
  process.stdout.write(`ukagai serve: http://${HOST}:${handle.port}\n`);

  await new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  await handle.close();
  return 0;
}
