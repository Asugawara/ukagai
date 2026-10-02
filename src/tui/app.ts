import { MULTI_SELECT_SEPARATOR, type Decision } from "../contract.js";
import { interpret, type Action, type Focus, type Key, type Mode } from "./keys.js";
import { buildModel, hasExplanation, isBlocker, titleOf, chipsOf, type ScreenModel } from "./model.js";
import type { Frame, ListItem, View } from "./render.js";
import { parseFrontMatterFields } from "./util.js";

// 状態遷移(I/O なし)。キーを渡すと、呼び出し側が実行する Effect を返す。

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
/** ホイール 1 ノッチの行数 */
export const WHEEL_LINES = 3;
/** ← → 1 回の横スクロール量(桁) */
export const HSCROLL_STEP = 8;
/** 「f で全幅表示」の案内を出しておく時間 */
export const FULL_HINT_MS = 6000;

const STATUS_TEXT: Record<string, string> = {
  answer_submitted: "届けています…",
  answered: "届きました",
  answer_lost: "ターミナルに落ちました(hook が切断)",
  hook_disconnected: "hook が切断されました",
  fallback: "ターミナルで答えます",
  cancelled: "キャンセルされました",
};

export class App {
  readonly decisions = new Map<string, Decision>();
  shownId: string | null = null;
  mode: Mode = "normal";
  /** 背景(上下配置では画面全体)の先頭行 */
  scroll = 0;
  /** 判断列の先頭行。null ならカーソルに追従 */
  rscroll: number | null = null;
  focus: Focus = "decision";
  /** 幅超過の図の横位置(桁) */
  hscroll = 0;
  /** 背景を全幅で表示(判断の列を隠す) */
  full = false;
  /** 直近に描いた画面の寸法(スクロールの量と範囲に使う) */
  private frame: Pick<Frame, "wide" | "split" | "scrollMax" | "rightMax" | "rightOff" | "off" | "bodyRows" | "hMax"> = {
    wide: false, split: 0, scrollMax: 0, rightMax: 0, rightOff: 0, off: 0, bodyRows: 20, hMax: 0,
  };
  /** 「f で全幅表示」の案内は判断ごとに 1 回。出した判断と、いつまで出すか */
  private hinted = new Set<string>();
  private hintUntil = 0;
  /** クリップボードに送れるか(pbcopy の有無。index.ts が決める) */
  copySupported = true;
  private models = new Map<string, ScreenModel>();
  private drafts = new Map<string, Draft>();
  private input: { kind: "free" | "reason"; text: string } | null = null;
  private listIndex = 0;
  private lastG = 0;
  private toast: { text: string; until: number } | null = null;
  private sending = new Set<string>();
  private sent = new Set<string>();

  // ---- データ ----

  pending(): Decision[] {
    return [...this.decisions.values()]
      .filter((d) => d.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** 起動時・再取得時の一覧(pending のみ)。手元で pending のまま一覧から消えたものは取り直す対象として返す */
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
      const t = STATUS_TEXT[d.status];
      if (t) this.showToast(t, now);
      if (d.status !== "answer_submitted") this.sent.delete(d.id);
    }
    if (d.id === this.shownId) {
      if (d.status !== "pending") this.advance(now);
    } else if (this.shownId == null && d.status === "pending") {
      this.show(d.id);
    }
  }

  private showToast(text: string, now: number): void {
    this.toast = { text, until: now + TOAST_MS };
  }

  private show(id: string | null): void {
    this.shownId = id;
    this.scroll = 0;
    this.rscroll = null;
    this.hscroll = 0;
    this.full = false;
    this.hintUntil = 0;
    this.input = null;
    if (this.mode === "input") this.mode = "normal";
  }

  private advance(_now: number): void {
    this.show(this.pending()[0]?.id ?? null);
  }

  // ---- 取り出し ----

  model(): ScreenModel | null {
    const d = this.shownId ? this.decisions.get(this.shownId) : undefined;
    if (!d) return null;
    let m = this.models.get(d.id);
    if (!m) this.models.set(d.id, (m = buildModel(d)));
    return m;
  }

  private draft(m: ScreenModel): Draft {
    let dr = this.drafts.get(m.id);
    if (!dr) {
      const q = m.question;
      dr = { cursor: q?.initialCursor ?? 0, sel: new Set(), free: { on: false, text: "" }, reason: "" };
      // 単一選択は移動 = 選択。初期位置(推奨、無ければ先頭)を選んでおく
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
              title: titleOf(d, d.kind === "answer_question" && hasExplanation(d) ? parseFrontMatterFields(d.explanation!.markdown) : {}),
              chips: chipsOf(d),
              kindLabel: d.kind === "approve_plan" ? "計画" : "質問",
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
      reason: dr?.reason ?? "",
      pending: pending.length,
      toast: this.toast && this.toast.until > now ? this.toast.text : null,
      list,
      copy: this.copySupported,
      scroll: this.scroll,
      rscroll: this.rscroll,
      focus: this.focus,
      hscroll: this.hscroll,
      full: this.full,
      fullHint: this.hintUntil > now,
      now,
    };
  }

  /** 描いた画面の寸法を受け取り、スクロール位置を範囲に収める。案内を出し始めたら true(描き直す) */
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

  /** 左右配置のときだけフォーカスが意味を持つ。全幅表示中は背景 */
  private effectiveFocus(): Focus {
    return this.frame.wide ? (this.full ? "background" : this.focus) : "decision";
  }

  /** 背景(上下配置では画面全体)を to へ。現在の見え方 cur から相対で動かすときは呼び出し側が計算する */
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
      // 上下配置は 0 のときカーソル追従。いま見えている位置から動かす
      this.setScroll((this.scroll || f.off) + d);
    }
  }

  // ---- キー ----

  handle(key: Key, now: number): Effect[] {
    const m = this.model();
    if (key.name === "wheel") {
      if (this.mode === "normal") this.wheel(key.dir, key.x);
      return [];
    }
    const { action, lastG } = interpret(key, { mode: this.mode, kind: m?.kind ?? "question", focus: this.effectiveFocus(), wide: this.frame.wide, full: this.full, hscrollable: this.frame.hMax > 0, lastG: this.lastG, now });
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
      case "scroll": {
        const n = a.unit === "half" ? Math.max(1, Math.floor(this.frame.bodyRows / 2)) : 1;
        // 上下配置は 0 のときカーソル追従。いま見えている位置から動かす
        this.setScroll((this.frame.wide ? this.scroll : this.scroll || this.frame.off) + a.delta * n);
        return [];
      }
      case "scroll-edge": this.setScroll(a.to === "top" ? 0 : this.frame.scrollMax); return [];
      case "hscroll": this.hscroll = Math.max(0, Math.min(this.frame.hMax, this.hscroll + a.delta * HSCROLL_STEP)); return [];
      case "full": this.full = !this.full; this.scroll = 0; return [];
      case "focus": this.focus = this.focus === "decision" ? "background" : "decision"; return [];
      case "input-char": if (this.input) this.input.text += a.ch; return [];
      case "input-backspace": if (this.input) this.input.text = Array.from(this.input.text).slice(0, -1).join(""); return [];
      case "input-cancel": this.input = null; this.mode = "normal"; return [];
    }
    if (!m) return [];
    const dr = this.draft(m);
    switch (a.type) {
      case "input-confirm": return this.confirmInput(m, dr);
      case "move": this.moveCursor(m, dr, dr.cursor + a.delta); return [];
      case "top": this.moveCursor(m, dr, 0); return [];
      case "bottom": this.moveCursor(m, dr, this.slots(m) - 1); return [];
      case "toggle": return this.toggle(m, dr);
      case "free": return this.startFree(m, dr);
      case "copy": {
        const text = m.todoCode[0];
        return text ? [{ type: "copy", text }] : [];
      }
      case "submit": return this.submit(m, dr, now);
      case "approve": return this.send(m, { approve: true, set_mode_auto: false }, now);
      case "approve-auto": return this.send(m, { approve: true, set_mode_auto: true }, now);
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

  /** カーソルが止まれる数。質問はカード + 自由記述、計画はボタン 3 つ */
  private slots(m: ScreenModel): number {
    if (m.kind === "plan") return 3;
    return m.question ? m.question.cards.length + 1 : 0;
  }

  private moveCursor(m: ScreenModel, dr: Draft, to: number): void {
    const n = this.slots(m);
    if (!n) return;
    dr.cursor = clamp(to, n);
    this.scroll = 0;
    this.rscroll = null;
    const q = m.question;
    if (!q || q.multi) return;
    // 単一選択は移動 = 選択
    if (dr.cursor < q.cards.length) {
      dr.sel = new Set([q.cards[dr.cursor]!.value]);
      dr.free.on = false;
    } else {
      dr.sel.clear();
      dr.free.on = true;
    }
  }

  private toggle(m: ScreenModel, dr: Draft): Effect[] {
    const q = m.question;
    if (!q?.multi) return [];
    if (dr.cursor >= q.cards.length) {
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
    dr.cursor = q.cards.length;
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

  private confirmInput(m: ScreenModel, dr: Draft): Effect[] {
    const inp = this.input;
    if (!inp) return [];
    if (inp.kind === "reason") {
      dr.reason = inp.text;
      const reason = inp.text.trim();
      if (!reason) return [];
      this.input = null;
      this.mode = "normal";
      return this.send(m, { approve: false, reason }, 0);
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
      if (dr.cursor === 0) return this.send(m, { approve: true, set_mode_auto: false }, now);
      if (dr.cursor === 1) return this.send(m, { approve: true, set_mode_auto: true }, now);
      this.startReason(dr);
      return [];
    }
    const q = m.question;
    if (!q) return [];
    if (dr.cursor === q.cards.length && !dr.free.text.trim()) return this.startFree(m, dr);
    if (!this.complete(m, dr)) return [];
    // 回答は元の option.label で返す
    const picked = q.cards.map((c) => c.value).filter((v) => dr.sel.has(v));
    if (dr.free.on && !q.multi) picked.length = 0;
    if (dr.free.on && dr.free.text.trim()) picked.push(dr.free.text.trim());
    return this.send(m, { answers: { [questionText(this.decisions.get(m.id)!)]: picked.join(MULTI_SELECT_SEPARATOR) } }, now);
  }

  private send(m: ScreenModel, body: Record<string, unknown>, _now: number): Effect[] {
    if (this.sending.has(m.id)) return [];
    this.sending.add(m.id);
    return [{ type: "answer", id: m.id, body }];
  }

  // ---- 送信の結果 ----

  answered(updated: Decision, now: number): void {
    this.sending.delete(updated.id);
    this.sent.add(updated.id);
    this.decisions.set(updated.id, updated);
    this.showToast(STATUS_TEXT[updated.status] ?? "送信しました", now);
    if (updated.id === this.shownId) this.advance(now);
  }

  failed(id: string, message: string, now: number): void {
    this.sending.delete(id);
    this.showToast(`送信に失敗しました: ${message}`, now);
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
