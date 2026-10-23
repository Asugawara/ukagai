# Plan: add a currency column to orders

Checkout parses the free-text `price_unit` on every order. This plan adds a typed `currency` column and moves reads to it without downtime.

## Context

- Checkout parses the unit at `src/orders/checkout.ts:57` on every request.
- `orders` has 40M rows and takes a write on every order.

## Steps

1. **Add the column** [todo]
   ```diff
   @@ -12,5 +12,6 @@ CREATE TABLE orders (
      total_cents  bigint NOT NULL,
      price_unit   text   NOT NULL,
   +  currency     char(3),
      created_at   timestamptz NOT NULL
   ```
2. **Backfill `currency`** [todo]
   - {{backfill}}
3. **Read the column at checkout** [todo]
   ```ts title="src/orders/checkout.ts"
   const currency: Currency = order.currency ?? parseUnit(order.price_unit);
   ```
4. **Drop `price_unit` in the next release** [todo]

## Risks

> [!WARNING] Two writers during the backfill
> New orders keep writing `price_unit` until step 3 ships; the backfill re-reads the last batch before it stops.

- The backfill adds load on the primary for about 40 minutes.
- Reports that read `price_unit` keep working until step 4.

## Alternatives considered

- One migration with a maintenance window: simpler, but checkout is down.
- A view that parses `price_unit`: no write, but the parse stays on every read.

## Verification

- [ ] `npm test` passes, including the checkout currency tests
- [ ] the backfill on a copy of production leaves no NULL `currency`
- [ ] checkout on staging shows the same totals before and after step 3

## Rollback

Revert step 3; the column stays unused until the next release drops it.
