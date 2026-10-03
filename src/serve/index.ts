import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { LEASE_GRACE_MS, plansDir } from "../contract.js";
import { readConfig } from "../settings/config.js";
import { startCodexBridge, type CodexBridge } from "./codex-bridge/index.js";
import { collectContext } from "./context.js";
import { PlanReadStore } from "./plan-read.js";
import { startPlanWatcher } from "./plan-watch.js";
import { startRecapWatcher } from "./recap-watch.js";
import { listPlans, planNameOfPath, planSummarySync } from "./plans.js";
import { createApp } from "./routes.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";

const DEFAULT_PORT = 4818;
const HOST = "127.0.0.1";

export type ServeOptions = {
  port?: number;
  dataDir?: string;
  leaseGraceMs?: number;
  /** Lease after a hand-off: how long the agent has to call the tool again (default 120 s) */
  handoffGraceMs?: number;
  /** Base of the allowed range for transcript / explanation paths. Defaults to os.homedir() */
  home?: string;
  /** Plan watcher timings (tests shorten them) */
  planPollMs?: number;
  planDebounceMs?: number;
  /** Recap watcher poll interval (default 5 s; tests shorten it) */
  recapPollMs?: number;
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
  const dir = plansDir(home);
  const hub = new SseHub();
  const planRead = new PlanReadStore(dataDir, dir);
  // First run (no plans-read.json): plans already on disk are not new
  if (!planRead.exists()) planRead.seed(await listPlans(home));
  const store = new Store({
    dir: dataDir,
    leaseGraceMs: opts.leaseGraceMs ?? LEASE_GRACE_MS,
    handoffGraceMs: opts.handoffGraceMs,
    broadcast: (event, data) => hub.broadcast(event, data),
    planNameOf: (filePath) => planNameOfPath(dir, filePath),
    // A plan decision that leaves `pending` marks its plan read at the current mtime, synchronously and before the store
    // emits decision.updated, so the other UI never sees the closed decision with the plan still new
    onTransition: (d, from) => {
      if (d.kind !== "approve_plan" || from !== "pending" || !d.plan_name) return;
      const summary = planSummarySync(dir, d.plan_name);
      if (!summary) return;
      planRead.mark(d.plan_name, summary.mtime);
      hub.broadcast("plan.updated", { ...summary, read: true });
    },
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
    plansDir: dir,
    pollMs: opts.planPollMs,
    debounceMs: opts.planDebounceMs,
    isRead: planRead.isRead,
    onChange: (summary) => hub.broadcast("plan.updated", summary),
    onRemove: (name) => {
      planRead.remove(name);
      hub.broadcast("plan.removed", { name });
    },
  });
  const recapWatcher = startRecapWatcher({ store, home, pollMs: opts.recapPollMs });
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
        recapWatcher.stop();
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
