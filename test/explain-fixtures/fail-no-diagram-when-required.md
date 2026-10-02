---
ukagai: 1
question: 検証用の hook ログは ~/.ukagai/log に置いてよいですか？
title: hook ログの置き場
reversibility: reversible
scope: machine
---

## なぜ今この判断が要るか

`hook --observe` が時刻を書き出す先が要ります。`~/.ukagai/` はリポジトリの外にあるので、この機械のファイルシステムを変更することになります。

## 選択肢の比較

| 選択肢 | 利点 | 欠点 | コスト |
|---|---|---|---|
| `~/.ukagai/log` | 他の状態と同じ場所にまとまる | リポジトリから見えない | 0 |
| `verification/log` | リポジトリ内で見える | 誤って commit しうる | `.gitignore` の追記 |
