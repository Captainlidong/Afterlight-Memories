import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import sharp from "sharp";
import ExifReader from "exifreader";
import {
  AI_PREPROCESS_VERSION,
  prepareForAi,
} from "@/lib/image/prepareForAi";

describe("prepareForAi（V06/V07）", () => {
  it("EXIF 转正、去元数据、限制长边且不修改原图", async () => {
    const original = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 80, g: 90, b: 100 } },
    })
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: {
          IFD0: {
            Make: "Afterlight",
            Model: "TestCamera",
            GPSLatitudeRef: "N",
            GPSLatitude: "31/1 12/1 0/1",
            GPSLongitudeRef: "E",
            GPSLongitude: "121/1 28/1 0/1",
          },
        },
      })
      .toBuffer();
    const before = crypto.createHash("sha256").update(original).digest("hex");

    const prepared = await prepareForAi(original, { maxEdge: 80 });

    expect(crypto.createHash("sha256").update(original).digest("hex")).toBe(before);
    expect(prepared.width).toBe(80);
    expect(prepared.height).toBe(40);
    expect(prepared.mimeType).toBe("image/jpeg");
    expect(prepared.preprocessVersion).toBe(AI_PREPROCESS_VERSION);
    expect(prepared.sha256).toBe(crypto.createHash("sha256").update(prepared.bytes).digest("hex"));
    const meta = await sharp(prepared.bytes).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    const tags = ExifReader.load(prepared.bytes);
    expect(tags.Make).toBeUndefined();
    expect(tags.Model).toBeUndefined();
    expect(tags.DateTimeOriginal).toBeUndefined();
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.GPSLongitude).toBeUndefined();
  });

  it("小图不放大，输出始终为 JPEG", async () => {
    const original = await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } },
    }).png().toBuffer();
    const prepared = await prepareForAi(original, { maxEdge: 1280 });
    expect(prepared.width).toBe(64);
    expect(prepared.height).toBe(48);
    expect((await sharp(prepared.bytes).metadata()).format).toBe("jpeg");
  });

  it("高噪图通过质量与尺寸联合收敛到字节上限", async () => {
    const width = 900;
    const height = 700;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 73 + Math.floor(i / 997) * 151) % 256;
    const original = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const prepared = await prepareForAi(original, { maxEdge: 700, maxBytes: 80_000 });
    expect(prepared.bytes.length).toBeLessThanOrEqual(80_000);
    expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(700);
  });

  it("损坏文件与超像素输入分别拒绝，不返回分析副本", async () => {
    await expect(prepareForAi(Buffer.from("not an image"), { maxEdge: 1280 })).rejects.toThrow();
    const oversized = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    await expect(prepareForAi(oversized, { maxEdge: 1280, maxInputPixels: 100 })).rejects.toThrow(
      /pixel|像素/i,
    );
  });
});
