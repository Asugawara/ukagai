// 端末の入力バイト列 → キー → 操作(Action)。副作用なし。

export type Key =
  | { name: "char"; ch: string }
  | { name: "up" | "down" | "left" | "right" | "enter" | "esc" | "backspace" | "tab" | "ctrl-c" | "ctrl-d" | "ctrl-u" | "pgup" | "pgdn" };

/** Esc 単独と矢印のエスケープ列を分ける待ち時間 */
export const ESC_TIMEOUT_MS = 30;

const CSI: Record<string, Key["name"]> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "OA": "up",
  "OB": "down",
  "OC": "right",
  "OD": "left",
  "[5~": "pgup",
  "[6~": "pgdn",
};

/**
 * 入力のチャンクをキー列にする。チャンク末尾の `ESC` や `ESC [` は続きが来るかもしれないので保留し、
 * 呼び出し側が ESC_TIMEOUT_MS 後に flush() する。
 */
export class KeyParser {
  private pending = "";

  /** 保留中の入力があるか(タイマーを張る目安) */
  get hasPending(): boolean {
    return this.pending !== "";
  }

  feed(data: string): Key[] {
    const s = this.pending + data;
    this.pending = "";
    const keys: Key[] = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\x1b") {
        const rest = s.slice(i + 1);
        if (rest === "" || rest === "[" || rest === "O" || /^\[[0-9;]*$/.test(rest)) {
          this.pending = s.slice(i);
          break;
        }
        const m = /^(\[[0-9;]*[~A-Za-z]|O[A-D])/.exec(rest);
        if (m) {
          const name = CSI[m[1]!];
          if (name) keys.push({ name } as Key);
          i += 1 + m[1]!.length;
          continue;
        }
        keys.push({ name: "esc" });
        i++;
        continue;
      }
      i += this.one(s, i, keys);
    }
    return keys;
  }

  /** 保留していた入力を確定する(ESC 単独 → esc。中途半端な列は捨てる) */
  flush(): Key[] {
    const p = this.pending;
    this.pending = "";
    return p === "\x1b" ? [{ name: "esc" }] : [];
  }

  private one(s: string, i: number, keys: Key[]): number {
    const cp = s.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = s.slice(i, i + len);
    if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\x03") keys.push({ name: "ctrl-c" });
    else if (ch === "\x04") keys.push({ name: "ctrl-d" });
    else if (ch === "\x15") keys.push({ name: "ctrl-u" });
    else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (cp >= 0x20) keys.push({ name: "char", ch });
    return len;
  }
}

// ---- 操作 ----

export type Mode = "normal" | "input" | "list";
export type Kind = "question" | "plan";

export type Action =
  | { type: "move"; delta: 1 | -1 }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "toggle" }
  | { type: "submit" }
  | { type: "free" }
  | { type: "prev" }
  | { type: "next" }
  | { type: "list" }
  | { type: "quit" }
  | { type: "approve" }
  | { type: "approve-auto" }
  | { type: "reject" }
  | { type: "scroll"; delta: 1 | -1 }
  | { type: "input-char"; ch: string }
  | { type: "input-backspace" }
  | { type: "input-confirm" }
  | { type: "input-cancel" }
  | { type: "list-move"; delta: 1 | -1 }
  | { type: "list-pick" }
  | { type: "list-close" };

export interface KeyContext {
  mode: Mode;
  kind: Kind;
  /** gg の 1 つ目の g の時刻(無ければ 0) */
  lastG: number;
  now: number;
}

export const GG_WINDOW_MS = 1000;

/** キーを操作にする。lastG は次回の文脈に渡す */
export function interpret(key: Key, ctx: KeyContext): { action: Action | null; lastG: number } {
  const done = (action: Action | null, lastG = 0) => ({ action, lastG });
  if (key.name === "ctrl-c") return done({ type: "quit" });

  if (ctx.mode === "input") {
    switch (key.name) {
      case "enter": return done({ type: "input-confirm" });
      case "esc": return done({ type: "input-cancel" });
      case "backspace": return done({ type: "input-backspace" });
      case "char": return done({ type: "input-char", ch: key.ch });
      default: return done(null);
    }
  }

  const down = key.name === "down" || (key.name === "char" && key.ch === "j");
  const up = key.name === "up" || (key.name === "char" && key.ch === "k");

  if (ctx.mode === "list") {
    if (down) return done({ type: "list-move", delta: 1 });
    if (up) return done({ type: "list-move", delta: -1 });
    if (key.name === "enter") return done({ type: "list-pick" });
    if (key.name === "esc" || (key.name === "char" && key.ch === "b")) return done({ type: "list-close" });
    if (key.name === "char" && key.ch === "q") return done({ type: "quit" });
    return done(null);
  }

  const ch = key.name === "char" ? key.ch : null;
  if (ch === "q") return done({ type: "quit" });
  if (ch === "h" || key.name === "left") return ctx.kind === "plan" && key.name === "left" ? done({ type: "move", delta: -1 }) : done({ type: "prev" });
  if (ch === "l" || key.name === "right") return ctx.kind === "plan" && key.name === "right" ? done({ type: "move", delta: 1 }) : done({ type: "next" });
  if (ch === "b") return done({ type: "list" });
  if (key.name === "ctrl-d" || key.name === "pgdn") return done({ type: "scroll", delta: 1 });
  if (key.name === "ctrl-u" || key.name === "pgup") return done({ type: "scroll", delta: -1 });
  if (down) return done({ type: "move", delta: 1 });
  if (up) return done({ type: "move", delta: -1 });
  if (key.name === "enter") return done({ type: "submit" });

  if (ctx.kind === "plan") {
    if (ch === "y") return done({ type: "approve" });
    if (ch === "a") return done({ type: "approve-auto" });
    if (ch === "n") return done({ type: "reject" });
    return done(null);
  }

  if (ch === "g") {
    return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "top" }) : done(null, ctx.now);
  }
  if (ch === "G") return done({ type: "bottom" });
  if (ch === " ") return done({ type: "toggle" });
  if (ch === "i") return done({ type: "free" });
  return done(null);
}
