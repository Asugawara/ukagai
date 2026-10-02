import { ApiError, type StreamEvent } from "./api.js";
import type { App } from "./app.js";
import type { Decision } from "../contract.js";

// server との同期(I/O あり、画面なし)。SSE の再接続と、つなぎ直したときの一覧の取り直し。

export interface SyncApi {
  listPending(): Promise<Decision[]>;
  get(id: string): Promise<Decision>;
  stream(onEvent: (e: StreamEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void>;
}

export const RECONNECT_MIN_MS = 2000;
export const RECONNECT_MAX_MS = 5000;

/** 失敗 n 回目(1 始まり)の次の再接続までの待ち。2 秒から倍々で、5 秒が上限 */
export const reconnectDelay = (failures: number): number =>
  Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures - 1));

/** pending の一覧を取り直す。手元で pending のまま一覧から消えた判断は個別に取り、server に無ければ除く */
export async function refetch(api: SyncApi, app: App, now: () => number = Date.now): Promise<void> {
  const stale = app.replacePending(await api.listPending(), now());
  for (const id of stale) {
    try {
      app.upsert(await api.get(id), now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) app.drop(id, now());
      // それ以外は次の再取得で
    }
  }
}

export interface LoopOptions {
  onChange: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** SSE を購読し続ける。切れたら待って再接続し、つながるたびに一覧を同期する */
export async function streamLoop(api: SyncApi, app: App, signal: AbortSignal, o: LoopOptions): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let failures = 0;
  while (!signal.aborted) {
    try {
      await api.stream(
        (ev) => {
          app.upsert(ev.decision, now());
          o.onChange();
        },
        signal,
        () => {
          failures = 0;
          app.setConnected(true, now());
          o.onChange();
          void refetch(api, app, now).then(o.onChange, () => {});
        },
      );
    } catch {
      // 再接続へ
    }
    if (signal.aborted) return;
    failures++;
    app.setConnected(false, now());
    o.onChange();
    await sleep(reconnectDelay(failures));
  }
}
