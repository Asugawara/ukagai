---
ukagai: 1
question: 判断を保存するファイルの名前は decisions.jsonl と log.jsonl のどちらにしますか？
title: 判断ログのファイル名を decisions.jsonl と log.jsonl のどちらにするか
reversibility: reversible
scope: file
recommended: decisions.jsonl
---

## なぜ今この判断が要るか

`~/.ukagai/` に作るファイルの名前を、store の実装前に決めます。名前は `src/server/store.ts` の定数 1 か所にしか出てこないので、あとで替えるのも簡単です。好みの問題で、人が決める余地があります。

## 選択肢

| 選択肢 | 利点 | 欠点 | コスト |
|---|---|---|---|
| decisions.jsonl | 中身が名前から分かる | 少し長い | 0 |
| log.jsonl | 短い | events と区別がつきにくい | 0 |

## 推奨

`decisions.jsonl` を推します。名前から中身が分かり、`events.jsonl` と区別できるためです。短さを優先するなら `log.jsonl` が正しくなります。
