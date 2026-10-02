---
ukagai: 1
question: 検証用の hook ログは ~/.ukagai/log に置いてよいですか？
title: 検証用の hook ログを ~/.ukagai/log に置くか、リポジトリ内に置くか
reversibility: reversible
scope: machine
recommended: ~/.ukagai/log
---

## なぜ今この判断が要るか

`hook --observe` が時刻を書き出す先が要ります。`~/.ukagai/` はリポジトリの外にあるので、この機械のファイルシステムを変更することになります。リポジトリ外に書いてよいかは人が決めることです。

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| `~/.ukagai/log` | 他の状態と同じ場所にまとまる。 | リポジトリから見えない。ディレクトリを消せば戻せる。 |
| `verification/log` | リポジトリ内で見える。 | 誤って commit しうる。`.gitignore` の追記が要る。 |

## 推奨

`~/.ukagai/log` を推します。他の状態と同じ場所にまとまり、誤 commit の心配がありません。ログを PR に添えたいなら `verification/log` が正しくなります。
