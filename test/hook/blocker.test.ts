import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKER_REASON, isBlockerMessage } from "../../src/hook/blocker.js";

test("blocker vocabulary: hits (a target word and a stuck word in the same sentence; Japanese and English)", () => {
  for (const m of [
    "gcloud の認証がないため進められません。",
    "Permission denied (403)",
    "トークンが期限切れです。再ログインしてください",
    "デプロイできませんでした。ログインしてください",
    "401 Unauthorized: token expired",
    "Credentials required",
    "cannot proceed without an API key",
    "実装は終わりました。\n権限がなく進められません",
    "SSH の鍵が無い",
    "権限がありません",
    "auth が切れていて進められません", // bare auth
    "Auth failed",
    "トークンが無く進めません",
    "ログインしなければ続けられません",
    "gcloud auth login をしてください",
    "APIキーが必要です",
    "api_key が無い",
    "I could not log in: the token has expired",
    "Sign-in is required before I can continue",
    "Missing credentials, so I am blocked",
  ]) {
    assert.equal(isBlockerMessage(m), true, m);
  }
});

test("blocker vocabulary: misses (success sentences, only one kind of word, words across sentences)", () => {
  for (const m of [
    "実装が終わりました",
    "どちらにしますか？",
    "テストは 14031 件通りました",
    "認証は有効です",
    "権限の実装を終えました",
    "ログイン画面を作りました",
    "token を発行する関数を追加しました",
    "403 を返すテストを足しました",
    "permission のチェックは通りました",
    "認証は問題ありません", // double negative
    "権限は足りているので問題なく進めました",
    "トークンの更新はエラーなく終わりました",
    "認証の設定です。手順が必要です", // target and stuck words in different sentences
    "Everything is ready.\nThe token is valid",
    "権限エラーになったわけではありません",
    "権限は必要ありません",
    "認証は不要です",
    "Login works and all tests passed",
    "I added a permission check and it passes",
    "The author is credited", // auth as a whole word
    "",
    undefined,
  ]) {
    assert.equal(isBlockerMessage(m), false, String(m));
  }
});

test("the reason is at most 600 characters, English, and has no URL", () => {
  assert.ok(BLOCKER_REASON.length <= 600);
  assert.doesNotMatch(BLOCKER_REASON, /[ぁ-んァ-ン一-龥]/);
  assert.ok(BLOCKER_REASON.includes("ukagai-explain"));
  assert.ok(!/https?:|localhost|127\.0\.0\.1/.test(BLOCKER_REASON));
});
