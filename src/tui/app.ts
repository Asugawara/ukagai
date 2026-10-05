import { MULTI_SELECT_SEPARATOR, type Decision, type PlanContent, type PlanSummary, type SessionHistory, type SessionSummary, type Settings } from "../contract.js";
import { interpret, type Action, type Focus, type Key, type Mode } from "./keys.js";
import { buildModel, buildPlanFileModel, hasExplanation, isBlocker, planKeyOf, planNameOf, titleOf, chipsOf, type ScreenModel } from "./model.js";
import type { Frame, ListItem, View } from "./render.js";
import { parseFrontMatterFields } from "./util.js";
import type { Lang } from "../settings/config.js";
import { t, type MessageKey } from "./i18n.js";
import { NONE_TYPES, noneAnswer } from "./none.js";
import { cannotAnswer, cannotRows, defaultCannotReason } from "./cannot.js";
import { historyItems, type HistoryItem } from "./history.js";
import { initialPlanState, remapState, setOpen, toggleAll, type PlanOutline, type PlanState } from "./plan.js";

// State transitions (no I/O). Given a key, returns the Effects for the caller to run.

export type Effect =
  | { type: "answer"; id: string; body: Record<string, unknown> }
  | { type: "copy"; text: string }
  /** Mark a plan read at the mtime the human read (POST /api/plans/:name/read) */
  | { type: "read"; name: string; mtime: string }
  /** Tell the agent that is writing a plan file something (POST /api/plans/:name/instruct) */
  | { type: "instruct_plan"; name: string; text: string }
  | { type: "quit" };

interface Draft {
  cursor: number;
  sel: Set<string>;
  free: { on: boolean; text: string };
  reason: string;
  /** The instruction typed on a plan and left with Esc */
  instruct: string;
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
/** A plan is new (shown by itself, counted) while unread and written within this long */
export const NEW_PLAN_MS = 24 * 3600_000;
/** A progress checkpoint has three cards: continue, instruct, stop */
const CHECKPOINT_CARDS = 3;

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
  /** `--lang` was given: the settings page does not change the language of this TUI */
  langLocked = false;
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
  private frame: Pick<Frame, "wide" | "split" | "scrollMax" | "rightMax" | "rightOff" | "off" | "bodyRows" | "hMax" | "footRows" | "secRows"> = {
    wide: false, split: 0, scrollMax: 0, rightMax: 0, rightOff: 0, off: 0, bodyRows: 20, hMax: 0, footRows: [], secRows: [],
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
  /** Plans are items like decisions: the summaries (GET /api/plans, plan.updated), the files read so far and the screen models built from them */
  readonly plans = new Map<string, PlanSummary>();
  private files = new Map<string, PlanContent>();
  private planModels = new Map<string, ScreenModel>();
  /** The plan file shown as an item of its own (shownId is null then) */
  shownPlan: string | null = null;
  /** Fetches one plan file (set by index.ts; absent in tests that do not need it) and is told when a screen should be redrawn */
  fetchPlan: ((name: string) => Promise<PlanContent>) | null = null;
  onPlans: () => void = () => {};
  private models = new Map<string, ScreenModel>();
  private drafts = new Map<string, Draft>();
  private input: { kind: "free" | "reason" | "note" | "instruct"; text: string } | null = null;
  /** Instruction presets (settings plans.instruction_presets) */
  presets: string[] = [];
  /** The "None of these" picker (index into NONE_TYPES, optional note) */
  private none: { index: number; text: string } | null = null;
  /** The "Can't answer this" picker: `pos` is the row (0-2 the reasons, then the terms checklist), `index` the reason in force */
  private cannot: { index: number; pos: number; terms: string[]; checked: Set<string>; text: string } | null = null;
  /** First Enter of a two-step confirmation; `prior` is the one in force when the current key arrived */
  private confirm: { id: string; kind: string; until: number } | null = null;
  private prior: { id: string; kind: string; until: number } | null = null;
  private footIdx = -1;
  /** A long plan's open / read sections and contents cursor, by decision (by plan file when the decision names one, so a plan keeps its state when its approval arrives) */
  private planStates = new Map<string, { st: PlanState; outline: PlanOutline }>();
  /** The section (contents row) the background should scroll to once the next frame has told where it is */
  private reveal: number | null = null;
  private listIndex = 0;
  private lastG = 0;
  /** Decisions showing a long recommendation in full */
  private recFull = new Set<string>();
  private toast: { text: string; until: number } | null = null;
  private sending = new Set<string>();
  private sent = new Set<string>();
  /** Server address (shown in the footer "cannot connect" message; set by index.ts) */
  server = "";
  /** The SSE stream is down (the safety poll then refetches the plans too) */
  down = false;
  private restoredUntil = 0;

  // ---- Data ----

  /** Screen order: blockers, then questions and plans, then progress checkpoints (each group oldest first); the plan files come after all of them */
  pending(): Decision[] {
    const rank = (d: Decision): number => (d.kind === "checkpoint" ? 2 : isBlocker(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}) ? 0 : 1);
    return [...this.decisions.values()]
      .filter((d) => d.status === "pending")
      .sort((a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at));
  }

  /** The state of every session (GET /api/sessions, `session.updated`): a checkpoint's idle note reads it */
  private sessions = new Map<string, SessionSummary>();

  setSessions(list: SessionSummary[]): void {
    this.sessions = new Map(list.map((s) => [s.session_id, s]));
  }

  /** The settings changed (GET /api/settings, `settings.updated`): the language (unless `--lang` pinned it) */
  settingsUpdated(s: Settings): void {
    if (!this.langLocked) this.lang = s.lang;
    this.presets = s.plans?.instruction_presets ?? [];
    this.models.clear();
  }

  sessionUpdated(s: SessionSummary): void {
    this.sessions.set(s.session_id, s);
  }

  private idle(d: Decision | undefined): boolean {
    return !!d && this.sessions.get(d.session.session_id)?.state === "idle";
  }

  /** The idle session of a checkpoint runs in a terminal the reply can be typed into */
  private hasTerminal(d: Decision | undefined): boolean {
    return !!d && !!this.sessions.get(d.session.session_id)?.terminal;
  }

  /** The list at startup / refetch (pending only). Decisions still pending locally but missing from the list are returned to be re-fetched */
  replacePending(list: Decision[], now: number): string[] {
    const seen = new Set<string>();
    const fresh: Decision[] = [];
    for (const d of list) {
      seen.add(d.id);
      if (!this.decisions.has(d.id)) fresh.push(d);
      this.decisions.set(d.id, d);
    }
    const stale = [...this.decisions.values()].filter((d) => d.status === "pending" && !seen.has(d.id)).map((d) => d.id);
    if (this.shownPlan) {
      // A plan on screen stays (it may have been picked on purpose); a decision seen for the first time takes the screen
      const first = fresh.filter((d) => d.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (first) this.show(first.id, planNameOf(first) === this.shownPlan);
    } else {
      const cur = this.shownId ? this.decisions.get(this.shownId) : undefined;
      if (!cur || cur.status !== "pending") this.advance(now);
    }
    return stale;
  }

  upsert(d: Decision, now: number): void {
    const prev = this.decisions.get(d.id);
    this.decisions.set(d.id, d);
    if (d.status !== "pending" && this.sent.has(d.id)) {
      const key = d.kind === "checkpoint" && d.status === "answered" && d.response?.kind !== "continue" ? "checkpoint_sent" : STATUS_KEY[d.status];
      if (key) this.showToast(t(this.lang, key), now);
      if (d.status !== "answer_submitted") this.sent.delete(d.id);
    }
    if (d.kind === "checkpoint" && d.response?.kind !== "continue" && d.response?.delivered_at && d.response.delivered_via !== "noop" && prev && !prev.response?.delivered_at) {
      this.showToast(t(this.lang, "checkpoint_delivered"), now);
    }
    if (d.id === this.shownId) {
      if (d.status !== "pending") this.advance(now);
    } else if (this.shownId == null && d.status === "pending") {
      // A decision needs an answer, a plan does not: it takes the screen. Its own plan on screen turns into the approval in place
      this.show(d.id, planNameOf(d) !== null && planNameOf(d) === this.shownPlan);
    } else if (!prev && d.status === "pending" && d.kind !== "checkpoint" && this.shownId && this.decisions.get(this.shownId)?.kind === "checkpoint" && !this.drafts.get(this.shownId)?.free.text.trim() && this.mode === "normal") {
      // A question or a plan approval outranks a checkpoint on screen (unless an instruction is half typed)
      this.show(d.id);
    }
  }

  // ---- Plans ----

  /** A plan is new while unread and written in the last 24 hours */
  isNew(p: PlanSummary, now: number): boolean {
    return !p.read && now - Date.parse(p.mtime) < NEW_PLAN_MS;
  }

  /** Plans with an approval decision pending are shown as that decision, not as a row of their own */
  private hiddenPlans(): Set<string> {
    const out = new Set<string>();
    for (const d of this.pending()) {
      const n = planNameOf(d);
      if (n) out.add(n);
    }
    return out;
  }

  /** The plans to list: newest first, minus the ones that are an approval decision */
  private visiblePlans(): PlanSummary[] {
    const hidden = this.hiddenPlans();
    return [...this.plans.values()].filter((p) => !hidden.has(p.name)).sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  private newPlans(now: number): PlanSummary[] {
    return this.visiblePlans().filter((p) => this.isNew(p, now));
  }

  /** What `Pending N` counts: the decisions waiting plus the new plans */
  count(now: number): number {
    return this.pending().length + this.newPlans(now).length;
  }

  /** The list at startup / refetch. A plan on screen that is gone leaves the screen; with nothing on screen a new plan comes up by itself */
  replacePlans(list: PlanSummary[], now: number): void {
    const seen = new Set(list.map((p) => p.name));
    for (const name of [...this.plans.keys()]) if (!seen.has(name)) this.forgetPlan(name);
    for (const p of list) this.plans.set(p.name, p);
    if (this.shownPlan && !this.plans.has(this.shownPlan)) this.advance(now);
    this.autoShow(now);
    this.onPlans();
  }

  /** `plan.updated`: a file was written or its read mark changed */
  planUpdated(p: PlanSummary, now: number): void {
    this.plans.set(p.name, p);
    if (p.name === this.shownPlan) {
      const have = this.files.get(p.name);
      if (!have || have.mtime !== p.mtime) this.refreshShown(p.name);
      return;
    }
    this.autoShow(now);
  }

  planRemoved(name: string, now: number): void {
    this.forgetPlan(name);
    if (name === this.shownPlan) this.advance(now);
  }

  private forgetPlan(name: string): void {
    this.plans.delete(name);
    this.files.delete(name);
    this.planModels.delete(name);
    this.planStates.delete(planKeyOf(name));
  }

  /** With nothing on screen, the newest new plan comes up by itself (once its text is here) */
  private autoShow(now: number): void {
    if (this.shownId !== null || this.shownPlan !== null) return;
    const next = this.newPlans(now)[0];
    if (next) this.openPlan(next.name, true);
  }

  /** Show a plan file: at once when its text is here, else after fetching it. `auto`: only if nothing is on screen by then */
  private openPlan(name: string, auto = false): void {
    const sum = this.plans.get(name);
    if (!sum) return;
    const have = this.files.get(name);
    if (have && have.mtime === sum.mtime) {
      this.showPlan(name);
      return;
    }
    if (!this.fetchPlan) return;
    void this.fetchPlan(name).then(
      (file) => {
        if (auto && (this.shownId !== null || this.shownPlan !== null)) return;
        this.files.set(name, file);
        this.planModels.delete(name);
        this.showPlan(name);
        this.onPlans();
      },
      () => {},
    );
  }

  /** A plan on screen was written again: fetch it and rebuild; the folding state follows the section hashes (see `planState`), the scroll stays */
  private refreshShown(name: string): void {
    if (!this.fetchPlan) return;
    void this.fetchPlan(name).then(
      (file) => {
        if (this.shownPlan !== name) return;
        this.files.set(name, file);
        this.planModels.delete(name);
        this.onPlans();
      },
      () => {},
    );
  }

  /** Done reading: mark the plan read at the mtime that was read (no effect when it already is). The server marks an approved plan read itself */
  private markRead(name: string, mtime: string): Effect[] {
    const sum = this.plans.get(name);
    if (!sum || sum.read) return [];
    if (sum.mtime === mtime) this.plans.set(name, { ...sum, read: true });
    return [{ type: "read", name, mtime }];
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
    this.planStates.delete(id);
    this.recFull.delete(id);
    this.hinted.delete(id);
    this.sending.delete(id);
    this.sent.delete(id);
    if (id === this.shownId) this.advance(now);
  }

  private showToast(text: string, now: number): void {
    this.toast = { text, until: now + TOAST_MS };
  }

  private show(id: string | null, keepView = false): void {
    this.shownId = id;
    this.shownPlan = null;
    this.resetView(keepView);
    this.loadHistory(id);
  }

  private showPlan(name: string): void {
    this.shownPlan = name;
    this.shownId = null;
    this.resetView(false);
  }

  /** `keepView`: the same plan turned into its approval, so the reader keeps their place */
  private resetView(keepView: boolean): void {
    if (!keepView) {
      // Focus does not carry over between items (left on the background, j / Enter would scroll it and cause wrong answers)
      this.focus = "decision";
      this.scroll = 0;
      this.rscroll = null;
      this.hscroll = 0;
      this.full = false;
    }
    this.hintUntil = 0;
    this.input = null;
    this.none = null;
    this.cannot = null;
    this.confirm = null;
    this.footIdx = -1;
    this.reveal = null;
    this.histDetail = null;
    if (this.mode === "input" || this.mode === "none" || this.mode === "cannot" || this.mode === "history" || this.mode === "list") this.mode = "normal";
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
    if (!d) return [];
    const replies: HistoryItem[] = [...this.decisions.values()]
      .filter((x) => x.kind === "checkpoint" && x.session.session_id === d.session.session_id && x.status === "answered" && x.response && x.response.kind !== "continue")
      .map((x) => ({ first: false, at: x.response!.decided_at, text: x.response!.text || t(this.lang, "checkpoint_stop"), delivered: !!x.response!.delivered_at }));
    return historyItems(this.histories.get(d.session.session_id) ?? null, replies);
  }

  /** Next item: a pending decision, else the newest new plan, else the idle screen */
  private advance(now: number): void {
    const d = this.pending()[0];
    if (d) return this.show(d.id);
    this.show(null);
    this.autoShow(now);
  }

  // ---- Accessors ----

  model(): ScreenModel | null {
    if (this.shownPlan) {
      let pm = this.planModels.get(this.shownPlan);
      const file = this.files.get(this.shownPlan);
      if (!pm && file) this.planModels.set(this.shownPlan, (pm = buildPlanFileModel(file.name, file.title, file.markdown, file.mtime)));
      return pm ?? null;
    }
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
      dr = { cursor: q?.initialCursor ?? 0, sel: new Set(), free: { on: false, text: "" }, reason: "", instruct: "" };
      // Single select: moving = selecting. Pre-select the initial position (the recommended option, else the first)
      if (q && !q.multi && q.cards[dr.cursor]) dr.sel.add(q.cards[dr.cursor]!.value);
      this.drafts.set(m.id, dr);
    }
    return dr;
  }

  view(now: number): View {
    const m = this.model();
    const dr = m ? this.draft(m) : null;
    const count = this.count(now);
    const list: View["list"] =
      this.mode === "list"
        ? {
            index: this.listIndex,
            items: this.listItems(now).map((it): ListItem => {
              if (it.plan) {
                const p = it.plan;
                return { blocker: false, title: p.title, chips: [], kindLabel: t(this.lang, "plan_kind"), createdAt: p.mtime, noExplanation: false, current: p.name === this.shownPlan, plan: { sections: p.sections, lines: p.lines, isNew: this.isNew(p, now) } };
              }
              const d = it.decision!;
              return {
                blocker: isBlocker(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}),
                title: titleOf(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}, this.lang),
                chips: chipsOf(d),
                kindLabel: t(this.lang, d.kind === "approve_plan" ? "kind_plan" : d.kind === "checkpoint" ? "checkpoint_kind" : "kind_question"),
                createdAt: d.created_at,
                noExplanation: d.kind === "answer_question" && !hasExplanation(d),
                current: d.id === this.shownId,
              };
            }),
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
      instruct: dr?.instruct ?? "",
      presets: this.presets,
      canInstruct: !!m?.readonly && !!this.files.get(m.readonly.name)?.session_id,
      pending: count,
      toast: this.toast && this.toast.until > now ? this.toast.text : null,
      lang: this.lang,
      conn: this.down ? { state: "down", server: this.server } : this.restoredUntil > now ? { state: "restored" } : null,
      list,
      history: this.mode === "history" ? { index: this.hist.index, items: this.items() } : null,
      histDetail: this.histDetail === null ? null : (this.items()[this.histDetail] ?? null),
      idle: m?.checkpoint ? this.idle(this.decisions.get(m.id)) : false,
      terminal: m?.checkpoint ? this.hasTerminal(this.decisions.get(m.id)) : false,
      copy: this.copySupported,
      recFull: this.shownId !== null && this.recFull.has(this.shownId),
      plan: m?.plan ? this.planState(m) : null,
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
    if (!this.confirm || this.confirm.until < now) return null;
    return t(this.lang, "confirm_again");
  }

  /**
   * The folding state of a long plan. It lives under the plan file's name when there is one (the plan file and its approval are one item), else under
   * the decision id. When the text changed since the state was made, the section hashes (`PlanEntry.hash`) decide what carries over (`remapState`).
   */
  private planState(m: ScreenModel): PlanState {
    const key = m.planKey ?? m.id;
    const o = m.plan!.outline;
    const memo = this.planStates.get(key);
    // The outline is rebuilt only when the text changes, so the same outline is the same text
    if (memo?.outline === o) return memo.st;
    const st = memo ? remapState(o, memo) : initialPlanState(o);
    this.planStates.set(key, { st, outline: o });
    return st;
  }

  /** Take the drawn screen dimensions and clamp the scroll positions. Returns true when a hint just started (redraw) */
  syncFrame(f: Frame, now = Date.now()): boolean {
    this.frame = f;
    this.scroll = Math.max(0, Math.min(this.scroll, f.scrollMax));
    if (this.reveal !== null) {
      // The section the contents / [ ] / Enter asked for: its heading row is only known now. One more frame puts it at the top
      const row = f.secRows[this.reveal];
      this.reveal = null;
      if (row !== undefined && row !== this.scroll) {
        this.scroll = Math.max(0, Math.min(row, f.scrollMax));
        return true;
      }
    }
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
    const { action, lastG } = interpret(key, { mode: this.mode, kind: m?.kind ?? "question", focus: this.effectiveFocus(), histDetail: this.histDetail !== null, wide: this.frame.wide, full: this.full, hscrollable: this.frame.hMax > 0, toc: !!m?.plan, planOnly: !!m?.readonly, lastG: this.lastG, now, presets: this.mode === "input" && this.input?.kind === "instruct" && this.input.text === "" ? Math.min(9, this.presets.length) : 0 });
    this.lastG = lastG;
    return action ? this.apply(action, m, now) : [];
  }

  private apply(a: Action, m: ScreenModel | null, now: number): Effect[] {
    switch (a.type) {
      case "quit": return [{ type: "quit" }];
      case "prev": this.cycle(-1, now); return [];
      case "next": this.cycle(1, now); return [];
      case "list":
        if (this.listItems(now).length) {
          this.mode = "list";
          this.listIndex = Math.max(0, this.listItems(now).findIndex((it) => this.isShown(it)));
        }
        return [];
      case "list-move": this.listIndex = clamp(this.listIndex + a.delta, this.listItems(now).length); return [];
      case "list-pick": {
        const it = this.listItems(now)[clamp(this.listIndex, this.listItems(now).length)];
        this.mode = "normal";
        if (it?.plan) this.openPlan(it.plan.name);
        else if (it?.decision) this.show(it.decision.id);
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
      case "plan-done": return this.planDone(now);
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
      case "input-cancel": {
        // Esc leaves the box and keeps the text (a note box keeps its own text on Enter, as before)
        if (this.input?.kind === "instruct" && m) this.draft(m).instruct = this.input.text;
        if (this.input?.kind === "free" && m) {
          const dr = this.draft(m);
          dr.free.text = this.input.text;
          if (!dr.free.text.trim() && !m.checkpoint) dr.free.on = false;
        }
        this.mode = this.input?.kind === "note" && this.none ? "none" : this.input?.kind === "note" && this.cannot ? "cannot" : "normal";
        this.input = null;
        return [];
      }
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
      case "instruct": return this.startInstruct(m, dr, now);
      case "preset": if (this.input?.kind === "instruct" && this.presets[a.n - 1] !== undefined) this.input.text = this.presets[a.n - 1]!; return [];
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
      case "move": this.moveCursor(m, dr, dr.cursor + a.delta); return this.landOnText(m, dr);
      case "top": this.moveCursor(m, dr, 0); return this.landOnText(m, dr);
      case "bottom": this.moveCursor(m, dr, this.slots(m) - 1); return this.landOnText(m, dr);
      case "input-move": {
        // ↑↓ in an empty free-text box walk to the neighbouring card; with text they do nothing (a one-line box)
        const inp = this.input;
        if (inp?.kind !== "free" || inp.text !== "") return [];
        dr.free.text = "";
        if (!m.checkpoint) dr.free.on = false;
        this.input = null;
        this.mode = "normal";
        this.moveCursor(m, dr, dr.cursor + a.delta);
        return this.landOnText(m, dr);
      }
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
      case "approve": dr.cursor = 0; return this.approve(m);
      case "reject": dr.cursor = 1; this.startReason(dr); return [];
      case "toc-move": {
        if (!m.plan) return [];
        const st = this.planState(m);
        st.cur = clamp(st.cur + a.delta, m.plan.outline.entries.length);
        this.rscroll = null;
        return [];
      }
      case "toc-toggle": {
        if (!m.plan) return [];
        const st = this.planState(m);
        setOpen(m.plan.outline, st, st.cur, !st.open.has(st.cur));
        if (st.open.has(st.cur)) this.reveal = st.cur;
        return [];
      }
      case "toc-all": {
        if (m.plan) toggleAll(m.plan.outline, this.planState(m));
        return [];
      }
      case "toc-section": {
        if (!m.plan) return [];
        const st = this.planState(m);
        st.cur = clamp(st.cur + a.delta, m.plan.outline.entries.length);
        setOpen(m.plan.outline, st, st.cur, true);
        this.reveal = st.cur;
        this.rscroll = null;
        return [];
      }
      default: return [];
    }
  }

  // ---- Items ----

  /** The list (`b`): pending decisions first, then the new plans newest first (a plan that is a pending approval is its decision's row) */
  private listItems(now: number): { decision?: Decision; plan?: PlanSummary }[] {
    return [...this.pending().map((decision) => ({ decision })), ...this.newPlans(now).map((plan) => ({ plan }))];
  }

  private isShown(it: { decision?: Decision; plan?: PlanSummary }): boolean {
    return it.plan ? it.plan.name === this.shownPlan : it.decision!.id === this.shownId;
  }

  private cycle(step: number, now: number): void {
    const items = this.listItems(now);
    const i = items.findIndex((it) => this.isShown(it));
    if (!items.length || (items.length === 1 && i === 0)) return;
    // A plan on screen that is no longer an item (it was read meanwhile) steps to the first / last
    const from = i >= 0 ? i : step > 0 ? -1 : items.length;
    const next = items[(from + step + items.length) % items.length]!;
    if (next.plan) this.openPlan(next.plan.name);
    else this.show(next.decision!.id);
  }

  /** Done reading: mark the plan read (unless it already is), then the next item or the idle screen */
  private planDone(now: number): Effect[] {
    const name = this.shownPlan;
    if (!name) return [];
    const file = this.files.get(name);
    const effects = file ? this.markRead(name, file.mtime) : [];
    this.advance(now);
    return effects;
  }

  /** Number of positions the cursor can rest on: cards + "None of these" + "Can't answer this" + free text for a question, 2 buttons for a plan */
  private slots(m: ScreenModel): number {
    if (m.kind === "plan") return 3;
    if (m.checkpoint) return CHECKPOINT_CARDS;
    return m.question ? m.question.cards.length + 3 : 0;
  }

  /** Approve a plan: one press, always with the auto mode (unread sections are shown above the buttons, never a gate) */
  private approve(m: ScreenModel): Effect[] {
    return this.emit(m.id, { approve: true, set_mode_auto: true });
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
    if (!q || !q.cards.length) return [];
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
    if (m.checkpoint) return this.checkpointCard(m, dr, i);
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
    if (!q || !q.cards.length) return [];
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
    // With no options the cursor never rests on the hidden None of these / Can't answer rows (slots 0 and 1)
    dr.cursor = m.question && !m.question.cards.length ? Math.max(2, clamp(to, n)) : clamp(to, n);
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

  /** A checkpoint's three cards, one press each: continue and stop send at once, the instruction card opens the text box (Enter there sends it) */
  private checkpointCard(m: ScreenModel, dr: Draft, i: number): Effect[] {
    dr.cursor = i;
    if (i === 0) return this.emit(m.id, { kind: "continue" });
    if (i === 2) return this.emit(m.id, { kind: "stop" });
    return this.startFree(m, dr);
  }

  /** The cursor landing on a card with a text box (the checkpoint's instruction card, the free-text card) opens the box at once; `i` still does too */
  private landOnText(m: ScreenModel, dr: Draft): Effect[] {
    if (this.mode !== "normal") return [];
    const onText = m.checkpoint ? dr.cursor === 1 : !!m.question && dr.cursor === m.question.cards.length + 2;
    return onText ? this.startFree(m, dr) : [];
  }

  private startFree(m: ScreenModel, dr: Draft): Effect[] {
    if (m.checkpoint) {
      dr.cursor = 1;
      this.input = { kind: "free", text: dr.free.text };
      this.mode = "input";
      return [];
    }
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

  /** `i` on a plan: the approval card, or a plan file whose session is known. The text typed earlier comes back */
  private startInstruct(m: ScreenModel, dr: Draft, now: number): Effect[] {
    if (m.kind !== "plan") return [];
    if (m.readonly && !this.files.get(m.readonly.name)?.session_id) {
      this.showToast(t(this.lang, "plan_no_session"), now);
      return [];
    }
    dr.cursor = 2;
    this.input = { kind: "instruct", text: dr.instruct };
    this.mode = "input";
    return [];
  }

  private confirmInput(m: ScreenModel, dr: Draft, now: number): Effect[] {
    const inp = this.input;
    if (!inp) return [];
    if (inp.kind === "instruct") {
      dr.instruct = inp.text;
      const text = inp.text.trim();
      if (!text) return [];
      this.input = null;
      this.mode = "normal";
      if (m.readonly) {
        // The text stays in the draft until the server took it (a failed send keeps it)
        if (this.sending.has(m.id)) return [];
        this.sending.add(m.id);
        return [{ type: "instruct_plan", name: m.readonly.name, text }];
      }
      return this.emit(m.id, { instruct: true, text });
    }
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
    if (m.checkpoint) {
      this.input = null;
      this.mode = "normal";
      // Enter on typed text sends it as the instruction; an empty box sends nothing
      return inp.text.trim() ? this.emit(m.id, { kind: "instruct", text: inp.text.trim() }) : [];
    }
    if (!inp.text.trim()) dr.free.on = false;
    this.input = null;
    this.mode = "normal";
    // Single select: Enter on the typed text sends it (an empty text sends nothing). Multi select only confirms: the ticked options go with it on the next Enter
    return m.question && !m.question.multi && inp.text.trim() ? this.submit(m, dr, now) : [];
  }

  private complete(m: ScreenModel, dr: Draft): boolean {
    const q = m.question;
    if (!q) return false;
    if (dr.free.on && !q.multi) return dr.free.text.trim() !== "";
    if (dr.free.on && dr.free.text.trim()) return true;
    return dr.sel.size > 0;
  }

  private submit(m: ScreenModel, dr: Draft, now: number): Effect[] {
    if (m.checkpoint) return dr.cursor === 1 && dr.free.text.trim() ? this.emit(m.id, { kind: "instruct", text: dr.free.text.trim() }) : this.checkpointCard(m, dr, dr.cursor);
    if (m.kind === "plan") {
      if (dr.cursor === 0) return this.approve(m);
      if (dr.cursor === 2) return this.startInstruct(m, dr, now);
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
    const key = updated.kind === "checkpoint" && updated.status === "answered" && updated.response?.kind !== "continue" ? "checkpoint_sent" : STATUS_KEY[updated.status];
    this.showToast(t(this.lang, key ?? "sent"), now);
    if (updated.id === this.shownId) this.advance(now);
  }

  /** The server's answer to an instruction sent from a plan file */
  planInstructed(name: string, via: string, now: number): void {
    const key = planKeyOf(name);
    this.sending.delete(key);
    const dr = this.drafts.get(key);
    if (dr) dr.instruct = "";
    this.showToast(t(this.lang, via === "terminal" ? "plan_instruct_typed" : "plan_instruct_sent"), now);
  }

  planInstructFailed(name: string, message: string, now: number): void {
    this.sending.delete(planKeyOf(name));
    this.showToast(t(this.lang, "send_failed", { message }), now);
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
