import type { SpawnOptions } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SseHub } from "./sse.js";

/** A reconnecting pinned tab retries every 5 s at most: give it this long before opening a new tab */
export const GRACE_MS = 8000;

export type GuiOpenResult = "opened_today" | "connected" | "pending";

export interface GuiOpenerDeps {
  dataDir: string;
  port: () => number;
  hub: Pick<SseHub, "browsers">;
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void };
  platform: NodeJS.Platform;
  now: () => Date;
  setTimeout: (fn: () => void, ms: number) => unknown;
  log?: (event: string, fields?: Record<string, string | number | undefined>) => void;
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Owns the once-a-day GUI open: a connected GUI tab (or one that reconnects within the grace) means no new tab */
export class GuiOpener {
  private timer = false;

  constructor(private readonly deps: GuiOpenerDeps) {}

  private get marker(): string {
    return join(this.deps.dataDir, "gui-opened");
  }

  private today(): string {
    return localDate(this.deps.now());
  }

  private writeMarker(): void {
    mkdirSync(this.deps.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.marker, this.today() + "\n");
  }

  request(): GuiOpenResult {
    try {
      let last = "";
      try {
        last = readFileSync(this.marker, "utf8").trim();
      } catch {
        // no marker: first time
      }
      if (last === this.today()) return "opened_today";
      if (this.deps.hub.browsers > 0) {
        this.writeMarker();
        this.deps.log?.("gui_open", { result: "connected", opened: "no" });
        return "connected";
      }
      if (!this.timer) {
        this.timer = true;
        this.deps.setTimeout(() => this.fire(), GRACE_MS);
      }
      return "pending";
    } catch {
      return "pending";
    }
  }

  private fire(): void {
    this.timer = false;
    try {
      this.writeMarker();
      let opened = false;
      if (this.deps.hub.browsers === 0) {
        const opener = this.deps.platform === "darwin" ? "open" : this.deps.platform === "linux" ? "xdg-open" : undefined;
        if (opener) {
          this.deps.spawn(opener, [`http://127.0.0.1:${this.deps.port()}/?autostart=1`], { detached: true, stdio: "ignore" }).unref();
          opened = true;
        }
      }
      this.deps.log?.("gui_open", { result: "pending", opened: opened ? "yes" : "no" });
    } catch {
      // never throws
    }
  }
}
