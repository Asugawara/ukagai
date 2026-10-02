import { parseFrontMatter, toLines } from "../hook/explain.js";

export function parseFrontMatterFields(markdown: string): Record<string, string> {
  return parseFrontMatter(toLines(markdown)).fields;
}
