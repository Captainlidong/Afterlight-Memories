import { describe, expect, it } from "vitest";
import { AiVisualFacts } from "@/lib/ai/schemas";
import { assertAiDataOnly } from "@/lib/ai/outputValidation";
import { assertDataOnly } from "@/lib/adapters/aiTextAdapter";
import { AiBusinessValidationError, AiInvalidResponseError } from "@/lib/ai/errors";

const facts = () => ({ summary: "窗边的背影", subjects: ["人物"], composition_tags: ["框景"], light_tags: [], spatial_relations: [],
  evidence: [{ kind: "observation", text: "人物背对镜头" }], uncertainties: ["无法判断人物与拍摄者是否是情侣"] });

describe("AI output boundaries", () => {
  it("strict视觉结构拒绝额外技术指标和嵌套工具字段", () => {
    expect(AiVisualFacts.safeParse({ ...facts(), sharpness_score: 1 }).success).toBe(false);
    const nested = facts(); Object.assign(nested.evidence[0], { tool_calls: [] });
    expect(AiVisualFacts.safeParse(nested).success).toBe(false);
  });

  it.each(["summary", "subject", "tag", "evidence", "uncertainty"])("拒绝视觉空白字段 %s", (kind) => {
    const value = facts();
    if (kind === "summary") value.summary = "  \n";
    if (kind === "subject") value.subjects = [" \t"];
    if (kind === "tag") value.composition_tags = ["  " ];
    if (kind === "evidence") value.evidence[0].text = "  ";
    if (kind === "uncertainty") value.uncertainties = ["  " ];
    expect(AiVisualFacts.safeParse(value).success).toBe(false);
  });

  it("视觉不确定项可以如实说明无法判断关系，不套用过宽的叙事词表", () => {
    expect(AiVisualFacts.parse(facts())).toEqual(facts());
    expect(() => assertAiDataOnly(facts())).not.toThrow();
    expect(() => assertDataOnly({ statement: "他们是情侣" })).toThrow(AiBusinessValidationError);
  });

  it.each(["<script>alert(1)</script>", "<img src=x>", "javascript:alert(1)", "window.location='x'", "body { color:red; }"])("嵌套输出不接受可执行/样式内容 %s", (text) => {
    expect(() => assertAiDataOnly({ evidence: [{ text }] })).toThrow(AiInvalidResponseError);
  });

  it("普通可观察文字及未知可选列表可为空，具体字符串会修剪空格", () => {
    const value = { ...facts(), summary: "  窗边的背影  ", uncertainties: [] };
    expect(AiVisualFacts.parse(value).summary).toBe("窗边的背影");
    expect(() => assertAiDataOnly(value)).not.toThrow();
  });
});
