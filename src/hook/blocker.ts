/**
 * Stop hook の保険(docs/spec/explain.md 12 節): 文章で「人の作業待ち」と言って止まったかを語彙で見る。
 * 「対象語」と「詰まり語」の両方が同じ文(「。」「.」改行区切り)に入っているときだけ一致にする
 */
export const BLOCKER_TARGET =
  /認証|ログイン|権限|credential|permission|unauthori[sz]ed|forbidden|\b40[13]\b|token|api key|鍵/i;
export const BLOCKER_STUCK =
  /ない|無い|切れ|失敗|必要|してください|お願い|できません|進められません|denied|failed|required|missing|expired|not logged in|cannot proceed|blocked/i;

export function isBlockerMessage(text: string | undefined): boolean {
  if (!text) return false;
  return text.split(/[。.\n]/).some((s) => BLOCKER_TARGET.test(s) && BLOCKER_STUCK.test(s));
}

/** Stop で続行させるときの理由文(600 文字以内、URL なし) */
export const BLOCKER_REASON =
  "人の作業(認証・権限など)が要るなら、文章で終えずに ukagai の blocker 形式で聞いてください: skill ukagai-explain の「人の作業で止まったとき」に従って説明ファイル(type: blocker、「なぜ止まったか」「人にしてほしいこと」「選択肢」)を書き、AskUserQuestion を選択肢「対応した。続けて (Recommended)」「この手順は飛ばして続けて」「ここで中断」で出してください。人の作業が要らないなら、そのまま終えて構いません。";
