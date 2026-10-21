// What the GUI / TUI preserve tests look for on screen: the "atoms" of a pass-* explanation fixture.
// An atom is found by a line-based scan (no full-text diff): fenced blocks (a count per language, plus the first body line or `title=` of every
// block but Mermaid), image alts and the sentinel words (`KEEP…`) embedded in the fixtures.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_DIAGRAM_NOTE, SECTION, findSection, findTables, normalizeLabel, parseFrontMatter, scanFences, scanHeadings, toLines } from "../../src/hook/explain.js";

export const FIXTURE_DIR = fileURLToPath(new URL("../explain-fixtures/", import.meta.url));

/**
 * The only content an explanation may lose on screen. A line that matches `test` is not scanned for atoms.
 * Everything else the hook accepts must reach the GUI and the TUI.
 */
export const ALLOWED_DROPS: { what: string; why: string; test: (line: string) => boolean }[] = [
  {
    what: "`No diagram: <reason>` lines",
    why: "the hook reads them as proof that a diagram was considered; they are not content for the human",
    test: (line) => NO_DIAGRAM_NOTE.test(line),
  },
];
// The front matter is not scanned either: its fields are shown as the title, the chips and the question, not as written.

export interface Atoms {
  /** Fenced blocks: the number per language, and for every block but Mermaid the text to look for (`title=` or the first body line) */
  fences: Record<string, number>;
  codeKeys: string[];
  /** The source of every Mermaid block */
  mermaid: string[];
  /** The alt of every image */
  images: string[];
  /** The `KEEP…` words outside fences and image syntax */
  sentinels: string[];
}

export function atomsOf(markdown: string): Atoms {
  const lines = toLines(markdown);
  const body = lines.slice(parseFrontMatter(lines).bodyStart);
  const { inFence, blocks } = scanFences(body);
  const atoms: Atoms = { fences: {}, codeKeys: [], mermaid: [], images: [], sentinels: [] };
  for (const b of blocks) {
    const lang = b.lang || "text";
    atoms.fences[lang] = (atoms.fences[lang] ?? 0) + 1;
    if (lang === "mermaid") {
      atoms.mermaid.push(body.slice(b.start + 1, b.end).join("\n"));
      continue;
    }
    const title = /\btitle="([^"]+)"|\btitle=(\S+)/.exec(body[b.start]!);
    const first = body.slice(b.start + 1, b.end).find((l) => l.trim() !== "");
    const key = (title?.[1] ?? title?.[2] ?? first ?? "").trim();
    if (key) atoms.codeKeys.push(key);
  }
  body.forEach((line, i) => {
    if (inFence[i] || ALLOWED_DROPS.some((a) => a.test(line))) return;
    for (const m of line.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) atoms.images.push(m[1]!);
    for (const m of line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").matchAll(/KEEP[A-Z]+/g)) atoms.sentinels.push(m[0]);
  });
  return atoms;
}

export interface PassCase {
  file: string;
  markdown: string;
  kind: "decision" | "blocker" | "quiz";
  question: string;
  title: string;
  /** The option labels of the AskUserQuestion call (the first column of the Options table, `(Recommended)` / `(推奨)` stripped) */
  labels: string[];
  atoms: Atoms;
}

/** Quizzes have no Options table: their options are free text */
const QUIZ_LABELS = ["Some(true), the extension is not .json", "Some(false), fixtures are out of scope", "None, the extension decides nothing"];

export function passCases(): PassCase[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => /^pass-.+\.md$/.test(f))
    .sort()
    .map((file) => {
      const markdown = readFileSync(join(FIXTURE_DIR, file), "utf8");
      const lines = toLines(markdown);
      const fm = parseFrontMatter(lines);
      const kind = fm.fields["type"] === "blocker" ? "blocker" : fm.fields["type"] === "quiz" ? "quiz" : "decision";
      const body = lines.slice(fm.bodyStart);
      const { inFence } = scanFences(body);
      const options = findSection(scanHeadings(body, inFence), body.length, SECTION.options);
      const table = options ? findTables(body, inFence, options.start + 1, options.end)[0] : undefined;
      const labels = kind === "quiz" ? QUIZ_LABELS : (table?.rows ?? []).map((r) => (r[0] ?? "").replace(/\s*[(（](?:recommended|推奨)[)）]\s*$/iu, ""));
      if (kind !== "quiz" && labels.length < 2) throw new Error(`${file}: no Options table`);
      if (kind !== "quiz") for (const l of labels) if (!normalizeLabel(l)) throw new Error(`${file}: empty option label`);
      return { file, markdown, kind, question: fm.fields["question"] ?? "", title: fm.fields["title"] ?? "", labels, atoms: atomsOf(markdown) };
    });
}
