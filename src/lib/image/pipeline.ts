import sharp from "sharp";
import crypto from "node:crypto";
import {
  laplacianVariance,
  normalizeSharpness,
  exposureMetrics,
  dominantColors,
  colorTemp,
  saturation,
} from "./metrics";
import { phashFromGray32 } from "./phash";
import { extractExif, type ExifSummary } from "./exif";

/**
 * sharp 图像管线（设计文档 §6.2 / §12）。
 * 所有像素读取前都 .rotate()，自动应用 EXIF 方向 → 缩略图与指标都正立（§17.1）。
 * 原图仅在服务端处理，绝不上传外部（除非用户显式选择外部 AI 模式）。
 */

export interface PreparedUpload {
  width: number;
  height: number;
  thumbnail: Buffer;
  sha256: string;
}

/** 上传时备料：方向校正后的原始尺寸 + 480px 缩略图 + sha256。 */
export async function prepareUpload(buffer: Buffer): Promise<PreparedUpload> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest("hex");
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("无法读取图片尺寸（文件可能损坏或格式不支持）。");
  }
  const oriented = (meta.orientation ?? 1) >= 5;
  const width = oriented ? meta.height : meta.width;
  const height = oriented ? meta.width : meta.height;
  const thumbnail = await sharp(buffer)
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { width, height, thumbnail, sha256 };
}

export interface ImageAnalysis {
  phash: string;
  sharpness_score: number;
  laplacian_var: number;
  brightness_score: number;
  highlight_clip_ratio: number;
  shadow_clip_ratio: number;
  dominant_colors: string[];
  color_temp: number;
  saturation: number;
  exif: ExifSummary;
}

/** 素材管家分析：清晰度/曝光/主色/色温/饱和度 + pHash + EXIF。 */
export async function analyzeImage(
  buffer: Buffer,
  opts: { allowExif: boolean },
): Promise<ImageAnalysis> {
  const { data: gray, info: gi } = await sharp(buffer)
    .rotate()
    .resize({ width: 256, height: 256, fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: rgb, info: ci } = await sharp(buffer)
    .rotate()
    .resize({ width: 64, height: 64, fit: "inside" })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: g32 } = await sharp(buffer)
    .rotate()
    .resize(32, 32, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lapVar = laplacianVariance(gray, gi.width, gi.height);
  const exp = exposureMetrics(gray, gi.width, gi.height);
  return {
    phash: phashFromGray32(g32),
    sharpness_score: normalizeSharpness(lapVar),
    laplacian_var: lapVar,
    brightness_score: exp.brightness_score,
    highlight_clip_ratio: exp.highlight_clip_ratio,
    shadow_clip_ratio: exp.shadow_clip_ratio,
    dominant_colors: dominantColors(rgb, ci.width, ci.height, 3),
    color_temp: colorTemp(rgb, ci.width, ci.height),
    saturation: saturation(rgb, ci.width, ci.height),
    exif: extractExif(buffer, opts.allowExif),
  };
}