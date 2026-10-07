import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError, TuiApi } from "./api.js";
import { refetch as syncOnce, streamLoop } from "./sync.js";
import { App, type Effect } from "./app.js";
import { ESC_TIMEOUT_MS, KeyParser } from "./keys.js";
import { renderFrame } from "./render.js";
import { LANGS, isLang, readConfig, type Lang } from "../settings/config.js";
import { t } from "./i18n.js";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const LEAVE_SCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";
const REFETCH_MS = 5000;

export interface Options {
  server: string;
  dataDir: string;
  /** Set by `--lang`; wins over config.json */
  lang?: Lang;
}

/** `--lang` wins; otherwise `lang` from <data-dir>/config.json (default en). */
export async function resolveLang(opts: Pick<Options, "dataDir" | "lang">): Promise<Lang> {
  return opts.lang ?? (await readConfig(opts.dataDir)).lang;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { server: "http://127.0.0.1:4818", dataDir: join(homedir(), ".ukagai") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") {
      const v = argv[++i];
      if (v) opts.server = v.replace(/\/+$/, "");
    } else if (a === "--data-dir") {
      const v = argv[++i];
      if (v) opts.dataDir = v;
    } else if (a === "--lang") {
      const v = argv[++i];
      if (!isLang(v)) throw new Error(`--lang must be one of: ${LANGS.join(", ")}`);
      opts.lang = v;
    }
  }
  return opts;
}

export async function run(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("ukagai tui: run in a TTY\n");
    return 1;
  }
  const api = new TuiApi(opts.server, opts.dataDir);
  const app = new App();
  app.server = opts.server;
  app.lang = await resolveLang(opts);
  app.langLocked = opts.lang !== undefined;
  // The server's live settings (language); the config.json read above stays when it cannot be reached
  try {
    app.settingsUpdated(await api.settings());
  } catch {
    // Fallback: config.json (lang above); the default colours
  }
  app.fetchHistory = (id) => api.history(id);
  app.fetchPlan = (name) => api.plan(name);
  app.fetchVersions = (sid, current) => api.planVersions(sid, current);
  app.copySupported = spawnSync("sh", ["-c", "command -v pbcopy"], { stdio: "ignore" }).status === 0;
  try {
    app.replacePending(await api.listPending(), Date.now());
    app.setSessions(await api.sessions().catch(() => []));
  } catch (e) {
    const why = e instanceof ApiError ? `(${e.message})` : "";
    process.stderr.write(`ukagai tui: cannot connect to the server (${opts.server})${why}. It starts automatically when you launch claude\n`);
    return 1;
  }

  const out = process.stdout;
  const parser = new KeyParser();
  const abort = new AbortController();
  let escTimer: NodeJS.Timeout | undefined;
  let paintTimer: NodeJS.Timeout | undefined;

  const paint = () => {
    paintTimer = undefined;
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    let frame = renderFrame(app.view(Date.now()), { cols, rows });
    if (app.syncFrame(frame)) frame = renderFrame(app.view(Date.now()), { cols, rows });
    let buf = "";
    // Erasing at the end of the line would drop the last character of a line written to the final column, so erase first and then write
    for (let r = 0; r < rows; r++) buf += `\x1b[${r + 1};1H\x1b[0m\x1b[2K${frame.lines[r] ?? ""}\x1b[0m`;
    out.write(buf);
  };
  const schedule = () => {
    if (!paintTimer) paintTimer = setTimeout(paint, 10);
  };

  app.onHistory = schedule;
  app.onPlans = schedule;

  const refetch = async () => {
    try {
      await syncOnce(api, app, Date.now, app.down);
      schedule();
    } catch {
      // While disconnected, leave it to the SSE reconnect and the next refetch
    }
  };

  const finished = new Promise<number>((resolve) => {
    let closed = false;
    const quit = (code: number) => {
      if (closed) return;
      closed = true;
      abort.abort();
      clearInterval(tick);
      clearInterval(poll);
      clearTimeout(escTimer);
      clearTimeout(paintTimer);
      process.stdin.removeAllListeners("data");
      out.removeListener("resize", schedule);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write(LEAVE_SCREEN);
      resolve(code);
    };

    const runEffects = (effects: Effect[]) => {
      for (const e of effects) {
        if (e.type === "quit") quit(0);
        else if (e.type === "read") {
          // Failing to mark a plan read is harmless: it just stays new
          void api.markRead(e.name, e.mtime).catch(() => {});
        } else if (e.type === "instruct_plan") {
          void api.instructPlan(e.name, e.text).then(
            (via) => {
              app.planInstructed(e.name, via, Date.now());
              schedule();
            },
            (err: unknown) => {
              app.planInstructFailed(e.name, err instanceof Error ? err.message : String(err), Date.now());
              schedule();
            },
          );
        } else if (e.type === "copy") {
          if (!app.copySupported) continue;
          const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
          p.on("error", () => {
            app.note(t(app.lang, "copy_failed"), Date.now());
            schedule();
          });
          p.on("close", (code) => {
            app.note(t(app.lang, code === 0 ? "copied" : "copy_failed"), Date.now());
            schedule();
          });
          p.stdin.on("error", () => {});
          p.stdin.end(e.text);
        } else {
          void api.answer(e.id, e.body).then(
            (d) => {
              app.answered(d, Date.now());
              schedule();
            },
            (err: unknown) => {
              app.failed(e.id, err instanceof Error ? err.message : String(err), Date.now());
              schedule();
            },
          );
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (chunk: string) => {
      clearTimeout(escTimer);
      for (const k of parser.feed(chunk)) runEffects(app.handle(k, Date.now()));
      if (parser.hasPending) {
        escTimer = setTimeout(() => {
          for (const k of parser.flush()) runEffects(app.handle(k, Date.now()));
          schedule();
        }, ESC_TIMEOUT_MS);
      }
      schedule();
    });
    out.on("resize", schedule);
    process.on("SIGTERM", () => quit(0));
    process.on("SIGHUP", () => quit(0));

    // Refresh elapsed times and toasts, and refetch in case SSE is unavailable
    // A 250 ms tick; repaint every second
    let beat = 0;
    const tick = setInterval(() => {
      if (++beat % 4 === 0) schedule();
    }, 250);
    const poll = setInterval(() => void refetch(), REFETCH_MS);

    out.write(ENTER_SCREEN);
    schedule();
  });

  // SSE: on a drop, reconnect after 2 seconds (capped at 5 afterwards) and sync the list each time it connects
  void streamLoop(api, app, abort.signal, { onChange: schedule });

  return finished;
}
