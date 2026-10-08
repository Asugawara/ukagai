import { parseFrontMatter, toLines } from "../hook/explain.js";
export function parseFrontMatterFields(markdown) {
    return parseFrontMatter(toLines(markdown)).fields;
}
//# sourceMappingURL=util.js.map