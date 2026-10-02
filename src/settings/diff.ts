/** Line-based unified diff (no dependencies; LCS) */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string, ctx = 3): string {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) ops.push({ t: " ", s: x[i++]! }), j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: "-", s: x[i++]! });
    else ops.push({ t: "+", s: y[j++]! });
  }
  while (i < n) ops.push({ t: "-", s: x[i++]! });
  while (j < m) ops.push({ t: "+", s: y[j++]! });

  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  if (changed.length === 0) return "";
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - ctx);
    let end = Math.min(ops.length, changed[k]! + ctx + 1);
    while (k + 1 < changed.length && changed[k + 1]! - ctx <= end) {
      k++;
      end = Math.min(ops.length, changed[k]! + ctx + 1);
    }
    k++;
    const hunk = ops.slice(start, end);
    const aStart = ops.slice(0, start).filter((o) => o.t !== "+").length;
    const bStart = ops.slice(0, start).filter((o) => o.t !== "-").length;
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aStart + (aLen ? 1 : 0)},${aLen} +${bStart + (bLen ? 1 : 0)},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    start = end;
  }
  return out.join("\n") + "\n";
}
