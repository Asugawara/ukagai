// スタブ: stdin を最後まで読み、何も出力せず exit 0(フェイルオープン)。
export async function run(_argv: string[]): Promise<number> {
  for await (const _chunk of process.stdin) {
    // 読み捨てる
  }
  return 0;
}
