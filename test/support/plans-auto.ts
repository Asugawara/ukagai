import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Seed `<dataDir>/config.json` with `plans.auto_show: true` (the server's default is off): for tests whose plan files must pop up by themselves */
export function optInPlanAutoShow(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ plans: { auto_show: true } }));
}
