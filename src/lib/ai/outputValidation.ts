import { AiInvalidResponseError } from "./errors";

/** Only model-produced data is checked here. User edits never pass this guard. */
export function assertAiDataOnly(value: unknown): void {
  if (typeof value === "string") {
    if (/<\/?[a-z][^>]*>|javascript\s*:|```|\b(?:function|eval)\s*\(|\b(?:document|window)\s*\.|(?:^|[\s;}])[.#]?[a-z][\w.#\s:-]*\{[^}]*:[^}]*\}/i.test(value)) {
      throw new AiInvalidResponseError("模型只能返回纯文本策展数据，不能包含 HTML、脚本或样式。");
    }
  }
  if (Array.isArray(value)) value.forEach(assertAiDataOnly);
  else if (value && typeof value === "object") Object.values(value).forEach(assertAiDataOnly);
}
