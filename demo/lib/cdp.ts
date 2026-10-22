// Chrome launch and a small DevTools (CDP) client. No dependencies: Node 22's global WebSocket.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";

// Flags that make compositing and drawing run in a fixed order, so the same input gives the same bytes.
export const RENDER_FLAGS = [
  "--disable-gpu",
  "--disable-partial-raster",
  "--disable-checker-imaging",
  "--run-all-compositor-stages-before-draw",
  "--disable-threaded-scrolling",
  "--disable-threaded-animation",
  "--font-render-hinting=none",
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function findChrome(): string | null {
  const fromEnv = process.env.UKAGAI_DEMO_CHROME;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["google-chrome", "chromium"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export type Key = "b" | "Enter" | "Escape" | "j" | "k" | "1" | "y";
const KEYS: Record<Key, { key: string; code: string; keyCode: number; text?: string }> = {
  b: { key: "b", code: "KeyB", keyCode: 66, text: "b" },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  j: { key: "j", code: "KeyJ", keyCode: 74, text: "j" },
  k: { key: "k", code: "KeyK", keyCode: 75, text: "k" },
  "1": { key: "1", code: "Digit1", keyCode: 49, text: "1" },
  y: { key: "y", code: "KeyY", keyCode: 89, text: "y" },
};

export interface PageSize {
  width: number;
  height: number;
  dsf: number;
}

export interface IdleOptions {
  quietMs?: number;
  timeoutMs?: number;
  ignoreUrl?: RegExp;
  ignoreTypes?: string[];
}

export interface Page {
  // Events from this page's session only.
  on(method: string, fn: (params: any) => void | Promise<void>): void;
  send(method: string, params?: object): Promise<any>;
  goto(url: string): Promise<void>;
  ev<T = any>(expr: string): Promise<T>;
  waitFor(expr: string, label: string, ms?: number): Promise<void>;
  waitNetworkIdle(opts?: IdleOptions): Promise<void>;
  key(name: Key): Promise<void>;
  click(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  png(): Promise<Buffer>;
  addInitScript(source: string): Promise<void>;
  addStyle(css: string): Promise<void>;
}

export interface Browser {
  page(size: PageSize): Promise<Page>;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  sessionId?: string;
  result?: any;
  error?: { message: string };
}

async function waitForDevTools(profileDir: string, ms: number): Promise<string> {
  const file = join(profileDir, "DevToolsActivePort");
  const end = Date.now() + ms;
  for (;;) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    if (Date.now() > end) throw new Error("Chrome did not expose DevToolsActivePort in 10 s");
    await sleep(100);
  }
}

export async function launchBrowser(opts: { chrome: string; profileDir: string }): Promise<Browser> {
  rmSync(opts.profileDir, { recursive: true, force: true });
  mkdirSync(opts.profileDir, { recursive: true });
  const proc: ChildProcess = spawn(
    opts.chrome,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${opts.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      ...RENDER_FLAGS,
      "--disable-background-networking",
      "--disable-component-update",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const wsUrl = await waitForDevTools(opts.profileDir, 10_000);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("CDP websocket failed")));
  });

  let seq = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Set<(m: CdpMessage) => void | Promise<void>>();
  ws.addEventListener("message", (ev) => {
    const m: CdpMessage = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message));
      else p.res(m.result);
      return;
    }
    if (m.method) for (const fn of listeners) void fn(m);
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  return {
    async page(size: PageSize): Promise<Page> {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const S = (method: string, params?: object) => send(method, params, sessionId);

      await S("Page.enable");
      await S("Network.enable");
      await S("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.dsf, mobile: false });
      await S("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "prefers-color-scheme", value: "light" },
        ],
      });

      const on = (method: string, fn: (params: any) => void | Promise<void>) => {
        listeners.add((m) => {
          if (m.sessionId === sessionId && m.method === method) void fn(m.params);
        });
      };

      // In-flight requests by id, for waitNetworkIdle.
      const inflight = new Map<string, string>();
      on("Network.requestWillBeSent", (p) => {
        if (p.type !== "Document" && !/\/api\/stream/.test(p.request.url)) inflight.set(p.requestId, p.request.url);
      });
      on("Network.loadingFinished", (p) => {
        inflight.delete(p.requestId);
      });
      on("Network.loadingFailed", (p) => {
        inflight.delete(p.requestId);
      });

      const ev = async (expr: string) => {
        const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
        return r.result.value;
      };

      const page: Page = {
        on,
        send: S,
        ev,
        async goto(url) {
          await S("Page.navigate", { url });
          await page.waitFor(`document.readyState === "complete"`, "page load");
        },
        async waitFor(expr, label, ms = 15_000) {
          const end = Date.now() + ms;
          for (;;) {
            let ok = false;
            try {
              ok = Boolean(await ev(`!!(${expr})`));
            } catch {
              ok = false;
            }
            if (ok) return;
            if (Date.now() > end) throw new Error(`${label} did not appear in ${ms / 1000} s`);
            await sleep(50);
          }
        },
        async waitNetworkIdle({ quietMs = 300, timeoutMs = 15_000, ignoreUrl = /\/api\/stream/, ignoreTypes = [] } = {}) {
          void ignoreTypes;
          const end = Date.now() + timeoutMs;
          let since = Date.now();
          for (;;) {
            for (const [id, url] of inflight) if (ignoreUrl.test(url)) inflight.delete(id);
            if (inflight.size > 0) since = Date.now();
            if (Date.now() - since >= quietMs) return;
            if (Date.now() > end) throw new Error(`network did not settle: ${[...inflight.values()].join(" ")}`);
            await sleep(25);
          }
        },
        async key(name) {
          const k = KEYS[name];
          await S("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text });
          await S("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
        },
        async click(x, y) {
          await S("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await S("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await S("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        },
        async move(x, y) {
          await S("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        },
        async png() {
          const r = await S("Page.captureScreenshot", { format: "png" });
          return Buffer.from(r.data, "base64");
        },
        async addInitScript(source) {
          await S("Page.addScriptToEvaluateOnNewDocument", { source });
        },
        async addStyle(css) {
          await ev(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.append(s); return true; })()`);
        },
      };
      return page;
    },
    async close() {
      ws.close();
      proc.kill();
      await sleep(300);
    },
  };
}
