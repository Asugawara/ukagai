import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError, TuiApi } from "./api.js";
import { refetch as syncOnce, streamLoop } from "./sync.js";
import { App, type Effect } from "./app.js";
import { ESC_TIMEOUT_MS, KeyParser } from "./keys.js";
import { renderFrame } from "./render.js";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const LEAVE_SCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";
const REFETCH_MS = 5000;

interface Options {
  server: string;
  dataDir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { server: "http://127.0.0.1:4818", dataDir: join(homedir(), ".ukagai") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") {
      const v = argv[++i];
      if (v) opts.server = v.replace(/\/+$/, "");
    } else if (a === "--data-dir") {
      const v = argv[++i];
      if (v) opts.dataDir = v;
    }
  }
  return opts;
}

export async function run(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("ukagai tui: TTY で実行してください\n");
    return 1;
  }
  const api = new TuiApi(opts.server, opts.dataDir);
  const app = new App();
  app.server = opts.server;
  app.copySupported = spawnSync("sh", ["-c", "command -v pbcopy"], { stdio: "ignore" }).status === 0;
  try {
    app.replacePending(await api.listPending(), Date.now());
  } catch (e) {
    const why = e instanceof ApiError ? `(${e.message})` : "";
    process.stderr.write(`ukagai tui: server に接続できません(${opts.server})${why}。claude を起動すると自動で立ち上がります\n`);
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
    // 行末で消去すると最終桁まで書いた行の末尾 1 文字が消えるので、先に消してから書く
    for (let r = 0; r < rows; r++) buf += `\x1b[${r + 1};1H\x1b[0m\x1b[2K${frame.lines[r] ?? ""}\x1b[0m`;
    out.write(buf);
  };
  const schedule = () => {
    if (!paintTimer) paintTimer = setTimeout(paint, 10);
  };

  const refetch = async () => {
    try {
      await syncOnce(api, app);
      schedule();
    } catch {
      // 切れているあいだは SSE の再接続と次の再取得に任せる
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
        else if (e.type === "copy") {
          if (!app.copySupported) continue;
          const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
          p.on("error", () => {
            app.note("コピーできませんでした", Date.now());
            schedule();
          });
          p.on("close", (code) => {
            app.note(code === 0 ? "コピーしました" : "コピーできませんでした", Date.now());
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

    // 経過時間・トーストの更新と、SSE が使えない場合の再取得
    const tick = setInterval(schedule, 1000);
    const poll = setInterval(() => void refetch(), REFETCH_MS);

    out.write(ENTER_SCREEN);
    schedule();
  });

  // SSE。切れたら 2 秒後(以後 5 秒上限)に再接続し、つながるたびに一覧を同期する
  void streamLoop(api, app, abort.signal, { onChange: schedule });

  return finished;
}
