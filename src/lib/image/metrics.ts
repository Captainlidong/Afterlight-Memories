/**
 * 图像技术指标（设计文档 §12.1/§12.2/§12.4）。
 * 全部为原始像素上的纯函数，便于合成 buffer 单测。
 * gray = 单通道 Uint8Array；rgb = 三通道 Uint8Array（sRGB，无 alpha）。
 * 这些只是后续审美判断的"证据"，绝不直接据此删除照片（§6.2）。
 */

/** 灰度图 Laplacian 方差（3×3 核 [0,1,0;1,-4,1;0,1,0]，跳过边界）。 */
export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        gray[i - width] +
        gray[i - 1] +
        gray[i + 1] +
        gray[i + width] -
        4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** 把 Laplacian 方差饱和映射到 0..1（K=200：var200→0.5，var800→0.8）。 */
export function normalizeSharpness(variance: number): number {
  const K = 200;
  const v = Math.max(0, variance);
  return v / (v + K);
}

export interface ExposureMetrics {
  brightness_score: number;
  highlight_clip_ratio: number;
  shadow_clip_ratio: number;
  contrast: number;
}

/** 亮度直方图估算：均值、高光/阴影截断比例、整体对比度（§12.2）。 */
export function exposureMetrics(
  gray: Uint8Array,
  width: number,
  height: number,
): ExposureMetrics {
  const n = width * height;
  if (n === 0) {
    return { brightness_score: 0, highlight_clip_ratio: 0, shadow_clip_ratio: 0, contrast: 0 };
  }
  let sum = 0;
  let sumSq = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
    if (v >= 250) hi++;
    if (v <= 5) lo++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return {
    brightness_score: mean / 255,
    highlight_clip_ratio: hi / n,
    shadow_clip_ratio: lo / n,
    contrast: Math.sqrt(variance) / 255,
  };
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** 主色：4×4×4 粗量化分桶，取频次最高的 count 桶的平均色（§12.4）。 */
export function dominantColors(
  rgb: Uint8Array,
  width: number,
  height: number,
  count = 3,
): string[] {
  const n = width * height;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key);
    if (bin) {
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else {
      bins.set(key, { n: 1, r, g, b });
    }
  }
  return [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, count)
    .map((bin) => toHex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n));
}

/** 冷暖倾向：-1（冷/蓝）..+1（暖/红），由 R-B 均值估算（§12.4）。 */
export function colorTemp(rgb: Uint8Array, width: number, height: number): number {
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += rgb[i * 3] - rgb[i * 3 + 2];
  }
  return Math.max(-1, Math.min(1, sum / n / 255));
}

/** 平均 HSV 饱和度 0..1（§12.4）。 */
export function saturation(rgb: Uint8Array, width: number, height: number): number {
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sum += max === 0 ? 0 : (max - min) / max;
  }
  return sum / n;
}