# プラン: orders に currency 列を足す

決済は注文のたびに自由記述の `price_unit` を解析しています。型つきの `currency` 列を足し、止めずに読み取りをそちらへ移します。

## 背景

- 決済はリクエストのたびに `src/orders/checkout.ts:57` で単位を解析している。
- `orders` は 4,000 万行あり、注文のたびに書き込みがある。

## 手順

1. **列を足す** [todo]
   ```diff
   @@ -12,5 +12,6 @@ CREATE TABLE orders (
      total_cents  bigint NOT NULL,
      price_unit   text   NOT NULL,
   +  currency     char(3),
      created_at   timestamptz NOT NULL
   ```
2. **`currency` を埋め戻す** [todo]
   - {{backfill}}
3. **決済で列を読む** [todo]
   ```ts title="src/orders/checkout.ts"
   const currency: Currency = order.currency ?? parseUnit(order.price_unit);
   ```
4. **次のリリースで `price_unit` を消す** [todo]

## リスク

> [!WARNING] 埋め戻しの間は書き手が 2 つ
> 手順 3 を出すまで、新しい注文は `price_unit` に書き続けます。埋め戻しは止める前に最後のバッチを読み直します。

- 埋め戻しの約 40 分間、プライマリの負荷が上がる。
- `price_unit` を読むレポートは手順 4 まで動き続ける。

## 検討した別案

- メンテナンス時間を取って 1 回で移行: 単純だが決済が止まる。
- `price_unit` を解析するビュー: 書き込みは無いが、読むたびに解析が残る。

## 確かめ方

- [ ] `npm test` が通る（決済の currency のテストを含む）
- [ ] 本番のコピーで埋め戻した後、`currency` が NULL の行が無い
- [ ] ステージングで手順 3 の前後の決済の合計が同じ

## 戻し方

手順 3 を戻す。列は次のリリースで消すまで使われないまま残る。
