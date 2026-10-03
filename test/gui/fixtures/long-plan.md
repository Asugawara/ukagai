# Plan: add retry to the export job

The export job fails on a flaky upstream. This plan adds bounded retries with backoff.

## Context

Context step 1: keep the change small and reviewable, and write down what was checked.
Context step 2: keep the change small and reviewable, and write down what was checked.
Context step 3: keep the change small and reviewable, and write down what was checked.
Context step 4: keep the change small and reviewable, and write down what was checked.
Context step 5: keep the change small and reviewable, and write down what was checked.
Context step 6: keep the change small and reviewable, and write down what was checked.
Context step 7: keep the change small and reviewable, and write down what was checked.
Context step 8: keep the change small and reviewable, and write down what was checked.
Context step 9: keep the change small and reviewable, and write down what was checked.
Context step 10: keep the change small and reviewable, and write down what was checked.
Context step 11: keep the change small and reviewable, and write down what was checked.

The failing path is in `src/export/usecase.ts` and the schedule lives in `config/export.yaml`.

## Changes

Three pieces change; each is described below.

### 1. Backend usecase — `src/export/usecase.ts`

Usecase step 1: keep the change small and reviewable, and write down what was checked.
Usecase step 2: keep the change small and reviewable, and write down what was checked.
Usecase step 3: keep the change small and reviewable, and write down what was checked.
Usecase step 4: keep the change small and reviewable, and write down what was checked.
Usecase step 5: keep the change small and reviewable, and write down what was checked.
Usecase step 6: keep the change small and reviewable, and write down what was checked.
Usecase step 7: keep the change small and reviewable, and write down what was checked.
Usecase step 8: keep the change small and reviewable, and write down what was checked.
Usecase step 9: keep the change small and reviewable, and write down what was checked.

```ts
const attempt0 = retry(job, { max: 1 });
const attempt1 = retry(job, { max: 2 });
const attempt2 = retry(job, { max: 3 });
const attempt3 = retry(job, { max: 4 });
const attempt4 = retry(job, { max: 5 });
const attempt5 = retry(job, { max: 6 });
const attempt6 = retry(job, { max: 7 });
const attempt7 = retry(job, { max: 8 });
const attempt8 = retry(job, { max: 9 });
const attempt9 = retry(job, { max: 10 });
```

### 2. HTTP handler — `src/export/handler.ts`

Handler step 1: keep the change small and reviewable, and write down what was checked.
Handler step 2: keep the change small and reviewable, and write down what was checked.
Handler step 3: keep the change small and reviewable, and write down what was checked.
Handler step 4: keep the change small and reviewable, and write down what was checked.
Handler step 5: keep the change small and reviewable, and write down what was checked.
Handler step 6: keep the change small and reviewable, and write down what was checked.
Handler step 7: keep the change small and reviewable, and write down what was checked.
Handler step 8: keep the change small and reviewable, and write down what was checked.
Handler step 9: keep the change small and reviewable, and write down what was checked.

The handler passes the request id to `src/export/retry.ts`.

### 3. Worker — `src/export/worker.ts`

Worker step 1: keep the change small and reviewable, and write down what was checked.
Worker step 2: keep the change small and reviewable, and write down what was checked.
Worker step 3: keep the change small and reviewable, and write down what was checked.
Worker step 4: keep the change small and reviewable, and write down what was checked.
Worker step 5: keep the change small and reviewable, and write down what was checked.
Worker step 6: keep the change small and reviewable, and write down what was checked.
Worker step 7: keep the change small and reviewable, and write down what was checked.
Worker step 8: keep the change small and reviewable, and write down what was checked.
Worker step 9: keep the change small and reviewable, and write down what was checked.

## Split and owners

Split step 1: keep the change small and reviewable, and write down what was checked.
Split step 2: keep the change small and reviewable, and write down what was checked.
Split step 3: keep the change small and reviewable, and write down what was checked.
Split step 4: keep the change small and reviewable, and write down what was checked.
Split step 5: keep the change small and reviewable, and write down what was checked.
Split step 6: keep the change small and reviewable, and write down what was checked.
Split step 7: keep the change small and reviewable, and write down what was checked.
Split step 8: keep the change small and reviewable, and write down what was checked.
Split step 9: keep the change small and reviewable, and write down what was checked.
Split step 10: keep the change small and reviewable, and write down what was checked.

### Owner table

| Area | Owner |
| --- | --- |
| backend | team a |
| worker | team b |

## Commit granularity

Commits step 1: keep the change small and reviewable, and write down what was checked.
Commits step 2: keep the change small and reviewable, and write down what was checked.
Commits step 3: keep the change small and reviewable, and write down what was checked.
Commits step 4: keep the change small and reviewable, and write down what was checked.
Commits step 5: keep the change small and reviewable, and write down what was checked.
Commits step 6: keep the change small and reviewable, and write down what was checked.
Commits step 7: keep the change small and reviewable, and write down what was checked.
Commits step 8: keep the change small and reviewable, and write down what was checked.
Commits step 9: keep the change small and reviewable, and write down what was checked.
Commits step 10: keep the change small and reviewable, and write down what was checked.
Commits step 11: keep the change small and reviewable, and write down what was checked.

One commit per file group: `test/export/retry.test.ts` and `docs/export.md` go last.

## Verification

Verify step 1: keep the change small and reviewable, and write down what was checked.
Verify step 2: keep the change small and reviewable, and write down what was checked.
Verify step 3: keep the change small and reviewable, and write down what was checked.
Verify step 4: keep the change small and reviewable, and write down what was checked.
Verify step 5: keep the change small and reviewable, and write down what was checked.
Verify step 6: keep the change small and reviewable, and write down what was checked.
Verify step 7: keep the change small and reviewable, and write down what was checked.
Verify step 8: keep the change small and reviewable, and write down what was checked.
Verify step 9: keep the change small and reviewable, and write down what was checked.
Verify step 10: keep the change small and reviewable, and write down what was checked.

### Unit tests

Unit step 1: keep the change small and reviewable, and write down what was checked.
Unit step 2: keep the change small and reviewable, and write down what was checked.
Unit step 3: keep the change small and reviewable, and write down what was checked.
Unit step 4: keep the change small and reviewable, and write down what was checked.
Unit step 5: keep the change small and reviewable, and write down what was checked.
Unit step 6: keep the change small and reviewable, and write down what was checked.
Unit step 7: keep the change small and reviewable, and write down what was checked.
Unit step 8: keep the change small and reviewable, and write down what was checked.
Unit step 9: keep the change small and reviewable, and write down what was checked.

### Manual run

```sh
npm test
./scripts/run-export --dry-run
```

Run `scripts/backfill.sh` against a staging copy.

## Observation path

Observe step 1: keep the change small and reviewable, and write down what was checked.
Observe step 2: keep the change small and reviewable, and write down what was checked.
Observe step 3: keep the change small and reviewable, and write down what was checked.
Observe step 4: keep the change small and reviewable, and write down what was checked.
Observe step 5: keep the change small and reviewable, and write down what was checked.
Observe step 6: keep the change small and reviewable, and write down what was checked.
Observe step 7: keep the change small and reviewable, and write down what was checked.
Observe step 8: keep the change small and reviewable, and write down what was checked.
Observe step 9: keep the change small and reviewable, and write down what was checked.
Observe step 10: keep the change small and reviewable, and write down what was checked.
Observe step 11: keep the change small and reviewable, and write down what was checked.

Logs go through `src/shared/clock.ts`.

## Rollout

Rollout step 1: keep the change small and reviewable, and write down what was checked.
Rollout step 2: keep the change small and reviewable, and write down what was checked.
Rollout step 3: keep the change small and reviewable, and write down what was checked.
Rollout step 4: keep the change small and reviewable, and write down what was checked.
Rollout step 5: keep the change small and reviewable, and write down what was checked.
Rollout step 6: keep the change small and reviewable, and write down what was checked.
Rollout step 7: keep the change small and reviewable, and write down what was checked.
Rollout step 8: keep the change small and reviewable, and write down what was checked.
Rollout step 9: keep the change small and reviewable, and write down what was checked.
Rollout step 10: keep the change small and reviewable, and write down what was checked.
Rollout step 11: keep the change small and reviewable, and write down what was checked.
Rollout step 12: keep the change small and reviewable, and write down what was checked.

The version in `package.json` is bumped last.

## Open questions

Question step 1: keep the change small and reviewable, and write down what was checked.
Question step 2: keep the change small and reviewable, and write down what was checked.
Question step 3: keep the change small and reviewable, and write down what was checked.
Question step 4: keep the change small and reviewable, and write down what was checked.
Question step 5: keep the change small and reviewable, and write down what was checked.
Question step 6: keep the change small and reviewable, and write down what was checked.
Question step 7: keep the change small and reviewable, and write down what was checked.
Question step 8: keep the change small and reviewable, and write down what was checked.
Question step 9: keep the change small and reviewable, and write down what was checked.
Question step 10: keep the change small and reviewable, and write down what was checked.
Question step 11: keep the change small and reviewable, and write down what was checked.

See `src/export/index.ts` and `README.md` for the entry points.

## Scope and reversibility

Reversibility: reversible
Scope: repo

Everything lives in one repository and reverts with git.
