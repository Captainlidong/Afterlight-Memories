import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { prepareUpload, analyzeImage } from "@/lib/image/pipeline";

describe("prepareUpload", () => {
  it("EXIF 方向 6 → 尺寸交换、缩略图正立", async () => {
    // 存储像素 100×200，orientation=6（需顺时针 90° 显示）→ 显示应为 200×100。
    const buf = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 80, g: 90, b: 100 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const meta = await sharp(buf).metadata();
    expect(meta.orientation).toBe(6);

    const prepared = await prepareUpload(buf);
    expect(prepared.width).toBe(200);
    expect(prepared.height).toBe(100);
    expect(prepared.sha256).toHaveLength(64);

    const thumbMeta = await sharp(prepared.thumbnail).metadata();
    expect(thumbMeta.width).toBe(200);
    expect(thumbMeta.height).toBe(100);
  });

  it("无 EXIF 图片仍能备料", async () => {
    const buf = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const prepared = await prepareUpload(buf);
    expect(prepared.width).toBe(64);
    expect(prepared.height).toBe(48);
  });
});

describe("analyzeImage", () => {
  it("真实 PNG → 指标范围合法、3 主色、无 EXIF", async () => {
    // 三条蓝色带 → 3 个主色桶，整体偏蓝（色温为负）。
    const w = 120, h = 90;
    const raw = Buffer.alloc(w * h * 3);
    const bands = [[40, 80, 160], [60, 120, 180], [20, 60, 140]];
    for (let y = 0; y < h; y++) {
      const [r, g, b] = bands[Math.floor((y / h) * 3)];
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
      }
    }
    const buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const a = await analyzeImage(buf, { allowExif: true });
    expect(a.sharpness_score).toBeGreaterThanOrEqual(0);
    expect(a.sharpness_score).toBeLessThanOrEqual(1);
    expect(a.brightness_score).toBeGreaterThan(0);
    expect(a.dominant_colors).toHaveLength(3);
    expect(a.dominant_colors[0]).toMatch(/^#[0-9A-F]{6}$/);
    expect(a.color_temp).toBeLessThan(0); // 偏蓝
    expect(a.phash).toHaveLength(16);
    expect(a.exif.has_exif).toBe(false);
    expect(a.exif.camera).toBe("hidden");
    expect(a.exif.latitude).toBeNull();
  });
});