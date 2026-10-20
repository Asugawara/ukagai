---
ukagai: 1
question: 本番の設定を更新してよいですか？
title: Update the production settings now or wait for the next window
reversibility: reversible
scope: external
recommended: 今すぐ更新する
---

## Why this decision is needed now

本番の設定は外部の利用者にも影響します。更新のタイミングを人が決めます。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| 今すぐ更新する | 設定がすぐ反映される。 | 戻し方: 前の設定に戻して再反映する。 |
| 次の枠で更新する | 夜間の枠で反映する。 | 何も変わらない。いつでも更新できます。 |

No diagram: <why> (when one is required and none fits)

## Recommendation

今すぐ更新するのが良いです。戻す手順が決まっています。次の枠で更新する案が合うのは、利用者が多い時間帯の場合です。

## What only you know

- 今の時間帯に利用者が多いかどうか。

## Assumptions

- 反映に 1 分かかる。

## What I checked

- 前の設定のバックアップがあることを確認した[^1]。

[^1]: `settings.bak` が存在する。
