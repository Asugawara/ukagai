---
ukagai: 1
question: 判断を保存するファイルの名前は decisions.jsonl と log.jsonl のどちらにしますか？
title: Choose decisions.jsonl or log.jsonl as the decision log file name
reversibility: reversible
scope: file
recommended: decisions.jsonl
---

## Why this decision is needed now

Decide the name of the file created in `~/.ukagai/` before the store is implemented. The name appears in only one place, a constant in `src/server/store.ts`, so changing it later is easy. It is a matter of taste, so there is room for a human to decide.

## Options

| Option | Pros | Cons | Cost |
|---|---|---|---|
| decisions.jsonl | The name shows the content | Slightly long | 0 |
| log.jsonl | Short | Hard to tell apart from events | 0 |

## Recommendation

I recommend `decisions.jsonl`. The name shows the content and stays distinct from `events.jsonl`. `log.jsonl` becomes the right choice if you prefer brevity.
