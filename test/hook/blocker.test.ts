import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKER_REASON, isBlockerMessage } from "../../src/hook/blocker.js";

test("ブロッカー語彙: 当たり", () => {
  for (const m of [
    "gcloud の認証がないため進められません。",
    "権限がありません",
    "Permission denied (403)",
    "You are not logged in",
    "Authentication required",
    "401 Unauthorized",
    "デプロイできませんでした。ログインしてください",
    "cannot proceed without a key",
  ]) {
    assert.equal(isBlockerMessage(m), true, m);
  }
});

test("ブロッカー語彙: 外れ", () => {
  for (const m of ["実装が終わりました", "どちらにしますか？", "テストは 14031 件通りました", "", undefined]) {
    assert.equal(isBlockerMessage(m), false, String(m));
  }
});

test("理由文は 600 文字以内で URL を含まない", () => {
  assert.ok(BLOCKER_REASON.length <= 600);
  assert.ok(!/https?:|localhost|127\.0\.0\.1/.test(BLOCKER_REASON));
});
