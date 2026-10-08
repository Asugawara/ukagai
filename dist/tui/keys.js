// Terminal input bytes to keys to actions. No side effects.
/** How long to wait to tell a lone Esc from an arrow escape sequence */
export const ESC_TIMEOUT_MS = 30;
const CSI = {
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
    pending = "";
    /** Whether input is being held (a hint to arm the timer) */
    get hasPending() {
        return this.pending !== "";
    }
    feed(data) {
        const s = this.pending + data;
        this.pending = "";
        const keys = [];
        let i = 0;
        while (i < s.length) {
            const c = s[i];
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
                    }
                    else if (mouse[4] === "M" && b & 64) {
                        keys.push({ name: "wheel", dir: b & 1 ? "down" : "up", x: Number(mouse[2]), y: Number(mouse[3]) });
                    }
                    i += 1 + mouse[0].length;
                    continue;
                }
                const m = /^(\[[0-9;]*[~A-Za-z]|O[A-DHF])/.exec(rest);
                if (m) {
                    const name = CSI[m[1]];
                    if (name)
                        keys.push({ name });
                    i += 1 + m[1].length;
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
    flush() {
        const p = this.pending;
        this.pending = "";
        return p === "\x1b" ? [{ name: "esc" }] : [];
    }
    one(s, i, keys) {
        const cp = s.codePointAt(i);
        const len = cp > 0xffff ? 2 : 1;
        const ch = s.slice(i, i + len);
        if (ch === "\r" || ch === "\n")
            keys.push({ name: "enter" });
        else if (ch === "\x03")
            keys.push({ name: "ctrl-c" });
        else if (ch === "\x04")
            keys.push({ name: "ctrl-d" });
        else if (ch === "\x15")
            keys.push({ name: "ctrl-u" });
        else if (ch === "\x7f" || ch === "\b")
            keys.push({ name: "backspace" });
        else if (ch === "\t")
            keys.push({ name: "tab" });
        else if (cp >= 0x20)
            keys.push({ name: "char", ch });
        return len;
    }
}
export const GG_WINDOW_MS = 1000;
/** Turn a key into an action. lastG is passed to the next context */
export function interpret(key, ctx) {
    const done = (action, lastG = 0) => ({ action, lastG });
    if (key.name === "ctrl-c")
        return done({ type: "quit" });
    if (ctx.mode === "input") {
        switch (key.name) {
            case "enter": return done({ type: "input-confirm" });
            case "esc": return done({ type: "input-cancel" });
            case "up": return done({ type: "input-move", delta: -1 });
            case "down": return done({ type: "input-move", delta: 1 });
            case "left": return ctx.toc && ctx.inputEmpty ? done({ type: "input-zone" }) : done(null);
            case "backspace": return done({ type: "input-backspace" });
            case "char":
                if (ctx.presets && key.ch >= "1" && key.ch <= "9" && Number(key.ch) <= ctx.presets)
                    return done({ type: "preset", n: Number(key.ch) });
                return done({ type: "input-char", ch: key.ch });
            default: return done(null);
        }
    }
    const down = key.name === "down" || (key.name === "char" && key.ch === "j");
    const up = key.name === "up" || (key.name === "char" && key.ch === "k");
    if (ctx.mode === "none") {
        if (down)
            return done({ type: "none-move", delta: 1 });
        if (up)
            return done({ type: "none-move", delta: -1 });
        if (key.name === "enter")
            return done({ type: "none-confirm" });
        if (key.name === "esc")
            return done({ type: "none-cancel" });
        if (key.name === "char" && key.ch === "i")
            return done({ type: "none-note" });
        if (key.name === "char" && key.ch === "q")
            return done({ type: "quit" });
        return done(null);
    }
    if (ctx.mode === "cannot") {
        if (down)
            return done({ type: "cannot-move", delta: 1 });
        if (up)
            return done({ type: "cannot-move", delta: -1 });
        if (key.name === "enter")
            return done({ type: "cannot-confirm" });
        if (key.name === "esc")
            return done({ type: "cannot-cancel" });
        if (key.name === "char" && key.ch === " ")
            return done({ type: "cannot-toggle" });
        if (key.name === "char" && key.ch === "i")
            return done({ type: "cannot-note" });
        if (key.name === "char" && key.ch === "q")
            return done({ type: "quit" });
        return done(null);
    }
    if (ctx.mode === "list") {
        if (down)
            return done({ type: "list-move", delta: 1 });
        if (up)
            return done({ type: "list-move", delta: -1 });
        if (key.name === "enter")
            return done({ type: "list-pick" });
        if (key.name === "esc" || (key.name === "char" && key.ch === "b"))
            return done({ type: "list-close" });
        if (key.name === "char" && key.ch === "q")
            return done({ type: "quit" });
        return done(null);
    }
    if (ctx.mode === "history") {
        if (down)
            return done({ type: "history-move", delta: 1 });
        if (up)
            return done({ type: "history-move", delta: -1 });
        if (key.name === "enter")
            return done({ type: "history-pick" });
        if (key.name === "esc" || (key.name === "char" && key.ch === "s"))
            return done({ type: "history-close" });
        if (key.name === "char" && key.ch === "q")
            return done({ type: "quit" });
        return done(null);
    }
    const ch = key.name === "char" ? key.ch : null;
    if (ch === "q")
        return done({ type: "quit" });
    if (ch === "s")
        return done({ type: "history" });
    if (ctx.histDetail && key.name === "esc")
        return done({ type: "history-back" });
    if (ctx.kind === "plan" && !ctx.full && (ch === "<" || ch === ">"))
        return done({ type: "ver", delta: ch === ">" ? 1 : -1 });
    if (ctx.planOnly && !ctx.full && key.name === "esc")
        return done({ type: "plan-done" });
    const goLeft = key.name === "left" || ch === "h";
    const goRight = key.name === "right" || ch === "l";
    if (ctx.full) {
        // The decision is not visible, so keys that lead to a decision are disabled
        if (key.name === "tab" || key.name === "esc" || ch === "f")
            return done({ type: "full" });
        if (ch === "e")
            return done({ type: "footnote" });
        if (ctx.hscrollable && goLeft)
            return done({ type: "hscroll", delta: -1 });
        if (ctx.hscrollable && goRight)
            return done({ type: "hscroll", delta: 1 });
        if (ctx.hscrollable && key.name === "home")
            return done({ type: "hscroll-edge", to: "start" });
        if (ctx.hscrollable && key.name === "end")
            return done({ type: "hscroll-edge", to: "end" });
        if (key.name === "ctrl-d" || key.name === "pgdn")
            return done({ type: "scroll", delta: 1, unit: "half" });
        if (key.name === "ctrl-u" || key.name === "pgup")
            return done({ type: "scroll", delta: -1, unit: "half" });
        if (down)
            return done({ type: "scroll", delta: 1, unit: "line" });
        if (up)
            return done({ type: "scroll", delta: -1, unit: "line" });
        if (ch === "G")
            return done({ type: "scroll-edge", to: "bottom" });
        if (ch === "g") {
            return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "scroll-edge", to: "top" }) : done(null, ctx.now);
        }
        return done(null);
    }
    if (key.name === "tab")
        return done({ type: "focus" });
    if (ch === "e")
        return done({ type: "footnote" });
    if (ch === "f" && ctx.wide)
        return done({ type: "full" });
    if (ctx.hscrollable) {
        // With a too-wide diagram, ← → scroll sideways regardless of focus (switching pending uses h l [ ])
        if (key.name === "left")
            return done({ type: "hscroll", delta: -1 });
        if (key.name === "right")
            return done({ type: "hscroll", delta: 1 });
        if (ctx.focus === "background") {
            if (key.name === "home")
                return done({ type: "hscroll-edge", to: "start" });
            if (key.name === "end")
                return done({ type: "hscroll-edge", to: "end" });
        }
    }
    if (key.name === "ctrl-d" || key.name === "pgdn")
        return done({ type: "scroll", delta: 1, unit: "half" });
    if (key.name === "ctrl-u" || key.name === "pgup")
        return done({ type: "scroll", delta: -1, unit: "half" });
    if (ctx.toc && ctx.kind === "plan") {
        // A long plan has two zones. ← h = the plan zone (the sections), → l = the options zone (Approve / Instruct / Reject). h l no longer switch pending decisions here: [ ] do (and Tab switches the zone)
        if (ch === "h" || key.name === "left")
            return done({ type: "zone", to: "plan" });
        if (ch === "l" || key.name === "right")
            return done({ type: "zone", to: "opts" });
        // A plan file has one card, Instruct: Enter in the options zone opens its box
        if (ctx.zone === "opts" && ctx.planOnly && key.name === "enter")
            return done({ type: "instruct" });
        // The plan zone: j k ↑ ↓ move the section selection, Enter / Space fold the section, o opens / closes all, Home End gg G go to the first / last
        if (ctx.zone === "plan") {
            if (ch === "o")
                return done({ type: "toc-all" });
            if (key.name === "enter" || ch === " ")
                return done({ type: "toc-toggle" });
            if (down)
                return done({ type: "toc-move", delta: 1 });
            if (up)
                return done({ type: "toc-move", delta: -1 });
            if (key.name === "home")
                return done({ type: "toc-edge", to: "first" });
            if (key.name === "end" || ch === "G")
                return done({ type: "toc-edge", to: "last" });
            if (ch === "g")
                return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "toc-edge", to: "first" }) : done(null, ctx.now);
        }
    }
    if (ctx.focus === "background") {
        if (down)
            return done({ type: "scroll", delta: 1, unit: "line" });
        if (up)
            return done({ type: "scroll", delta: -1, unit: "line" });
        if (ch === "G")
            return done({ type: "scroll-edge", to: "bottom" });
        if (ch === "g") {
            return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "scroll-edge", to: "top" }) : done(null, ctx.now);
        }
    }
    if (ch === "[")
        return done({ type: "prev" });
    if (ch === "]")
        return done({ type: "next" });
    if (ctx.planOnly && (key.name === "left" || key.name === "right"))
        return done(null);
    if (ch === "h" || key.name === "left")
        return ctx.kind === "plan" && key.name === "left" ? done({ type: "move", delta: -1 }) : done({ type: "prev" });
    if (ch === "l" || key.name === "right")
        return ctx.kind === "plan" && key.name === "right" ? done({ type: "move", delta: 1 }) : done({ type: "next" });
    if (ch === "b")
        return done({ type: "list" });
    if (ctx.kind === "plan" && ch === "i")
        return done({ type: "instruct" });
    // Nothing to answer on a plan file: j/k only scroll (the contents cursor moved above)
    if (ctx.planOnly && down)
        return done({ type: "scroll", delta: 1, unit: "line" });
    if (ctx.planOnly && up)
        return done({ type: "scroll", delta: -1, unit: "line" });
    // Nothing else to answer on a plan file
    if (ctx.planOnly)
        return done(null);
    if (down)
        return done({ type: "move", delta: 1 });
    if (up)
        return done({ type: "move", delta: -1 });
    if (key.name === "enter")
        return done({ type: "submit" });
    if (ctx.kind === "plan") {
        if (ch === "y")
            return done({ type: "approve" });
        if (ch === "n")
            return done({ type: "reject" });
        if (ch === "1" || ch === "2" || ch === "3")
            return done({ type: "pick", n: Number(ch) });
        if (ch === ".")
            return done({ type: "rec" });
        return done(null);
    }
    if (ch !== null && ch >= "1" && ch <= "9")
        return done({ type: "pick", n: Number(ch) });
    if (ch === "n")
        return done({ type: "none" });
    if (ch === "x")
        return done({ type: "cannot" });
    if (ch === "g") {
        return ctx.lastG && ctx.now - ctx.lastG < GG_WINDOW_MS ? done({ type: "top" }) : done(null, ctx.now);
    }
    if (ch === "G")
        return done({ type: "bottom" });
    if (ch === " ")
        return done({ type: "toggle" });
    if (ch === "i")
        return done({ type: "free" });
    if (ch === "c")
        return done({ type: "copy" });
    if (ch === ".")
        return done({ type: "rec" });
    return done(null);
}
//# sourceMappingURL=keys.js.map