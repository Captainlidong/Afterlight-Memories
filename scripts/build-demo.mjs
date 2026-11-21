// 构建演示资产：把 vibe_images 下的生成图转为 public/demo/photos/pNN.jpg，
// 派生 p21（p20 重压 → 真实 pHash 近重复），计算 sha256 → manifest，写入语义预设。
// 运行：node scripts/build-demo.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { globSync } from "node:fs";
import sharp from "sharp";

const root = process.cwd();
const vibeDir = path.join(root, "vibe_images");
const outDir = path.join(root, "public", "demo", "photos");
const dataDir = path.join(root, "src", "lib", "demo", "data");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// idx: [category, original_name, subjects, composition_tags]
const TABLE = {
  1: ["框景", "窗框晨光.jpg", ["窗", "走廊", "晨光"], ["框景", "对称", "冷调"]],
  2: ["框景", "门洞庭院.jpg", ["门洞", "庭院", "光斑"], ["框景", "明暗对比"]],
  3: ["框景", "窗格书桌.jpg", ["窗格", "书桌", "植物", "光束"], ["框景", "几何光影"]],
  4: ["框景", "拱门蓝调.jpg", ["拱门", "教学楼", "蓝调时刻"], ["框景", "纵深", "冷调"]],
  5: ["框景", "车窗雨痕.jpg", ["车窗", "雨滴", "校园"], ["框景", "反光", "柔焦"]],
  6: ["背影", "走廊背影.jpg", ["人物背影", "走廊", "侧光"], ["背影", "引导线", "冷调"]],
  7: ["背影", "窗边伫立.jpg", ["人物背影", "窗", "剪影"], ["背影", "逆光", "留白"]],
  8: ["背影", "楼梯上行.jpg", ["人物背影", "楼梯", "扶手"], ["背影", "引导线", "纵深"]],
  9: ["背影", "操场黄昏.jpg", ["人物背影", "操场", "黄昏"], ["背影", "大留白", "小主体"]],
  10: ["冷光", "空教室.jpg", ["教室", "课桌", "荧光灯"], ["冷调", "重复", "低饱和"]],
  11: ["冷光", "书架冷光.jpg", ["书架", "过道", "冷光"], ["冷调", "纵深", "低饱和"]],
  12: ["冷光", "蓝墙光斑.jpg", ["墙面", "光斑"], ["冷调", "极简", "大留白"]],
  13: ["冷光", "夜窗.jpg", ["窗", "夜色", "反光"], ["冷调", "低光", "反光"]],
  14: ["走廊", "走廊纵深.jpg", ["走廊", "门", "顶灯"], ["一点透视", "引导线", "重复"]],
  15: ["走廊", "柱列光影.jpg", ["柱列", "阴影", "侧光"], ["重复", "节奏", "暖调"]],
  16: ["走廊", "转角光.jpg", ["走廊转角", "光束", "墙面"], ["明暗对比", "几何", "转折"]],
  17: ["反光", "玻璃幕墙.jpg", ["玻璃", "天空", "树枝"], ["反光", "抽象", "冷调"]],
  18: ["反光", "水洼倒影.jpg", ["水洼", "倒影", "教学楼"], ["反光", "对称", "冷调"]],
  19: ["反光", "旧镜.jpg", ["镜子", "窗", "瓷砖"], ["反光", "框景", "低饱和"]],
  20: ["重复构图", "空椅窗边.jpg", ["椅子", "窗", "外套"], ["静物", "侧光", "重复构图"]],
  21: ["重复构图", "空椅窗边-2.jpg", ["椅子", "窗", "外套"], ["静物", "侧光", "重复构图"]],
  22: ["不理想但情绪", "门洞柔焦.jpg", ["人物", "门洞", "黄昏"], ["柔焦", "运动模糊", "低清晰"]],
  23: ["不理想但情绪", "过曝窗.jpg", ["窗", "窗帘", "高光"], ["过曝", "高光溢出", "高调"]],
  24: ["明亮转折", "金色广场.jpg", ["广场", "树", "金色阳光", "天空"], ["暖调", "明亮", "转折", "大留白"]],
};

function findBase(idx) {
  const nn = String(idx).padStart(2, "0");
  const matches = globSync(path.join(vibeDir, `p${nn}_*.png`));
  if (matches.length === 0) throw new Error(`缺少生成图 p${nn}`);
  return matches[0];
}

const manifest = {};
const photos = [];
const inspections = [];

for (let idx = 1; idx <= 24; idx++) {
  const nn = String(idx).padStart(2, "0");
  const out = path.join(outDir, `p${nn}.jpg`);
  if (idx === 21) {
    // 近重复：p20 重压（真实 pHash 命中，而非复制同一文件）。
    const p20 = path.join(outDir, "p20.jpg");
    await sharp(p20).jpeg({ quality: 30 }).toFile(out);
  } else {
    await sharp(findBase(idx))
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(out);
  }
  const buf = fs.readFileSync(out);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  manifest[sha] = idx;
  const [category, original_name, subjects, composition_tags] = TABLE[idx];
  photos.push({ index: idx, original_name, category });
  inspections.push({ index: idx, subjects, composition_tags });
  console.log(`p${nn}.jpg  ${(buf.length / 1024).toFixed(0)}KB  ${category}`);
}

fs.writeFileSync(path.join(dataDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(dataDir, "photos.json"), JSON.stringify(photos, null, 2) + "\n");
fs.writeFileSync(path.join(dataDir, "inspections.json"), JSON.stringify(inspections, null, 2) + "\n");
console.log(`\n写入 manifest(${Object.keys(manifest).length}) / photos(${photos.length}) / inspections(${inspections.length})`);