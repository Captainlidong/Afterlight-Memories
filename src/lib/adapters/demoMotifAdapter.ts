import { indexBySha, demoMotifs } from "../demo/manifest";
import type { AestheticPrefsT, MotifT, MotifResultT } from "../agents/schemas";
import type { AdapterResult, MotifAdapter, MotifInput, MotifPhotoInput } from "./types";

/**
 * Demo 主题发现适配器（设计文档 §6.4 / §9.3 / §12.5 / 提示词4）。
 * - 输入以保留照片为主且 sha256 大多命中 manifest → 套用 motifs.json 预设（3 候选）；
 * - 否则（用户自有照片）→ 确定性启发式：按构图标签/色温聚类，证据串由真实计数生成。
 * 只从可观察事实推主题，绝不编造个人经历/关系；每个候选都给出替代理解，防止过度解读。
 */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function tagsOf(p: MotifPhotoInput): string[] {
  return [...p.composition_tags, ...p.subjects];
}
const hasAny = (p: MotifPhotoInput, list: string[]) => list.some((t) => tagsOf(p).includes(t));

interface ClusterSpec {
  title: string;
  description: string;
  focus: "people" | "architecture" | "light" | "color" | "space";
  match: (p: MotifPhotoInput) => boolean;
  evidence: (members: MotifPhotoInput[]) => string[];
  alternative_readings: string[];
}

const CLUSTERS: ClusterSpec[] = [
  {
    title: "反复出现的框景与窗",
    description: "窗框、门洞与建筑边缘反复把画面分成内外两层，空间似乎先于主体被看见。",
    focus: "architecture",
    match: (p) => hasAny(p, ["框景", "窗", "窗格", "门洞", "拱门"]),
    evidence: (m) => [`${m.length} 张保留照片出现框景、窗或门洞结构`],
    alternative_readings: ["也可以被理解为对「边界」的兴趣", "或只是拍摄时习惯借助前景遮挡"],
  },
  {
    title: "反复出现的背影",
    description: "人物多以背影出现，面部不可见；观看者被放在与人物相同的方向上。",
    focus: "people",
    match: (p) => hasAny(p, ["背影", "人物背影"]),
    evidence: (m) => [`${m.length} 张保留照片以人物背影为主体`, "背影照片均非正面朝向镜头"],
    alternative_readings: ["也可以被读作一种匿名化的自我投射", "或只是抓拍时人物恰好背对镜头"],
  },
  {
    title: "反复出现的冷色光线",
    description: "冷色温的光贯穿多张照片，构成一条安静的光线线索。",
    focus: "color",
    match: (p) => hasAny(p, ["冷调", "蓝调时刻", "低光"]) || (p.color_temp != null && p.color_temp < -0.2),
    evidence: (m) => [`${m.length} 张保留照片整体偏冷色温`],
    alternative_readings: ["也可以被理解为拍摄环境本身的色温", "而非刻意的情绪表达"],
  },
  {
    title: "人物与空间之间的距离",
    description: "大留白与纵深让主体显得很小；画面先呈现空间，主体只是其中经过的一个点。",
    focus: "space",
    match: (p) => hasAny(p, ["留白", "大留白", "纵深", "小主体", "一点透视"]),
    evidence: (m) => [`${m.length} 张保留照片使用留白、大留白或纵深构图`],
    alternative_readings: ["也可以被读作疏离，但这只是一种可能的理解", "更稳妥的读法是空间比主体更先被看见"],
  },
];

function buildCluster(spec: ClusterSpec, photos: MotifPhotoInput[], prefs: AestheticPrefsT): MotifT | null {
  const members = photos.filter(spec.match);
  if (members.length < 2) return null;
  const ratio = members.length / photos.length;
  const focusBoost = prefs.focus.includes(spec.focus) ? 0.05 : 0;
  return {
    title: spec.title,
    description: spec.description,
    photo_ids: members.map((p) => p.photoId),
    evidence: spec.evidence(members),
    confidence: clamp01(0.4 + 0.5 * ratio + focusBoost),
    alternative_readings: spec.alternative_readings,
  };
}

function fallbackMotifs(photos: MotifPhotoInput[]): MotifT[] {
  const ids = photos.map((p) => p.photoId);
  const n = photos.length;
  return [
    {
      title: "整组的明暗节奏",
      description: "在没有明显重复线索时，先把整组作为一条观看线索呈现，供你判断是否成立。",
      photo_ids: ids,
      evidence: [`${n} 张保留照片共同构成当前整组`],
      confidence: 0.4,
      alternative_readings: ["这只是一个起点，未必是真正的主题", "你可以改名或拒绝，重新发现"],
    },
    {
      title: "重复与变奏",
      description: "同一组照片可被看作若干变奏；是否存在重复主题，交由你确认。",
      photo_ids: ids,
      evidence: [`${n} 张保留照片可被并列比较`],
      confidence: 0.4,
      alternative_readings: ["也可能彼此并无关联", "或只是同一场景的不同瞬间"],
    },
  ];
}

/** 确定性启发式主题发现（纯函数，可独立测试）。聚类不足 2 个时用整组兜底，保证不死路。 */
export function heuristicMotifs(photos: MotifPhotoInput[], prefs: AestheticPrefsT): MotifT[] {
  const clusters = CLUSTERS.map((spec) => buildCluster(spec, photos, prefs)).filter(
    (m): m is MotifT => m !== null,
  );
  clusters.sort((a, b) => b.confidence - a.confidence);
  const motifs = clusters.slice(0, 4);
  if (motifs.length < 2) {
    for (const f of fallbackMotifs(photos)) {
      if (motifs.length >= 2) break;
      motifs.push(f);
    }
  }
  return motifs.slice(0, 4);
}

export const demoMotifAdapter: MotifAdapter = {
  async discover(input: MotifInput): Promise<AdapterResult<MotifResultT>> {
    const { photos, prefs } = input;
    const hits = photos.filter((p) => indexBySha(p.sha256) != null).length;
    const usePreset = photos.length > 0 && hits / photos.length >= 0.8;

    if (usePreset) {
      const indexToPhotoId = new Map<number, string>();
      for (const p of photos) {
        const idx = indexBySha(p.sha256);
        if (idx != null) indexToPhotoId.set(idx, p.photoId);
      }
      const preset = demoMotifs()
        .map((m) => ({
          title: m.title,
          description: m.description,
          photo_ids: m.photo_indices
            .map((i) => indexToPhotoId.get(i))
            .filter((x): x is string => typeof x === "string"),
          evidence: m.evidence,
          confidence: m.confidence,
          alternative_readings: m.alternative_readings,
        }))
        .filter((m) => m.photo_ids.length >= 1)
        .slice(0, 4);
      if (preset.length >= 2) return { motifs: preset, provenance: { source: "demo_preset" } };
    }

    return { motifs: heuristicMotifs(photos, prefs), provenance: { source: "heuristic" } };
  },
};