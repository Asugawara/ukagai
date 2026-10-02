import type { Decision } from "../../src/contract.js";

/** The question text of the default decision. */
export const Q = "Should notifications use SSE or WebSocket?";

/** A v2 explanation (English headings, the canonical form). */
export const V2_MD = `---
ukagai: 1
question: ${Q}
title: Whether the GUI update channel uses SSE or WebSocket
reversibility: costly
scope: repo
recommended: SSE
---

## Why this decision is needed now

Before the server implements \`/api/stream\`, the **delivery mechanism** has to be chosen.

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| SSE | One-way delivery from the server to the GUI. | If you later need **two-way**, rewrite it (about 1 day). |
| WebSocket | Two-way is possible. | Adds a dependency. |

## Recommendation

I recommend SSE. It is the smaller implementation.

## Diagram

\`\`\`mermaid
flowchart LR
  H[hook] --> S[serve]
\`\`\`

## What I checked

- There is no WebSocket dependency.
`;

/** The same explanation with Japanese heading aliases (must render the same screen). */
export const V2_MD_JA = `---
ukagai: 1
question: ${Q}
title: Whether the GUI update channel uses SSE or WebSocket
reversibility: costly
scope: repo
recommended: SSE
---

## なぜ今この判断が要るか

Before the server implements \`/api/stream\`, the **delivery mechanism** has to be chosen.

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| SSE | One-way delivery from the server to the GUI. | If you later need **two-way**, rewrite it (about 1 day). |
| WebSocket | Two-way is possible. | Adds a dependency. |

## 推奨

I recommend SSE. It is the smaller implementation.

## 図

\`\`\`mermaid
flowchart LR
  H[hook] --> S[serve]
\`\`\`

## 確かめたこと

- There is no WebSocket dependency.
`;

export function decision(over: Partial<Decision> & Record<string, unknown> = {}): Decision {
  return {
    id: "d1",
    kind: "answer_question",
    tool_use_id: "t1",
    session: { session_id: "s1", cwd: "/Users/a/.herdr/worktrees/ukagai/feat-tui", transcript_path: "/x" },
    request: {
      questions: [
        {
          question: Q,
          header: "Method",
          multiSelect: false,
          options: [
            { label: "SSE (Recommended)", description: "One-way" },
            { label: "WebSocket", description: "Two-way" },
          ],
        },
      ],
    },
    context: { branch: "feat/tui" },
    status: "pending",
    created_at: "2026-10-02T00:00:00.000Z",
    ...over,
  } as Decision;
}

export function withExplanation(markdown: string, over: Record<string, unknown> = {}): Partial<Decision> {
  return {
    explanation: {
      path: "/x/e.md",
      markdown,
      has: { mermaid: true, table: true, diff: false },
      match: "question",
      attached_via: "first_call",
      ...over,
    },
  } as Partial<Decision>;
}

export const BLOCKER_Q = "The gcloud authentication has expired. Did you take care of it?";

export const BLOCKER_MD = `---
ukagai: 1
question: ${BLOCKER_Q}
type: blocker
title: Run \`gcloud auth login\` because the gcloud authentication has expired
recommended: Done. Continue
reversibility: reversible
scope: machine
---

## Why I stopped

\`gcloud run deploy\` failed with an authentication error. A browser login is required and I cannot do it.

\`\`\`
ERROR: (gcloud.run.deploy) You do not currently have an active account selected.
Please run: $ gcloud auth login
\`\`\`

## What you need to do

1. Run the following in a terminal and log in in the browser.
2. Also refresh the application default credentials.

\`\`\`sh
gcloud auth login
gcloud auth application-default login
\`\`\`

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Done. Continue | Retry the same deploy and continue. | If the login did not work, it stops again with the same error. |
| Skip this step and continue | Skip the deploy and go on with the rest. | Nothing is deployed. Deploy by hand later to undo. |
| Stop here | Stop the work here. | Changes made so far remain. Resuming continues from there. |
`;

/** The same blocker with Japanese heading aliases and Japanese option labels. */
export const BLOCKER_MD_JA = `---
ukagai: 1
question: ${BLOCKER_Q}
type: blocker
title: Run \`gcloud auth login\` because the gcloud authentication has expired
recommended: 対応した。続けて
reversibility: reversible
scope: machine
---

## なぜ止まったか

\`gcloud run deploy\` failed with an authentication error.

## 人にしてほしいこと

1. Run the following in a terminal.

\`\`\`sh
gcloud auth login
\`\`\`

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| 対応した。続けて | Retry the deploy. | It may stop again. |
| この手順は飛ばして続けて | Skip the deploy. | Nothing is deployed. |
| ここで中断 | Stop here. | Changes remain. |
`;

const BLOCKER_OPTIONS = [
  { label: "Done. Continue (Recommended)", description: "Retry" },
  { label: "Skip this step and continue", description: "Skip" },
  { label: "Stop here", description: "Stop" },
];

/** A blocker (waiting for the human) decision. The explanation is BLOCKER_MD. */
export function blockerDecision(over: Partial<Decision> & Record<string, unknown> = {}, md = BLOCKER_MD, options = BLOCKER_OPTIONS): Decision {
  return decision({
    request: { questions: [{ question: BLOCKER_Q, header: "Waiting", multiSelect: false, options }] },
    ...withExplanation(md, { type: "blocker" }),
    ...over,
  } as never);
}
