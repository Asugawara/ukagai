// Types of demo/timeline.js. The timeline is checked against them with // @ts-check.
export type Lang = "en" | "ja";
export type Text = string | { en: string; ja: string };
// in / out / inOut are all sine curves
export type Ease = "linear" | "in" | "out" | "inOut";
export interface Box {
  x: number;
  y: number;
  s: number;
  opacity?: number;
  dim?: number;
  z?: number;
}
export type Rect = { x: number; y: number; w: number; h: number };
export type Target =
  | "all"
  | { window: string; pad?: number }
  | { anchor: string; pad?: number }
  | { rect: Rect; pad?: number };
export interface Line {
  at: number;
  kind: "user" | "tool" | "result" | "error" | "text" | "message" | "status";
  text: Text;
}
export interface Scene {
  name: string;
  dur: number;
  caption?: string | null | { at: number; key: string | null };
  layout?: { to: string; at?: number; dur?: number; ease?: Ease };
  camera?: { at?: number; to: Target; dur?: number; ease?: Ease }[];
  gui?: { at?: number; shot: string; scroll?: { from: number; to: number; dur: number; ease?: Ease } }[];
  term?: Record<string, Line[]>;
  focus?: { at?: number; window: string | null }[];
  keys?: { at: number; key: string }[];
  pulse?: { at: number; window: string }[];
  beams?: { at: number; from: string; to: Target; dur?: number }[];
  cursor?: { at: number; to: Target | null; dur?: number; click?: boolean }[];
}
export interface WindowDef {
  kind: "terminal" | "browser";
  agent?: "claude" | "codex";
  title: Text;
  status?: Text;
  repo?: string;
  url?: string;
  w: number;
  h?: number;
}
export interface Timeline {
  width: number;
  height: number;
  fps: number;
  loopDissolve: number;
  // Playback speed: playback seconds = timeline seconds / speed
  speed: number;
  windows: Record<string, WindowDef>;
  layouts: Record<string, Record<string, Box>>;
  captions: Record<string, { n: string; en: string; ja: string }>;
  scenes: Scene[];
}
export interface StorySession {
  prompt: string;
  question?: string;
  instruction?: string;
}
// The human's first line and the question or instruction per session; the seeds read the same text
export type Story = Record<Lang, Record<"cc" | "cc2" | "codex", StorySession>>;

// What demo/out/<lang>/shots/manifest.json holds that the stage reads
export interface ManifestAnchor extends Rect {
  inScroll: boolean;
}
export interface ManifestShot {
  file: string;
  title: string;
  favicon: string;
  scrollTop: number;
  toast?: string;
  anchors?: Record<string, ManifestAnchor>;
  scroll?: { el: string; ys: number[]; files: string[]; anchors?: Record<string, ManifestAnchor> };
}
export interface Manifest {
  lang: Lang;
  viewport: { w: number; h: number };
  dsf: number;
  repos: Record<string, string>;
  shots: Record<string, ManifestShot>;
}
