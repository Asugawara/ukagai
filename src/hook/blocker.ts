/** Stop hook の保険(docs/spec/explain.md 12 節): 文章で「人の作業待ち」と言って止まったかを語彙で見る */
export const BLOCKER_VOCABULARY =
  /認証|ログイン|権限|credential|permission|unauthori[sz]ed|forbidden|\b40[13]\b|not logged in|login required|auth(entication)? (required|failed)|進められません|進めません|できませんでした.*(してください|お願いします)|cannot proceed|blocked by/i;

export function isBlockerMessage(text: string | undefined): boolean {
  return !!text && BLOCKER_VOCABULARY.test(text);
}

/** Stop で続行させるときの理由文(600 文字以内、URL なし) */
export const BLOCKER_REASON =
  "人の作業(認証・権限など)が要るなら、文章で終えずに ukagai の blocker 形式で聞いてください: skill ukagai-explain の「人の作業で止まったとき」に従って説明ファイル(type: blocker、「なぜ止まったか」「人にしてほしいこと」「選択肢」)を書き、AskUserQuestion を選択肢「対応した。続けて (Recommended)」「この手順は飛ばして続けて」「ここで中断」で出してください。人の作業が要らないなら、そのまま終えて構いません。";
