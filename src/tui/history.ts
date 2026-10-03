import type { SessionHistory } from "../contract.js";

export interface HistoryItem {
  /** The instruction that started the session */
  first: boolean;
  at: string;
  text: string;
}

/** Chronological list for the overlay: the first instruction (full text), then the recent ones. `recent` overlaps `first` when the session is short */
export function historyItems(h: SessionHistory | null): HistoryItem[] {
  if (!h) return [];
  const rest = h.first && h.recent.length >= h.total ? h.recent.slice(1) : h.recent;
  return [...(h.first ? [{ first: true, ...h.first }] : []), ...rest.map((e) => ({ first: false, ...e }))];
}

/** Whitespace collapsed to single spaces (one line) */
export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
