import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

function read(): string {
  try {
    // ../package.json from both src/ (tsx) and dist/
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** This build's version (package.json), read lazily and never throwing */
export function getVersion(): string {
  return (cached ??= read());
}

export const VERSION: string = getVersion();
