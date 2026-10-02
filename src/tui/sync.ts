import { ApiError, type StreamEvent } from "./api.js";
import type { App } from "./app.js";
import type { Decision } from "../contract.js";

// Sync with the server (does I/O, no screen): SSE reconnection and re-fetching the list after reconnecting.

export interface SyncApi {
  listPending(): Promise<Decision[]>;
  get(id: string): Promise<Decision>;
  stream(onEvent: (e: StreamEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void>;
}

export const RECONNECT_MIN_MS = 2000;
export const RECONNECT_MAX_MS = 5000;

/** Wait before the next reconnect after the nth failure (1-based): doubles from 2 seconds, capped at 5 seconds */
export const reconnectDelay = (failures: number): number =>
  Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures - 1));

/** Re-fetch the pending list. A decision still pending locally but missing from the list is fetched individually and dropped if the server no longer has it */
export async function refetch(api: SyncApi, app: App, now: () => number = Date.now): Promise<void> {
  const stale = app.replacePending(await api.listPending(), now());
  for (const id of stale) {
    try {
      app.upsert(await api.get(id), now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) app.drop(id, now());
      // Anything else is retried on the next fetch
    }
  }
}

export interface LoopOptions {
  onChange: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Keep subscribing to SSE. On a drop, wait and reconnect, syncing the list each time it connects */
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
      // Reconnect
    }
    if (signal.aborted) return;
    failures++;
    app.setConnected(false, now());
    o.onChange();
    await sleep(reconnectDelay(failures));
  }
}
