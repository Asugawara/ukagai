import type { Decision } from "../../src/contract.js";

export const V2_MD = `---
ukagai: 1
question: 通知は SSE と WebSocket のどちらにしますか？
title: GUI の更新通知を SSE と WebSocket のどちらにするか
reversibility: costly
scope: repo
recommended: SSE
---

## なぜ今この判断が要るか

server が \`/api/stream\` を実装する前に、**通知の方式**を決める必要があります。

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| SSE | server から GUI への一方向配信になる。 | **双方向**にしたくなったら書き直す(約 1 日)。 |
| WebSocket | 双方向にできる。 | 依存が増える。 |

## 推奨

SSE を推します。実装が小さく済みます。

## 図

\`\`\`mermaid
flowchart LR
  H[hook] --> S[serve]
\`\`\`

## 確かめたこと

- WebSocket の依存は無い。
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
          question: "通知は SSE と WebSocket のどちらにしますか？",
          header: "方式",
          multiSelect: false,
          options: [
            { label: "SSE (Recommended)", description: "一方向" },
            { label: "WebSocket", description: "双方向" },
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
