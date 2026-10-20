---
ukagai: 1
question: 起動時の注入を有効にしてよいですか？
title: Enable the startup injection or keep it off
reversibility: reversible
scope: repo
recommended: 有効にする
---

## Why this decision is needed now

起動時に文脈を注入すると、最初の応答が速くなります。実機で動くかはまだ確かめていません。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| 有効にする | 起動時に文脈が入る。 | 起動時注入が実機で動くかは未確認のまま。 |
| 無効のままにする | 今までどおり。 | 前提が外れたら、設計を実装後に作り直すことになる。 |

## Recommendation

有効にするのが良いです。効果が見込めます。無効のままにする案が合うのは、実機で動かない場合です。

## What I checked

- 関連する箇所を読んで確かめた[^1]。

[^1]: `src/config.ts` を読んだ。
