import { MULTI_SELECT_SEPARATOR, type Decision, type SessionHistory } from "../contract.js";
import { interpret, type Action, type Focus, type Key, type Mode } from "./keys.js";
import { buildModel, hasExplanation, isBlocker, titleOf, chipsOf, type ScreenModel } from "./model.js";
import type { Frame, ListItem, View } from "./render.js";
import { parseFrontMatterFields } from "./util.js";
import type { Lang } from "../settings/config.js";
import { t, type MessageKey } from "./i18n.js";
import { NONE_TYPES, noneAnswer } from "./none.js";
import { cannotAnswer, cannotRows, defaultCannotReason } from "./cannot.js";
import { historyItems, type HistoryItem } from "./history.js";

// State transitions (no I/O). Given a key, returns the Effects for the caller to run.

export type Effect =
  | { type: "answer"; id: string; body: Record<string, unknown> }
  | { type: "copy"; text: string }
  | { type: "quit" };

interface Draft {
  cursor: number;
  sel: Set<string>;
  free: { on: boolean; text: string };
  reason: string;
}

export const TOAST_MS = 2000;
/** How long the first Enter of a two-step confirmation stays valid */
export const CONFIRM_MS = 3000;
/** Rows per wheel notch */
export const WHEEL_LINES = 3;
/** Columns per ← → horizontal scroll */
export const HSCROLL_STEP = 8;
/** How long the "f for full width" hint stays up */
export const FULL_HINT_MS = 6000;

const STATUS_KEY: Record<string, MessageKey> = {
  answer_submitted: "status_answer_submitted",
  answered: "status_answered",
  answer_lost: "status_answer_lost",
  hook_disconnected: "status_hook_disconnected",
  fallback: "status_fallback",
  cancelled: "status_cancelled",
};

export class App {
  /** Display language (set by index.ts) */
  lang: Lang = "en";
  readonly decisions = new Map<string, Decision>();
  shownId: string | null = null;
  mode: Mode = "normal";
  /** First row of the background (the whole screen in the stacked layout) */
  scroll = 0;
  /** First row of the decision column; null follows the cursor */
  rscroll: number | null = null;
  focus: Focus = "decision";
  /** Horizontal position of a too-wide diagram (columns) */
  hscroll = 0;
  /** Show the background at full width (hides the decision column) */
  full = false;
  /** Dimensions of the last drawn screen (used for scroll amounts and ranges) */
  private frame: Pick<Frame, "wide" | "split" | "scrollMax" | "rightMax" | "rightOff" | "off" | "bodyRows" | "hMax" | "footRows"> = {
    wide: false, split: 0, scrollMax: 0, rightMax: 0, rightOff: 0, off: 0, bodyRows: 20, hMax: 0, footRows: [],
  };
  /** The "f for full width" hint is shown once per decision: which decisions have had it, and until when */
  private hinted = new Set<string>();
  private hintUntil = 0;
  /** Whether copying to the clipboard is possible (whether pbcopy exists; decided by index.ts) */
  copySupported = true;
  /** Fetches a session's instructions (set by index.ts; absent in tests that do not need it) and is told when one arrives */
  fetchHistory: ((decisionId: string) => Promise<SessionHistory>) | null = null;
  onHistory: () => void = () => {};
  /** Instructions by session_id; a failed fetch leaves no entry (the next time the session is shown tries again) */
  private histories = new Map<string, SessionHistory>();
  private histLoading = new Set<string>();
  /** The `s` overlay cursor, and the instruction shown in full in the background column (index into the items) */
  private hist = { index: 0 };
  private histDetail: number | null = null;
  private models = new Map<string, ScreenModel>();
  private drafts = new Map<string, Draft>();
  private input: { kind: "free" | "reason" | "note"; text: string } | null = null;
  /** The "None of these" picker (index into NONE_TYPES, optional note) */
  private none: { index: number; text: string } | null = null;
  /** The "Can't answer this" picker: `pos` is the row (0-2 the reasons, then the terms checklist), `index` the reason in force */
  private cannot: { index: number; pos: number; terms: string[]; checked: Set<string>; text: string } | null = null;
  /** First Enter of a two-step confirmation; `prior` is the one in force when the current key arrived */
  private confirm: { id: string; kind: string; until: number } | null = null;
  private prior: { id: string; kind: string; until: number } | null = null;
  private footIdx = -1;
  private listIndex = 0;
  private lastG = 0;
  /** Decisions showing a long recommendation in full */
  private recFull = new Set<string>();
  private toast: { text: string; until: number } | null = null;
  private sending = new Set<string>();
  private sent = new Set<string>();
  /** Server address (shown in the footer "cannot connect" message; set by index.ts) */
  server = "";
  private down = false;
  private restoredUntil = 0;

  // ---- Data ----

  pending(): Decision[] {
    return [...this.decisions.values()]
      .filter((d) => d.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** The list at startup / refetch (pending only). Decisions still pending locally but missing from the list are returned to be re-fetched */
  replacePending(list: Decision[], now: number): string[] {
    const seen = new Set<string>();
    for (const d of list) {
      seen.add(d.id);
      this.decisions.set(d.id, d);
    }
    const stale = [...this.decisions.values()].filter((d) => d.status === "pending" && !seen.has(d.id)).map((d) => d.id);
    const cur = this.shownId ? this.decisions.get(this.shownId) : undefined;
    if (!cur || cur.status !== "pending") this.advance(now);
    return stale;
  }

  upsert(d: Decision, now: number): void {
    this.decisions.set(d.id, d);
    if (d.status !== "pending" && this.sent.has(d.id)) {
      const key = STATUS_KEY[d.status];
      if (key) this.showToast(t(this.lang, key), now);
      if (d.status !== "answer_submitted") this.sent.delete(d.id);
    }
    if (d.id === this.shownId) {
      if (d.status !== "pending") this.advance(now);
    } else if (this.shownId == null && d.status === "pending") {
      this.show(d.id);
    }
  }

  /** SSE connection state: "cannot connect" while down, and "reconnected" for 2 seconds after it comes back */
  setConnected(ok: boolean, now: number): void {
    if (!ok) this.down = true;
    else if (this.down) {
      this.down = false;
      this.restoredUntil = now + TOAST_MS;
    }
  }

  /** Remove a decision the server no longer has */
  drop(id: string, now: number): void {
    this.decisions.delete(id);
    this.models.delete(id);
    this.drafts.delete(id);
    this.recFull.delete(id);
    this.hinted.delete(id);
    this.sending.delete(id);
    this.sent.delete(id);
    if (id === this.shownId) this.advance(now);
  }

  private showToast(text: string, now: number): void {
    this.toast = { text, until: now + TOAST_MS };
  }

  private show(id: string | null): void {
    this.shownId = id;
    // Focus does not carry over between decisions (left on the background, j / Enter would scroll it and cause wrong answers)
    this.focus = "decision";
    this.scroll = 0;
    this.rscroll = null;
    this.hscroll = 0;
    this.full = false;
    this.hintUntil = 0;
    this.input = null;
    this.none = null;
    this.cannot = null;
    this.confirm = null;
    this.footIdx = -1;
    this.histDetail = null;
    if (this.mode === "input" || this.mode === "none" || this.mode === "cannot" || this.mode === "history") this.mode = "normal";
    this.loadHistory(id);
  }

  /** Lazily fetch the session's instructions the first time a decision of that session is shown. Failures are ignored */
  private loadHistory(id: string | null): void {
    const d = id ? this.decisions.get(id) : undefined;
    const sid = d?.session.session_id;
    if (!d || !sid || !this.fetchHistory || this.histories.has(sid) || this.histLoading.has(sid)) return;
    this.histLoading.add(sid);
    this.fetchHistory(d.id).then(
      (h) => {
        this.histLoading.delete(sid);
        this.histories.set(sid, h);
        for (const x of this.decisions.values()) if (x.session.session_id === sid) this.models.delete(x.id);
        this.onHistory();
      },
      () => this.histLoading.delete(sid),
    );
  }

  private items(): HistoryItem[] {
    const d = this.shownId ? this.decisions.get(this.shownId) : undefined;
    return historyItems(d ? (this.histories.get(d.session.session_id) ?? null) : null);
  }

  private advance(_now: number): void {
    this.show(this.pending()[0]?.id ?? null);
  }

  // ---- Accessors ----

  model(): ScreenModel | null {
    const d = this.shownId ? this.decisions.get(this.shownId) : undefined;
    if (!d) return null;
    let m = this.models.get(d.id);
    if (!m) this.models.set(d.id, (m = buildModel(d, this.lang, this.histories.get(d.session.session_id) ?? null)));
    return m;
  }

  private draft(m: ScreenModel): Draft {
    let dr = this.drafts.get(m.id);
    if (!dr) {
      const q = m.question;
      dr = { cursor: q?.initialCursor ?? 0, sel: new Set(), free: { on: false, text: "" }, reason: "" };
      // Single select: moving = selecting. Pre-select the initial position (the recommended option, else the first)
      if (q && !q.multi && q.cards[dr.cursor]) dr.sel.add(q.cards[dr.cursor]!.value);
      this.drafts.set(m.id, dr);
    }
    return dr;
  }

  view(now: number): View {
    const m = this.model();
    const dr = m ? this.draft(m) : null;
    const pending = this.pending();
    const list: View["list"] =
      this.mode === "list"
        ? {
            index: this.listIndex,
            items: pending.map((d): ListItem => ({
              blocker: isBlocker(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}),
              title: titleOf(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}, this.lang),
              chips: chipsOf(d),
              kindLabel: t(this.lang, d.kind === "approve_plan" ? "kind_plan" : "kind_question"),
              createdAt: d.created_at,
              noExplanation: d.kind === "answer_question" && !hasExplanation(d),
              current: d.id === this.shownId,
            })),
          }
        : null;
    return {
      model: m,
      cursor: dr?.cursor ?? 0,
      selected: dr?.sel ?? new Set(),
      free: dr?.free ?? { on: false, text: "" },
      input: this.input,
      none: this.none,
      cannot: this.cannot ? { index: this.cannot.index, pos: this.cannot.pos, terms: this.cannot.terms, checked: this.cannot.checked, text: this.cannot.text } : null,
      notice: this.notice(now),
      reason: dr?.reason ?? "",
      pending: pending.length,
      toast: this.toast && this.toast.until > now ? this.toast.text : null,
      lang: this.lang,
      conn: this.down ? { state: "down", server: this.server } : this.restoredUntil > now ? { state: "restored" } : null,
      list,
      history: this.mode === "history" ? { index: this.hist.index, items: this.items() } : null,
      histDetail: this.histDetail === null ? null : (this.items()[this.histDetail] ?? null),
      copy: this.copySupported,
      recFull: this.shownId !== null && this.recFull.has(this.shownId),
      scroll: this.scroll,
      rscroll: this.rscroll,
      focus: this.focus,
      hscroll: this.hscroll,
      full: this.full,
      fullHint: this.hintUntil > now,
      now,
    };
  }

  /** The prompt shown in the footer: "Press Enter again" */
  private notice(now: number): string | null {
    if (this.confirm && this.confirm.until >= now) return t(this.lang, "confirm_again");
    return null;
  }

  /** Take the drawn screen dimensions and clamp the scroll positions. Returns true when a hint just started (redraw) */
  syncFrame(f: Frame, now = Date.now()): boolean {
    this.frame = f;
    this.scroll = Math.max(0, Math.min(this.scroll, f.scrollMax));
    if (this.rscroll != null) this.rscroll = Math.max(0, Math.min(this.rscroll, f.rightMax));
    this.hscroll = Math.max(0, Math.min(this.hscroll, f.hMax));
    if (f.figOver && this.shownId && !this.hinted.has(this.shownId)) {
      this.hinted.add(this.shownId);
      this.hintUntil = now + FULL_HINT_MS;
      return true;
    }
    return false;
  }

  /** Focus matters only in the side-by-side layout. At full width it is the background */
  private effectiveFocus(): Focus {
    return this.frame.wide ? (this.full ? "background" : this.focus) : "decision";
  }

  /** Move the background (the whole screen in the stacked layout) to `to`. For relative moves from the current view `cur`, the caller computes the target */
  private setScroll(to: number): void {
    this.scroll = Math.max(0, Math.min(this.frame.scrollMax, to));
  }

  private wheel(dir: "up" | "down", x: number): void {
    const d = (dir === "down" ? 1 : -1) * WHEEL_LINES;
    const f = this.frame;
    if (f.wide && x - 1 >= f.split) {
      if (f.rightMax <= 0) return;
      this.rscroll = Math.max(0, Math.min(f.rightMax, (this.rscroll ?? f.rightOff) + d));
    } else if (f.wide) {
      this.setScroll(this.scroll + d);
    } else {
      // In the stacked layout 0 follows the cursor; move from the position currently visible
      this.setScroll((this.scroll || f.off) + d);
    }
  }

  // ---- Keys ----

  handle(key: Key, now: number): Effect[] {
    const m = this.model();
    if (key.name !== "hwheel" && key.name !== "wheel") {
      this.prior = this.confirm;
      this.confirm = null;
    }
    if (key.name === "hwheel") {
      if (this.mode === "normal") this.apply({ type: "hscroll", delta: key.dir === "right" ? 1 : -1 }, m, now);
      return [];
    }
    if (key.name === "wheel") {
      if (this.mode === "normal") this.wheel(key.dir, key.x);
      return [];
    }
    const { action, lastG } = interpret(key, { mode: this.mode, kind: m?.kind ?? "question", focus: this.effectiveFocus(), histDetail: this.histDetail !== null, wide: this.frame.wide, full: this.full, hscrollable: this.frame.hMax > 0, lastG: this.lastG, now });
    this.lastG = lastG;
    return action ? this.apply(action, m, now) : [];
  }

  private apply(a: Action, m: ScreenModel | null, now: number): Effect[] {
    switch (a.type) {
      case "quit": return [{ type: "quit" }];
      case "prev": this.cycle(-1); return [];
      case "next": this.cycle(1); return [];
      case "list":
        if (this.pending().length) {
          this.mode = "list";
          this.listIndex = Math.max(0, this.pending().findIndex((d) => d.id === this.shownId));
        }
        return [];
      case "list-move": this.listIndex = clamp(this.listIndex + a.delta, this.pending().length); return [];
      case "list-pick": {
        const d = this.pending()[clamp(this.listIndex, this.pending().length)];
        if (d) this.show(d.id);
        this.mode = "normal";
        return [];
      }
      case "list-close": this.mode = "normal"; return [];
      case "history": {
        const n = this.items().length;
        if (n) {
          this.mode = "history";
          this.hist.index = this.histDetail ?? n - 1;
        }
        return [];
      }
      case "history-move": this.hist.index = clamp(this.hist.index + a.delta, this.items().length); return [];
      case "history-pick":
        if (this.items()[this.hist.index]) {
          this.histDetail = this.hist.index;
          this.focus = "background";
          this.scroll = 0;
        }
        this.mode = "normal";
        return [];
      case "history-close": this.mode = "normal"; return [];
      case "history-back": {
        this.histDetail = null;
        this.focus = "decision";
        this.scroll = 0;
        if (this.items().length) this.mode = "history";
        return [];
      }
      case "scroll": {
        const n = a.unit === "half" ? Math.max(1, Math.floor(this.frame.bodyRows / 2)) : 1;
        // In the stacked layout 0 follows the cursor; move from the position currently visible
        this.setScroll((this.frame.wide ? this.scroll : this.scroll || this.frame.off) + a.delta * n);
        return [];
      }
      case "scroll-edge": this.setScroll(a.to === "top" ? 0 : this.frame.scrollMax); return [];
      case "hscroll": this.hscroll = Math.max(0, Math.min(this.frame.hMax, this.hscroll + a.delta * HSCROLL_STEP)); return [];
      case "hscroll-edge": this.hscroll = a.to === "start" ? 0 : this.frame.hMax; return [];
      case "full": this.full = !this.full; this.scroll = 0; return [];
      case "focus": this.focus = this.focus === "decision" ? "background" : "decision"; return [];
      case "input-char": if (this.input) this.input.text += a.ch; return [];
      case "input-backspace": if (this.input) this.input.text = Array.from(this.input.text).slice(0, -1).join(""); return [];
      case "input-cancel": this.mode = this.input?.kind === "note" && this.none ? "none" : this.input?.kind === "note" && this.cannot ? "cannot" : "normal"; this.input = null; return [];
      case "footnote": {
        const rows = this.frame.footRows;
        if (!rows.length) return [];
        this.footIdx = (this.footIdx + 1) % rows.length;
        this.setScroll(rows[this.footIdx]!);
        return [];
      }
    }
    if (!m) return [];
    const dr = this.draft(m);
    switch (a.type) {
      case "input-confirm": return this.confirmInput(m, dr, now);
      case "none": return this.openNone(m, dr);
      case "none-move": if (this.none) this.none.index = clamp(this.none.index + a.delta, NONE_TYPES.length); return [];
      case "none-cancel": this.none = null; this.mode = "normal"; return [];
      case "none-note": if (this.none) { this.input = { kind: "note", text: this.none.text }; this.mode = "input"; } return [];
      case "none-confirm": {
        const n = this.none;
        if (!n) return [];
        this.none = null;
        this.mode = "normal";
        return this.emit(m.id, { answers: { [questionText(this.decisions.get(m.id)!)]: noneAnswer(n.index, n.text) } });
      }
      case "cannot": return this.openCannot(m, dr);
      case "pick": return this.pick(m, dr, a.n - 1, now);
      case "cannot-move": return this.cannotMove(a.delta);
      case "cannot-cancel": this.cannot = null; this.mode = "normal"; return [];
      case "cannot-toggle": {
        const c = this.cannot;
        const row = c ? cannotRows(c.index, c.terms.length)[c.pos] : undefined;
        const term = c && row?.kind === "term" ? c.terms[row.index] : undefined;
        if (c && term !== undefined) {
          if (c.checked.has(term)) c.checked.delete(term);
          else c.checked.add(term);
        }
        return [];
      }
      case "cannot-note": if (this.cannot) { this.input = { kind: "note", text: this.cannot.text }; this.mode = "input"; } return [];
      case "cannot-confirm": {
        const c = this.cannot;
        if (!c) return [];
        const body = cannotAnswer(c.index, c.terms.filter((x) => c.checked.has(x)), c.text);
        if (body === null) {
          this.showToast(t(this.lang, "cannot_need_term"), now);
          return [];
        }
        this.cannot = null;
        this.mode = "normal";
        return this.emit(m.id, { answers: { [questionText(this.decisions.get(m.id)!)]: body } });
      }
      case "move": this.moveCursor(m, dr, dr.cursor + a.delta); return [];
      case "top": this.moveCursor(m, dr, 0); return [];
      case "bottom": this.moveCursor(m, dr, this.slots(m) - 1); return [];
      case "toggle": return this.toggle(m, dr);
      case "free": return this.startFree(m, dr);
      case "copy": {
        const text = m.todoCode[0];
        return text ? [{ type: "copy", text }] : [];
      }
      case "rec": {
        if (this.recFull.has(m.id)) this.recFull.delete(m.id);
        else this.recFull.add(m.id);
        return [];
      }
      case "submit": return this.submit(m, dr, now);
      case "approve": dr.cursor = 0; return this.approve(m, false, now);
      case "approve-auto": dr.cursor = 1; return this.approve(m, true, now);
      case "reject": dr.cursor = 2; this.startReason(dr); return [];
      default: return [];
    }
  }

  private cycle(step: number): void {
    const list = this.pending();
    if (list.length < 2) return;
    const i = list.findIndex((d) => d.id === this.shownId);
    this.show(list[(i + step + list.length) % list.length]!.id);
  }

  /** Number of positions the cursor can rest on: cards + "None of these" + "Can't answer this" + free text for a question, 3 buttons for a plan */
  private slots(m: ScreenModel): number {
    if (m.kind === "plan") return 3;
    return m.question ? m.question.cards.length + 3 : 0;
  }

  /** Approve a plan (Enter twice when the decision is irreversible) */
  private approve(m: ScreenModel, auto: boolean, now: number): Effect[] {
    if (!this.guard(m, auto ? "approve-auto" : "approve", m.reversibility === "irreversible", now)) return [];
    return this.emit(m.id, { approve: true, set_mode_auto: auto });
  }

  /** The first press of a heavy action only arms it; the same action on the very next key (within 3s) goes through */
  private guard(m: ScreenModel, kind: string, heavy: boolean, now: number): boolean {
    if (!heavy) return true;
    const c = this.prior;
    if (c && c.id === m.id && c.kind === kind && c.until >= now) return true;
    this.confirm = { id: m.id, kind, until: now + CONFIRM_MS };
    return false;
  }

  private openNone(m: ScreenModel, dr: Draft): Effect[] {
    const q = m.question;
    if (!q) return [];
    dr.cursor = q.cards.length;
    if (!q.multi) {
      dr.sel.clear();
      dr.free.on = false;
    }
    this.none = this.none ?? { index: 0, text: "" };
    this.mode = "none";
    return [];
  }

  /** `1`-`9`: send the card at once. A heavy card (irreversible) first moves the cursor there and asks for the same key (or Enter) again */
  private pick(m: ScreenModel, dr: Draft, i: number, now: number): Effect[] {
    const q = m.question;
    if (!q || q.multi || i >= q.cards.length) return [];
    const heavy = m.reversibility === "irreversible" || !!q.cards[i]!.heavy;
    if (dr.cursor !== i) {
      this.moveCursor(m, dr, i);
      if (heavy) {
        this.confirm = { id: m.id, kind: "answer", until: now + CONFIRM_MS };
        return [];
      }
    } else if (!this.guard(m, "answer", heavy, now)) return [];
    return this.emit(m.id, { answers: { [questionText(this.decisions.get(m.id)!)]: q.cards[i]!.value } });
  }

  private openCannot(m: ScreenModel, dr: Draft): Effect[] {
    const q = m.question;
    if (!q) return [];
    dr.cursor = q.cards.length + 1;
    if (!q.multi) {
      dr.sel.clear();
      dr.free.on = false;
    }
    if (!this.cannot) {
      const index = defaultCannotReason(m.coinedTerms);
      this.cannot = { index, pos: cannotRows(index, m.coinedTerms.length).findIndex((r) => r.kind === "reason" && r.index === index), terms: [...m.coinedTerms], checked: new Set(m.coinedTerms), text: "" };
    }
    this.mode = "cannot";
    return [];
  }

  private cannotMove(delta: 1 | -1): Effect[] {
    const c = this.cannot;
    if (!c) return [];
    const before = cannotRows(c.index, c.terms.length);
    const row = before[clamp(c.pos + delta, before.length)]!;
    // Landing on a reason makes it the one in force (the terms list opens or closes); the row is found again in the new layout
    if (row.kind === "reason") c.index = row.index;
    const after = cannotRows(c.index, c.terms.length);
    c.pos = after.findIndex((r) => r.kind === row.kind && r.index === row.index);
    return [];
  }

  private moveCursor(m: ScreenModel, dr: Draft, to: number): void {
    const n = this.slots(m);
    if (!n) return;
    dr.cursor = clamp(to, n);
    this.scroll = 0;
    this.rscroll = null;
    const q = m.question;
    if (!q || q.multi) return;
    // Single select: moving = selecting
    if (dr.cursor < q.cards.length) {
      dr.sel = new Set([q.cards[dr.cursor]!.value]);
      dr.free.on = false;
    } else {
      dr.sel.clear();
      dr.free.on = dr.cursor > q.cards.length + 1;
    }
  }

  private toggle(m: ScreenModel, dr: Draft): Effect[] {
    const q = m.question;
    if (!q?.multi) return [];
    if (dr.cursor === q.cards.length) return this.openNone(m, dr);
    if (dr.cursor === q.cards.length + 1) return this.openCannot(m, dr);
    if (dr.cursor > q.cards.length + 1) {
      dr.free.on = !dr.free.on;
      if (dr.free.on && !dr.free.text.trim()) this.startFree(m, dr);
      return [];
    }
    const v = q.cards[dr.cursor]!.value;
    if (dr.sel.has(v)) dr.sel.delete(v);
    else dr.sel.add(v);
    return [];
  }

  private startFree(m: ScreenModel, dr: Draft): Effect[] {
    const q = m.question;
    if (!q) return [];
    dr.cursor = q.cards.length + 2;
    if (!q.multi) dr.sel.clear();
    dr.free.on = true;
    this.input = { kind: "free", text: dr.free.text };
    this.mode = "input";
    return [];
  }

  private startReason(dr: Draft): void {
    this.input = { kind: "reason", text: dr.reason };
    this.mode = "input";
  }

  private confirmInput(m: ScreenModel, dr: Draft, now: number): Effect[] {
    const inp = this.input;
    if (!inp) return [];
    if (inp.kind === "note" && this.cannot) {
      this.cannot.text = inp.text;
      this.input = null;
      this.mode = "cannot";
      return [];
    }
    if (inp.kind === "note") {
      if (this.none) this.none.text = inp.text;
      this.input = null;
      this.mode = "none";
      return [];
    }
    if (inp.kind === "reason") {
      dr.reason = inp.text;
      const reason = inp.text.trim();
      if (!reason) return [];
      this.input = null;
      this.mode = "normal";
      return this.emit(m.id, { approve: false, reason });
    }
    dr.free.text = inp.text;
    if (!inp.text.trim()) dr.free.on = false;
    this.input = null;
    this.mode = "normal";
    return [];
  }

  private complete(m: ScreenModel, dr: Draft): boolean {
    const q = m.question;
    if (!q) return false;
    if (dr.free.on && !q.multi) return dr.free.text.trim() !== "";
    if (dr.free.on && dr.free.text.trim()) return true;
    return dr.sel.size > 0;
  }

  private submit(m: ScreenModel, dr: Draft, now: number): Effect[] {
    if (m.kind === "plan") {
      if (dr.cursor === 0) return this.approve(m, false, now);
      if (dr.cursor === 1) return this.approve(m, true, now);
      this.startReason(dr);
      return [];
    }
    const q = m.question;
    if (!q) return [];
    if (dr.cursor === q.cards.length) return this.openNone(m, dr);
    if (dr.cursor === q.cards.length + 1) return this.openCannot(m, dr);
    if (dr.cursor === q.cards.length + 2 && !dr.free.text.trim()) return this.startFree(m, dr);
    if (!this.complete(m, dr)) return [];
    // The answer uses the original option.label
    const picked = q.cards.map((c) => c.value).filter((v) => dr.sel.has(v));
    if (dr.free.on && !q.multi) picked.length = 0;
    if (dr.free.on && dr.free.text.trim()) picked.push(dr.free.text.trim());
    const heavy = m.reversibility === "irreversible" || q.cards.some((c) => c.heavy && dr.sel.has(c.value) && !(dr.free.on && !q.multi));
    if (!this.guard(m, "answer", heavy, now)) return [];
    return this.emit(m.id, { answers: { [questionText(this.decisions.get(m.id)!)]: picked.join(MULTI_SELECT_SEPARATOR) } });
  }

  private emit(id: string, body: Record<string, unknown>): Effect[] {
    if (this.sending.has(id)) return [];
    this.sending.add(id);
    return [{ type: "answer", id, body }];
  }

  // ---- Submission results ----

  answered(updated: Decision, now: number): void {
    this.sending.delete(updated.id);
    this.sent.add(updated.id);
    this.decisions.set(updated.id, updated);
    const key = STATUS_KEY[updated.status];
    this.showToast(t(this.lang, key ?? "sent"), now);
    if (updated.id === this.shownId) this.advance(now);
  }

  failed(id: string, message: string, now: number): void {
    this.sending.delete(id);
    this.showToast(t(this.lang, "send_failed", { message }), now);
  }

  note(text: string, now: number): void {
    this.showToast(text, now);
  }
}

function clamp(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i));
}

function questionText(d: Decision): string {
  const qs = (d.request as { questions?: { question: string }[] }).questions;
  return qs?.[0]?.question ?? "";
}
