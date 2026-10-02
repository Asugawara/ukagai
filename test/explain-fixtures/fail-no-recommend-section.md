---
ukagai: 1
question: 判断を保存するファイルの名前は decisions.jsonl と log.jsonl のどちらにしますか？
title: Choose decisions.jsonl or log.jsonl as the decision log file name
reversibility: reversible
scope: file
recommended: decisions.jsonl (Recommended)
---

## Why this decision is needed now

Decide the name of the file created in `~/.ukagai/` before the store is implemented. The name appears in only one place, a constant in `src/server/store.ts`, so changing it later is easy. It is a matter of taste, so there is room for a human to decide.

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| decisions.jsonl (Recommended) | The name shows the content (decisions), and it reads well next to `events.jsonl`. | Only slightly longer. Revert by changing the one constant. |
| log.jsonl | The name is shorter. | Hard to tell apart from events. Revert by changing the one constant. |
