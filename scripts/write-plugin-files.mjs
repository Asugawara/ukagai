// Usage: node scripts/write-plugin-files.mjs <stage> <version>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginFiles } from "../dist/plugin/build.js";

const [stage, version] = process.argv.slice(2);
if (!stage || !version) {
  console.error("usage: node scripts/write-plugin-files.mjs <stage> <version>");
  process.exit(2);
}
for (const [path, content] of Object.entries(pluginFiles(version))) {
  const file = join(stage, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
