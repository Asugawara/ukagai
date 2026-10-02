import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKER_REASON, isBlockerMessage } from "../../src/hook/blocker.js";

test("ブロッカー語彙: 当たり(対象語と詰まり語が同じ文にある)", () => {
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
    "トークンが無く進めません",
    "ログインしなければ続けられません",
  ]) {
    assert.equal(isBlockerMessage(m), true, m);
  }
});

test("ブロッカー語彙: 外れ(成功文・片方だけ・文をまたぐ)", () => {
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
    "認証は問題ありません", // 否定の否定
    "権限は足りているので問題なく進めました",
    "トークンの更新はエラーなく終わりました",
    "認証の設定です。手順が必要です", // 対象語と詰まり語が別の文
    "Everything is ready.\nThe token is valid",
    "",
    undefined,
  ]) {
    assert.equal(isBlockerMessage(m), false, String(m));
  }
});

test("理由文は 600 文字以内で URL を含まない", () => {
  assert.ok(BLOCKER_REASON.length <= 600);
  assert.ok(!/https?:|localhost|127\.0\.0\.1/.test(BLOCKER_REASON));
});
