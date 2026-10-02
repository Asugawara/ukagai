---
ukagai: 1
question: gcloud の認証が切れています。対応できましたか？
type: blocker
title: gcloud の認証が切れているので `gcloud auth login` をしてほしい
recommended: 対応した。続けて
reversibility: reversible
scope: machine
---

## なぜ止まったか

`gcloud run deploy` が認証エラーで失敗しました。

```
ERROR: (gcloud.run.deploy) You do not currently have an active account selected.
```

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| 対応した。続けて | 同じデプロイを再試行して続ける。 | 認証が通っていなければ、また止まる。 |
| この手順は飛ばして続けて | デプロイを飛ばして進める。 | あとで手動でデプロイすれば戻せる。 |
| ここで中断 | 作業をここで止める。 | 再開すれば続けられる。 |
