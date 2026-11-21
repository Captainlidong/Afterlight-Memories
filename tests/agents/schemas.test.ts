import { describe, it, expect } from "vitest";
import {
  CreateExhibitionInput,
  CurationDecision,
  AiDecision,
  Motif,
  NarrativePlan,
  ExhibitionLayout,
  QaReport,
} from "@/lib/agents/schemas";
import curationJson from "@/lib/demo/data/curation.json";
import motifsJson from "@/lib/demo/data/motifs.json";
import narrativeJson from "@/lib/demo/data/narrative.json";
import { checkNarrativeCredibility } from "@/lib/agents/credibility";

describe("agent schemas", () => {
  it("CreateExhibitionInput 默认值可空输入", () => {
    const parsed = CreateExhibitionInput.parse({});
    expect(parsed.tone).toBe("restrained");
    expect(parsed.allow_exif).toBe(true);
    expect(parsed.allow_external_ai).toBe(false);
  });

  it("CurationDecision 合法", () => {
    const d = CurationDecision.parse({
      photo_id: "photo_p01",
      decision: "keep",
      score: 0.88,
      confidence: 0.83,
      reasons: ["人物背影与窗外蓝色形成呼应"],
      related_photo_ids: ["photo_p07"],
    });
    expect(d.decision).toBe("keep");
  });

  it("CurationDecision 拒绝空理由与 must_keep（AI 不可产出）", () => {
    expect(() =>
      CurationDecision.parse({
        photo_id: "p",
        decision: "keep",
        score: 0.5,
        confidence: 0.5,
        reasons: [],
      }),
    ).toThrow();
    expect(() =>
      CurationDecision.parse({
        photo_id: "p",
        decision: "must_keep",
        score: 0.5,
        confidence: 0.5,
        reasons: ["x"],
      }),
    ).toThrow();
  });

  it("Motif 需要证据照片", () => {
    const m = Motif.parse({
      title: "窗与背影",
      description: "人物常被窗框分隔。",
      photo_ids: ["photo_p01"],
      evidence: ["4 张照片出现框景"],
      confidence: 0.81,
    });
    expect(m.alternative_readings).toEqual([]);
    expect(() =>
      Motif.parse({
        title: "x",
        description: "x",
        photo_ids: [],
        evidence: ["x"],
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it("NarrativePlan 章节 2–4 且每章≥1 张，文案≤100 字", () => {
    const plan = NarrativePlan.parse({
      title: "在光线转弯之前",
      curatorial_statement: "人物很少占据画面中心。",
      chapters: [
        { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: ["photo_p01"] },
        { id: "chapter_02", title: "经过", description: "人物靠近。", photo_ids: ["photo_p02"] },
        { id: "chapter_03", title: "留下", description: "光线保留方向。", photo_ids: ["photo_p03"] },
      ],
      tone: "restrained",
    });
    expect(plan.chapters).toHaveLength(3);
    expect(() =>
      NarrativePlan.parse({ ...plan, curatorial_statement: "字".repeat(101) }),
    ).toThrow();
    expect(() => NarrativePlan.parse({ ...plan, chapters: [] })).toThrow();
  });

  it("ExhibitionLayout section 联合类型", () => {
    const layout = ExhibitionLayout.parse({
      template: "cinema_scroll",
      background: "#101114",
      text_color: "#F5F1E8",
      sections: [
        { id: "s01", type: "hero", photo_id: "photo_p01" },
        { id: "s02", type: "chapter_intro", chapter_id: "chapter_01" },
        { id: "s03", type: "image_pair", photo_ids: ["photo_p02", "photo_p03"] },
      ],
    });
    expect(layout.sections).toHaveLength(3);
    expect(() =>
      ExhibitionLayout.parse({ ...layout, template: "unknown" }),
    ).toThrow();
  });

  it("QaReport 合法", () => {
    const r = QaReport.parse({
      status: "needs_review",
      issues: [
        {
          id: "i1",
          severity: "medium",
          type: "repetition",
          message: "连续相似照片过多。",
          photo_ids: ["photo_p08"],
          auto_fix_available: true,
        },
      ],
      passed_checks: ["no_duplicate_photo"],
    });
    expect(r.issues[0].type).toBe("repetition");
  });
});

describe("demo curation.json 预设（§14.2 / §18 旁白 24→17）", () => {
  const entries = curationJson as {
    index: number;
    decision: string;
    score: number;
    confidence: number;
    reasons: string[];
    related_indices: number[];
  }[];

  it("24 条、序号 1..24 唯一、决定合法、理由非空、分数在 0..1", () => {
    expect(entries.length).toBe(24);
    expect(new Set(entries.map((e) => e.index)).size).toBe(24);
    for (const e of entries) {
      expect(AiDecision.safeParse(e.decision).success).toBe(true);
      expect(e.reasons.length).toBeGreaterThanOrEqual(1);
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(1);
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("总数恰为 17 keep / 4 hold / 3 remove", () => {
    const count = (d: string) => entries.filter((e) => e.decision === d).length;
    expect(count("keep")).toBe(17);
    expect(count("hold")).toBe(4);
    expect(count("remove")).toBe(3);
  });
});

describe("demo motifs.json 预设（§14 / 提示词4：3 主题）", () => {
  const presets = motifsJson as {
    title: string;
    description: string;
    photo_indices: number[];
    evidence: string[];
    confidence: number;
    alternative_readings: string[];
  }[];

  it("恰 3 个主题，映射后符合 Motif / MotifResult schema", () => {
    expect(presets.length).toBe(3);
    const mapped = presets.map((p, i) => ({
      id: `motif_0${i + 1}`,
      title: p.title,
      description: p.description,
      photo_ids: p.photo_indices.map((n) => `photo_p${String(n).padStart(2, "0")}`),
      evidence: p.evidence,
      confidence: p.confidence,
      alternative_readings: p.alternative_readings,
    }));
    for (const m of mapped) {
      expect(Motif.safeParse(m).success).toBe(true);
      expect(m.evidence.length).toBeGreaterThanOrEqual(1);
      expect(m.photo_ids.length).toBeGreaterThanOrEqual(1);
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("三个主题名为 窗与背影 / 蓝色光线 / 人物与空间距离", () => {
    const titles = presets.map((p) => p.title).join("|");
    expect(titles).toContain("窗与背影");
    expect(titles).toContain("蓝色光线");
    expect(titles).toContain("人物与空间之间的距离");
  });

  it("主题照片全在 keep 集内（只用保留照片）", () => {
    const keep = new Set(
      (curationJson as { index: number; decision: string }[])
        .filter((e) => e.decision === "keep")
        .map((e) => e.index),
    );
    for (const p of presets) {
      for (const idx of p.photo_indices) expect(keep.has(idx)).toBe(true);
    }
  });
});

describe("demo narrative.json 预设（§14 / 提示词5：三章 + 4 语气）", () => {
  const preset = narrativeJson as {
    title: string;
    subtitle: string;
    chapters: { id: string; title: string; photo_indices: number[]; opening_index: number; closing_index: number; turning_index?: number }[];
    tones: Record<string, { curatorial_statement: string; descriptions: string[]; placement_reasons: { chapter: string; index: number; role: string; reason: string }[] }>;
  };
  const pid = (n: number) => `photo_p${String(n).padStart(2, "0")}`;
  const keepIndices = (curationJson as { index: number; decision: string }[]).filter((e) => e.decision === "keep").map((e) => e.index);
  const tones = ["documentary", "restrained", "poetic", "direct"];

  function planFor(tone: string) {
    const t = preset.tones[tone];
    return {
      title: preset.title,
      subtitle: preset.subtitle,
      curatorial_statement: t.curatorial_statement,
      tone,
      chapters: preset.chapters.map((c, i) => ({
        id: c.id,
        title: c.title,
        description: t.descriptions[i],
        photo_ids: c.photo_indices.map(pid),
        opening_photo_id: pid(c.opening_index),
        closing_photo_id: pid(c.closing_index),
        placement_reasons: t.placement_reasons.filter((r) => r.chapter === c.id).map((r) => ({ photo_id: pid(r.index), role: r.role, reason: r.reason })),
      })),
    };
  }

  it("恰 4 语气，每语气映射后符合 NarrativePlan schema", () => {
    expect(Object.keys(preset.tones).sort()).toEqual([...tones].sort());
    for (const tone of tones) expect(NarrativePlan.safeParse(planFor(tone)).success).toBe(true);
  });

  it("三章照片恰好覆盖 17 张 keep，无重复、无遗漏", () => {
    const all = preset.chapters.flatMap((c) => c.photo_indices);
    expect(all.length).toBe(17);
    expect(new Set(all).size).toBe(17);
    expect([...all].sort((a, b) => a - b)).toEqual([...keepIndices].sort((a, b) => a - b));
  });

  it("每语气叙事均通过可信边界校验", () => {
    const keepIds = keepIndices.map(pid);
    const motifPhotoIds = [4, 7, 9, 12, 24].map(pid);
    for (const tone of tones) {
      const plan = NarrativePlan.parse(planFor(tone));
      const report = checkNarrativeCredibility(plan, { keepIds, motifPhotoIds });
      expect(report.violations).toEqual([]);
    }
  });
});