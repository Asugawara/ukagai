---
ukagai: 1
question: 判断を保存するファイルの名前は decisions.jsonl と log.jsonl のどちらにしますか？
title: 判断ログのファイル名
reversibility: reversible
scope: file
---

## なぜ今この判断が要るか

`~/.ukagai/` に作るファイルの名前を、store の実装前に決めます。名前は `src/server/store.ts` の定数 1 か所にしか出てこないので、あとで替えるのも簡単です。

## 選択肢の比較

| 選択肢 | 利点 | 欠点 | コスト |
|---|---|---|---|
| decisions.jsonl | 中身(判断)が名前から分かる、`events.jsonl` と並べて読める | 少し長い | 0 |
| log.jsonl | 短い | events との区別がつかない | 0 |
