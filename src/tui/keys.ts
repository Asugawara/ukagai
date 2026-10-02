// Terminal input bytes to keys to actions. No side effects.

export type Key =
  | { name: "char"; ch: string }
  | { name: "up" | "down" | "left" | "right" | "enter" | "esc" | "backspace" | "tab" | "ctrl-c" | "ctrl-d" | "ctrl-u" | "pgup" | "pgdn" | "home" | "end" }
  /** Horizontal wheel (SGR button 66 = left, 67 = right) */
  | { name: "hwheel"; dir: "left" | "right" }
  /** Mouse wheel (SGR report). x / y are 1-based terminal coordinates */
  | { name: "wheel"; dir: "up" | "down"; x: number; y: number };

/** How long to wait to tell a lone Esc from an arrow escape sequence */
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
  "[H": "home",
  "[F": "end",
  "[1~": "home",
  "[4~": "end",
  "[7~": "home",
  "[8~": "end",
  "OH": "home",
  "OF": "end",
};

/**
 * Turn an input chunk into keys. A trailing `ESC` or `ESC [` may be continued by the next chunk, so it is held and
 * the caller flush()es it after ESC_TIMEOUT_MS.
 */
export class KeyParser {
  private pending = "";

  /** Whether input is being held (a hint to arm the timer) */
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
        if (rest === "" || rest === "[" || rest === "O" || /^\[<?[0-9;]*$/.test(rest)) {
          this.pending = s.slice(i);
          break;
        }
        // SGR mouse report `ESC [ < b ; x ; y M|m`. Only the wheel is picked up; clicks and drags are dropped
        const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (mouse) {
          const b = Number(mouse[1]);
          if (mouse[4] === "M" && b & 64 && (b & 3) >= 2) {
            keys.push({ name: "hwheel", dir: b & 1 ? "right" : "left" });
          } else if (mouse[4] === "M" && b & 64) {
            keys.push({ name: "wheel", dir: b & 1 ? "down" : "up", x: Number(mouse[2]), y: Number(mouse[3]) });
          }
          i += 1 + mouse[0].length;
          continue;
        }
        const m = /^(\[[0-9;]*[~A-Za-z]|O[A-DHF])/.exec(rest);
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

  /** Commit held input (a lone ESC becomes esc; incomplete sequences are dropped) */
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

// ---- Actions ----

export type Mode = "normal" | "input" | "list" | "none";
export type Kind = "question" | "plan";
/** The column that arrows and j/k act on. background = the left explanation, decision = the right-hand decision */
export type Focus = "background" | "decision";

export type Action =
  | { type: "move"; delta: 1 | -1 }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "toggle" }
  | { type: "submit" }
  | { type: "free" }
  | { type: "copy" }
  | { type: "rec" }
  | { type: "prev" }
  | { type: "next" }
  | { type: "list" }
  | { type: "quit" }
  | { type: "approve" }
  | { type: "approve-auto" }
  | { type: "reject" }
  /** Jump the background to the next footnote definition (`e`) */
  | { type: "footnote" }
  /** "None of these…": open the reason picker, move in it, send, add a note, close */
  | { type: "none" }
  | { type: "none-move"; delta: 1 | -1 }
  | { type: "none-confirm" }
  | { type: "none-note" }
  | { type: "none-cancel" }
  /** Scroll the background half a screen (half) or one row (line) */
  | { type: "scroll"; delta: 1 | -1; unit: "half" | "line" }
  | { type: "scroll-edge"; to: "top" | "bottom" }
  | { type: "focus" }
  /** Move a too-wide diagram one step (8 columns) sideways */
  | { type: "hscroll"; delta: 1 | -1 }
  | { type: "hscroll-edge"; to: "start" | "end" }
  /** Toggle full-width display of the background */
  | { type: "full" }
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
  focus?: Focus;
  /** Whether the layout is side by side (in the stacked layout the only background keys are ← →) */
  wide?: boolean;
  /** Whether the background is shown at full width */
  full?: boolean;
  /** Whether there is a diagram that can be shifted sideways */
  hscrollable?: boolean;
  /** Time of the first g of gg (0 if none) */
  lastG: number;
  now: number;
}

export const GG_WINDOW_MS = 1000;

/** Turn a key into an action. lastG is passed to the next context */
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

  if (ctx.mode === "none") {
    if (down) return done({ type: "none-move", delta: 1 });
    if (up) return done({ type: "none-move", delta: -1 });
    if (key.name === "enter") return done({ type: "none-confirm" });
    if (key.name === "esc") return done({ type: "none-cancel" });
    if (key.name === "char" && key.ch === "i") return done({ type: "none-note" });
    if (key.name === "char" && key.ch === "q") return done({ type: "quit" });
    return done(null);
  }

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
  const goLeft = key.name === "left" || ch === "h";
  const goRight = key.name === "right" || ch === "l";

  if (ctx.full) {
    // The decision is not visible, so keys that lead to a decision are disabled
    if (key.name === "tab" || key.name === "esc" || ch === "f") return done({ type: "full" });
    if (ch === "e") return done({ type: "footnote" });
    if (ctx.hscrollable && goLeft) return done({ type: "hscroll", delta: -1 });
    if (ctx.hscrollable && goRight) return done({ type: "hscroll", delta: 1 });
    if (ctx.hscrollable && key.name === "home") return done({ type: "hscroll-edge", to: "start" });
    if (ctx.hscrollable && key.name === "end") return done({ type: "hscroll-edge", to: "end" });
    if (key.name === "ctrl-d" || key.name === "pgdn") return done({ type: "scroll", delta: 1, unit: "half" });
    if (key.name === "ctrl-u" || key.name === "pgup") return done({ type: "scroll", delta: -1, unit: "half" });
    if (down) return done({ type: "scroll", delta: 1, unit: "line" });
    if (up) return done({ type: "scroll", delta: -1, unit: "line" });
    if (ch === "G") return done({ type: "scroll-edge", to: "bottom" });
    if (ch === "g") {
      return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "scroll-edge", to: "top" }) : done(null, ctx.now);
    }
    return done(null);
  }

  if (key.name === "tab") return done({ type: "focus" });
  if (ch === "e") return done({ type: "footnote" });
  if (ch === "f" && ctx.wide) return done({ type: "full" });
  if (ctx.hscrollable) {
    // With a too-wide diagram, ← → scroll sideways regardless of focus (switching pending uses h l [ ])
    if (key.name === "left") return done({ type: "hscroll", delta: -1 });
    if (key.name === "right") return done({ type: "hscroll", delta: 1 });
    if (ctx.focus === "background") {
      if (key.name === "home") return done({ type: "hscroll-edge", to: "start" });
      if (key.name === "end") return done({ type: "hscroll-edge", to: "end" });
    }
  }
  if (key.name === "ctrl-d" || key.name === "pgdn") return done({ type: "scroll", delta: 1, unit: "half" });
  if (key.name === "ctrl-u" || key.name === "pgup") return done({ type: "scroll", delta: -1, unit: "half" });
  if (ctx.focus === "background") {
    if (down) return done({ type: "scroll", delta: 1, unit: "line" });
    if (up) return done({ type: "scroll", delta: -1, unit: "line" });
    if (ch === "G") return done({ type: "scroll-edge", to: "bottom" });
    if (ch === "g") {
      return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "scroll-edge", to: "top" }) : done(null, ctx.now);
    }
  }
  if (ch === "[") return done({ type: "prev" });
  if (ch === "]") return done({ type: "next" });
  if (ch === "h" || key.name === "left") return ctx.kind === "plan" && key.name === "left" ? done({ type: "move", delta: -1 }) : done({ type: "prev" });
  if (ch === "l" || key.name === "right") return ctx.kind === "plan" && key.name === "right" ? done({ type: "move", delta: 1 }) : done({ type: "next" });
  if (ch === "b") return done({ type: "list" });
  if (down) return done({ type: "move", delta: 1 });
  if (up) return done({ type: "move", delta: -1 });
  if (key.name === "enter") return done({ type: "submit" });

  if (ctx.kind === "plan") {
    if (ch === "y") return done({ type: "approve" });
    if (ch === "a") return done({ type: "approve-auto" });
    if (ch === "n") return done({ type: "reject" });
    if (ch === ".") return done({ type: "rec" });
    return done(null);
  }

  if (ch === "n") return done({ type: "none" });
  if (ch === "g") {
    return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "top" }) : done(null, ctx.now);
  }
  if (ch === "G") return done({ type: "bottom" });
  if (ch === " ") return done({ type: "toggle" });
  if (ch === "i") return done({ type: "free" });
  if (ch === "c") return done({ type: "copy" });
  if (ch === ".") return done({ type: "rec" });
  return done(null);
}
