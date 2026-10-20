---
ukagai: 1
question: 次の作業をどの順で進めますか？
title: Pick the order of the next two tasks
reversibility: reversible
scope: repo
recommended: 先に設定を直す
---

## Why this decision is needed now

計画 v2 の U3 と、M6 の D1 が残っています。D0 は終わっています。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| 先に設定を直す | 設定の修正から始める。 | 戻し方: 修正のコミットを revert する。 |
| 先にテストを足す | テストの追加から始める。 | 戻し方: テストのコミットを revert する。 |

## Recommendation

先に設定を直すのが良いです。後続の作業が楽になります。先にテストを足す案が合うのは、設定の変更が小さい場合です。

## What I checked

- 関連する箇所を読んで確かめた[^1]。

[^1]: `src/config.ts` を読んだ。
