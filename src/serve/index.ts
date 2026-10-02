import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { LEASE_GRACE_MS } from "../contract.js";
import { collectContext } from "./context.js";
import { createApp } from "./routes.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";

const DEFAULT_PORT = 4818;
const HOST = "127.0.0.1";

export type ServeOptions = {
  port?: number;
  dataDir?: string;
  leaseGraceMs?: number;
  /** transcript / explanation の許可範囲の基準。既定は os.homedir() */
  home?: string;
};

export type ServeHandle = {
  port: number;
  token: string;
  dataDir: string;
  store: Store;
  close: () => Promise<void>;
};

export async function start(opts: ServeOptions = {}): Promise<ServeHandle> {
  const dataDir = opts.dataDir ?? join(homedir(), ".ukagai");
  const home = opts.home ?? homedir();
  const hub = new SseHub();
  const store = new Store({
    dir: dataDir,
    leaseGraceMs: opts.leaseGraceMs ?? LEASE_GRACE_MS,
    broadcast: (event, data) => hub.broadcast(event, data),
  });
  store.load();

  const token = randomBytes(32).toString("hex");

  let port = opts.port ?? DEFAULT_PORT;
  const app = createApp({
    store,
    hub,
    token,
    home,
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
  // 待ち受けに成功してから書く(ポート使用中で落ちる 2 つ目が、動いている server の token を壊さない)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dataDir, "token");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  store.startMonitor();

  return {
    port,
    token,
    dataDir,
    store,
    close: () =>
      new Promise<void>((resolve) => {
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
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`ukagai serve: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (values.host !== undefined && values.host !== HOST) {
    process.stderr.write(`ukagai serve: --host は ${HOST} 固定です\n`);
    return 2;
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write("ukagai serve: --port が不正です\n");
    return 2;
  }
  const leaseGraceMs = values["lease-grace-ms"] === undefined ? undefined : Number(values["lease-grace-ms"]);
  if (leaseGraceMs !== undefined && !(leaseGraceMs >= 0)) {
    process.stderr.write("ukagai serve: --lease-grace-ms が不正です\n");
    return 2;
  }

  let handle: ServeHandle;
  try {
    handle = await start({ port, dataDir: values["data-dir"], leaseGraceMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = e?.code === "EADDRINUSE" ? `ポート ${port} は使用中です(server は起動済みかもしれません)` : err instanceof Error ? err.message : String(err);
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
