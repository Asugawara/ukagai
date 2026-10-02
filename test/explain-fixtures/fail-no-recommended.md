---
ukagai: 1
question: 判断を保存するファイルの名前は decisions.jsonl と log.jsonl のどちらにしますか？
title: 判断ログのファイル名を decisions.jsonl と log.jsonl のどちらにするか
reversibility: reversible
scope: file
---

## なぜ今この判断が要るか

`~/.ukagai/` に作るファイルの名前を、store の実装前に決めます。名前は `src/server/store.ts` の定数 1 か所にしか出てこないので、あとで替えるのも簡単です。好みの問題で、人が決める余地があります。

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| decisions.jsonl (Recommended) | 中身(判断)が名前から分かり、`events.jsonl` と並べて読める。 | 少し長いだけ。定数 1 か所の変更で戻せる。 |
| log.jsonl | 名前が短くなる。 | events との区別がつきにくい。定数 1 か所の変更で戻せる。 |

## 推奨

`decisions.jsonl` を推します。名前から中身が分かり、`events.jsonl` と区別できるためです。短さを優先するなら `log.jsonl` が正しくなります。
