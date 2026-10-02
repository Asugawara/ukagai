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

`gcloud run deploy` が認証エラーで失敗しました。ブラウザでのログインが要り、私にはできません。

```
ERROR: (gcloud.run.deploy) You do not currently have an active account selected.
Please run: $ gcloud auth login
```

## 人にしてほしいこと

1. ターミナルで次を実行し、ブラウザでログインする。
2. アプリケーションのデフォルト認証も更新する。

```sh
gcloud auth login
gcloud auth application-default login
```

## 選択肢

| 選択肢 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| 対応した。続けて | 同じデプロイを再試行して続ける。 | 認証が通っていなければ、また同じ表示で止まる。 |
| この手順は飛ばして続けて | デプロイを飛ばして残りの作業を進める。 | デプロイされないまま進む。あとで手動でデプロイすれば戻せる。 |
| ここで中断 | 作業をここで止める。 | 途中までの変更は残る。再開すれば続けられる。 |
