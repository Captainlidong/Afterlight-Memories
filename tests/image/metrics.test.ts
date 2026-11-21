import { describe, it, expect } from "vitest";
import {
  laplacianVariance,
  normalizeSharpness,
  exposureMetrics,
  dominantColors,
  colorTemp,
  saturation,
} from "@/lib/image/metrics";

function gray(w: number, h: number, fill: (x: number, y: number) => number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fill(x, y);
  return a;
}
function rgb(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const a = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    a[i * 3] = r;
    a[i * 3 + 1] = g;
    a[i * 3 + 2] = b;
  }
  return a;
}

describe("laplacian / sharpness", () => {
  it("平灰图方差为 0，清晰度为 0", () => {
    const g = gray(64, 64, () => 128);
    expect(laplacianVariance(g, 64, 64)).toBe(0);
    expect(normalizeSharpness(0)).toBe(0);
  });

  it("棋盘格高频 → 高方差、高清晰度", () => {
    const g = gray(64, 64, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    const v = laplacianVariance(g, 64, 64);
    expect(v).toBeGreaterThan(1000);
    expect(normalizeSharpness(v)).toBeGreaterThan(0.8);
  });

  it("normalizeSharpness 饱和映射到 0..1", () => {
    expect(normalizeSharpness(200)).toBeCloseTo(0.5, 5);
    expect(normalizeSharpness(1e9)).toBeLessThanOrEqual(1);
    expect(normalizeSharpness(-5)).toBe(0);
  });
});

describe("exposure", () => {
  it("纯白 → 亮度 1、高光截断 ≈ 1、无阴影截断", () => {
    const m = exposureMetrics(gray(32, 32, () => 255), 32, 32);
    expect(m.brightness_score).toBeCloseTo(1, 5);
    expect(m.highlight_clip_ratio).toBeCloseTo(1, 5);
    expect(m.shadow_clip_ratio).toBe(0);
  });

  it("纯黑 → 亮度 0、阴影截断 ≈ 1", () => {
    const m = exposureMetrics(gray(32, 32, () => 0), 32, 32);
    expect(m.brightness_score).toBe(0);
    expect(m.shadow_clip_ratio).toBeCloseTo(1, 5);
    expect(m.highlight_clip_ratio).toBe(0);
  });

  it("中灰 → 亮度 ≈ 0.5、无截断", () => {
    const m = exposureMetrics(gray(32, 32, () => 128), 32, 32);
    expect(m.brightness_score).toBeCloseTo(0.5, 1);
    expect(m.highlight_clip_ratio).toBe(0);
    expect(m.shadow_clip_ratio).toBe(0);
  });
});

describe("color", () => {
  it("纯色主色提取", () => {
    const colors = dominantColors(rgb(16, 16, 94, 113, 135), 16, 16, 3);
    expect(colors[0]).toBe("#5E7187");
  });

  it("冷色（蓝）色温为负，暖色（红）为正", () => {
    expect(colorTemp(rgb(8, 8, 0, 0, 255), 8, 8)).toBeLessThan(-0.9);
    expect(colorTemp(rgb(8, 8, 255, 0, 0), 8, 8)).toBeGreaterThan(0.9);
  });

  it("灰度饱和度 0，纯色饱和度 1", () => {
    expect(saturation(rgb(8, 8, 128, 128, 128), 8, 8)).toBe(0);
    expect(saturation(rgb(8, 8, 255, 0, 0), 8, 8)).toBeCloseTo(1, 5);
  });
});