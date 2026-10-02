import { stat } from "node:fs/promises";
import { join } from "node:path";
import { HOOK_EVENTS } from "../settings/hooks-spec.js";
import { findManaged, readSettings } from "../settings/merge.js";
import { parseTarget } from "../settings/target.js";

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv);
  } catch (err) {
    process.stderr.write(`ukagai doctor: ${(err as Error).message}\n`);
    return 2;
  }
  const rows: [boolean, string, string][] = [];
  const add = (ok: boolean, name: string, note = ""): void => void rows.push([ok, name, note]);

  let settings: Record<string, unknown> = {};
  try {
    settings = await readSettings(t.settingsFile);
  } catch (err) {
    add(false, `settings ${t.settingsFile}`, (err as Error).message);
  }
  let node: string | undefined;
  let cli: string | undefined;
  for (const ev of HOOK_EVENTS) {
    const h = findManaged(settings, ev);
    add(h !== undefined, `hook ${ev}`, h ? "" : "未登録");
    if (h && node === undefined) {
      node = typeof h["command"] === "string" ? h["command"] : undefined;
      const args = h["args"];
      cli = Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined;
    }
  }
  if (node !== undefined) add(await exists(node), "node の実在", node);
  if (cli !== undefined) add(await exists(cli), "cli の実在", cli);

  try {
    const res = await fetch(`${t.server}/healthz`, { signal: AbortSignal.timeout(2000) });
    add(res.status === 200, `server ${t.server}/healthz`, `HTTP ${res.status}`);
  } catch (err) {
    add(false, `server ${t.server}/healthz`, `接続できません(${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message})`);
  }
  add(await exists(join(t.dataDir, "token")), "token", join(t.dataDir, "token"));
  add(await exists(join(t.skillDir, "SKILL.md")), "skill ukagai-explain", join(t.skillDir, "SKILL.md"));

  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [ok, name, note] of rows) {
    process.stdout.write(`${ok ? "○" : "×"}  ${name.padEnd(w)}  ${note}\n`.replace(/\s+\n$/, "\n"));
  }
  const bad = rows.filter((r) => !r[0]).length;
  process.stdout.write(bad === 0 ? "問題なし\n" : `${bad} 件の問題があります\n`);
  return bad === 0 ? 0 : 1;
}
