// The AskUserQuestion fields a decision card may show, in one place for the GUI and TUI tests (test/gui/preserve.test.ts, test/tui/fields.test.ts).
// Every field is either shown (its value must reach the screen) or hidden with a reason. A new field that is in neither list is not tested at all:
// add it here when AskUserQuestion gets one.
import { SECTION } from "../../src/hook/explain.js";

/** Values that are easy to find on a screen */
export const V = {
  question: "FQUESTION which cache should it read",
  header: "FHEADER",
  alpha: { label: "FALPHA", description: "FDESCALPHA", preview: "FPREVALPHA first row\n\tFPREVTAB second row" },
  beta: { label: "FBETA", description: "FDESCBETA", preview: "FPREVBETA" },
  gamma: { label: "FGAMMA", description: "FDESCGAMMA", preview: "FPREVGAMMA" },
} as const;

/** `word`: what the field leaves on a screen. `true` = shown; a string = hidden, and why */
export interface FieldRule {
  field: string;
  word: string;
  plain: true | string;
  /** With an explanation whose Options table has rows for Alpha and Beta only */
  explained: true | string;
  /** Where the GUI differs from the TUI */
  gui?: { plain?: true | string; explained?: true | string };
}

export const FIELD_RULES: FieldRule[] = [
  { field: "question", word: "FQUESTION", plain: true, explained: "the explanation's title and recommendation say it; the same text is in its front matter" },
  { field: "header", word: "FHEADER", plain: true, explained: "the explanation's title replaces it", gui: { plain: "with one question the head shows the question; the header only tells an `Approval` card apart" } },
  { field: "options[].label", word: "FBETA", plain: true, explained: true },
  { field: "options[].description (option with a table row)", word: "FDESCBETA", plain: true, explained: "the table row's cells replace it (public/README.md, the Options table)" },
  { field: "options[].description (option without a table row)", word: "FDESCGAMMA", plain: true, explained: true },
  { field: "options[].preview (cursor card)", word: "FPREVALPHA", plain: true, explained: true },
];
// multiSelect is not text: it decides between radio buttons / `○` and checkboxes / `[ ]`, and is asserted by the tests directly.

export const options = (): { label: string; description: string; preview: string }[] => [
  { ...V.alpha, label: `${V.alpha.label} (Recommended)` },
  { ...V.beta },
  { ...V.gamma },
];

/** An explanation (the Options table has rows for Alpha and Beta, not for Gamma) */
export const EXPLAINED_MD = `---
ukagai: 1
question: ${V.question}
title: Pick the cache layer
reversibility: reversible
scope: file
recommended: ${V.alpha.label}
---

## ${SECTION.why[0]}

The report page is slow on a cold start.

## ${SECTION.options[0]}

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| ${V.alpha.label} | Entries live in the process. | Undo: remove the module. |
| ${V.beta.label} | Entries live on disk. | Undo: delete the directory. |

## ${SECTION.recommendation[0]}

I recommend ${V.alpha.label}. If the report must survive a restart, ${V.beta.label}.
`;
