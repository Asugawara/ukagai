/**
 * Stop hook safeguard (docs/spec/explain.md section 12): detect by vocabulary whether the agent stopped in prose saying it is waiting for human work.
 * Matches only when a target word and a stuck word are in the same sentence (split on 。 . and newlines).
 * The vocabulary is intentionally bilingual (English and Japanese).
 */
export const BLOCKER_TARGET =
  /認証|ログイン|権限|credential|permission|unauthori[sz]ed|forbidden|\b40[13]\b|token|トークン|api key|鍵|login|sign[ -]?in|api[ _-]?key|APIキー|API キー|\bauth\b/i;
export const BLOCKER_STUCK =
  /ない|無い|なく|なければ|無く|無ければ|ありません|切れ|失敗|必要|してください|お願い|できません|進められません|進めません|denied|failed|required|missing|expired|not logged in|cannot proceed|blocked/i;

/** Double negatives such as 「問題ありません」/ 「問題なく」 are not blockers, so they are removed from the sentence before matching */
export const BLOCKER_SAFE = /問題(は|も)?(ありません|なく|ない|無く|無い|なし|無し)|支障(は|も)?(ありません|なく|ない|無く|無い)|エラー(は|も)?(ありません|なく|ない|無く|無い|なし|無し)|わけではありません|わけではない|必要(は|も)?(ありません|ない|無い|なく)|問題(は|も)?なかった|要りません|不要/g;

export function isBlockerMessage(text: string | undefined): boolean {
  if (!text) return false;
  return text
    .split(/[。.\n]/)
    .map((s) => s.replace(BLOCKER_SAFE, ""))
    .some((s) => BLOCKER_TARGET.test(s) && BLOCKER_STUCK.test(s));
}

/** Reason given when Stop is made to continue (at most 600 characters, no URL) */
export const BLOCKER_REASON =
  'If human work (authentication, permissions, etc.) is needed, do not just end with prose; ask in ukagai\'s blocker format: following "When stopped by human work" in skill ukagai-explain, write an explanation file (type: blocker, with "Why I stopped", "What you need to do" and "Options") and call AskUserQuestion with the options "Done. Continue (Recommended)", "Skip this step and continue" and "Stop here". If no human work is needed, you may simply end.';
