import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError, TuiApi } from "./api.js";
import { App, type Effect } from "./app.js";
import { ESC_TIMEOUT_MS, KeyParser } from "./keys.js";
import { renderFrame } from "./render.js";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const RECONNECT_MS = 2000;
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
    const frame = renderFrame(app.view(Date.now()), { cols, rows });
    app.clampScroll(frame.scrollMax);
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
      const stale = app.replacePending(await api.listPending(), Date.now());
      for (const id of stale) {
        try {
          app.upsert(await api.get(id), Date.now());
        } catch {
          // 次の再取得で
        }
      }
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
        else {
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

  // SSE。切れたら 2 秒後に再接続し、つなぎ直したら一覧を取り直す
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        void refetch();
        await api.stream((ev) => {
          app.upsert(ev.decision, Date.now());
          schedule();
        }, abort.signal);
      } catch {
        // 再接続へ
      }
      if (abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  })();

  return finished;
}
