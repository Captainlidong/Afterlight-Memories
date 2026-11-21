import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { phashFromGray32, hammingDistance, PHASH_DUPLICATE_THRESHOLD } from "@/lib/image/phash";

async function gray32(buf: Buffer): Promise<Uint8Array> {
  const { data } = await sharp(buf)
    .resize(32, 32, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/** 类照片场景 A：天空渐变 + 太阳 + 山影（宽带频谱，抗压缩）。 */
async function sceneA(): Promise<Buffer> {
  const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a4a7a"/><stop offset="1" stop-color="#a8c0d8"/>
    </linearGradient></defs>
    <rect width="256" height="256" fill="url(#s)"/>
    <circle cx="70" cy="60" r="34" fill="#f0e0b0"/>
    <polygon points="0,256 90,150 180,256" fill="#1a2030"/>
    <polygon points="120,256 200,170 256,256" fill="#242c3c"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 不同场景 B：暗室 + 右侧亮窗 + 地面（结构方向不同）。 */
async function sceneB(): Promise<Buffer> {
  const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <rect width="256" height="256" fill="#14161c"/>
    <rect x="150" y="40" width="80" height="150" fill="#c8d8e8"/>
    <rect x="0" y="200" width="256" height="56" fill="#2a2620"/>
    <circle cx="60" cy="120" r="26" fill="#3a4658"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("pHash", () => {
  it("相同图像 hamming = 0", async () => {
    const a = await sceneA();
    const h1 = phashFromGray32(await gray32(a));
    const h2 = phashFromGray32(await gray32(a));
    expect(h1).toHaveLength(16);
    expect(hammingDistance(h1, h2)).toBe(0);
  });

  it("重压缩（jpeg q20）近似重复 hamming ≤ 阈值", async () => {
    const a = await sceneA();
    const recompressed = await sharp(a).jpeg({ quality: 20 }).toBuffer();
    const h1 = phashFromGray32(await gray32(a));
    const h2 = phashFromGray32(await gray32(recompressed));
    expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(PHASH_DUPLICATE_THRESHOLD);
  });

  it("不同场景 hamming > 阈值", async () => {
    const h1 = phashFromGray32(await gray32(await sceneA()));
    const h2 = phashFromGray32(await gray32(await sceneB()));
    expect(hammingDistance(h1, h2)).toBeGreaterThan(PHASH_DUPLICATE_THRESHOLD);
  });

  it("灰度尺寸不符时抛错", () => {
    expect(() => phashFromGray32(new Uint8Array(100))).toThrow();
  });
});