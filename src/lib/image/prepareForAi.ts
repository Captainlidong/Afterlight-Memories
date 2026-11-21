import crypto from "node:crypto";
import sharp from "sharp";

export const AI_PREPROCESS_VERSION = "vision-jpeg-v1";
export const AI_IMAGE_MAX_INPUT_PIXELS = 40_000_000;
export const AI_IMAGE_MAX_BYTES = 1_000_000;

export interface PreparedVisionImage {
  bytes: Buffer;
  mimeType: "image/jpeg";
  sha256: string;
  preprocessVersion: string;
  width: number;
  height: number;
}

const INPUT_FORMATS = new Set(["jpeg", "png", "webp"]);

export async function prepareForAi(
  buffer: Buffer,
  opts: {
    maxEdge: number;
    maxBytes?: number;
    maxInputPixels?: number;
  },
): Promise<PreparedVisionImage> {
  const maxBytes = opts.maxBytes ?? AI_IMAGE_MAX_BYTES;
  const maxInputPixels = opts.maxInputPixels ?? AI_IMAGE_MAX_INPUT_PIXELS;
  const source = sharp(buffer, { limitInputPixels: maxInputPixels });
  const meta = await source.metadata();
  if (!meta.format || !INPUT_FORMATS.has(meta.format)) {
    throw new Error("仅支持可解码的 JPG、PNG 或 WEBP 图片。");
  }
  if (!meta.width || !meta.height) {
    throw new Error("无法读取图片尺寸，文件可能损坏。");
  }
  if (meta.width * meta.height > maxInputPixels) {
    throw new Error(`图片像素超过 ${maxInputPixels} 的安全上限。`);
  }

  const orientedLongEdge = Math.max(
    (meta.orientation ?? 1) >= 5 ? meta.height : meta.width,
    (meta.orientation ?? 1) >= 5 ? meta.width : meta.height,
  );
  let edge = Math.min(opts.maxEdge, orientedLongEdge);
  let bytes = Buffer.alloc(0);
  let width = 0;
  let height = 0;

  for (let attempt = 0; attempt < 12; attempt++) {
    const quality = [82, 66, 50][attempt % 3];
    const candidate = await sharp(buffer, { limitInputPixels: maxInputPixels })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    bytes = candidate.data;
    width = candidate.info.width;
    height = candidate.info.height;
    if (bytes.length <= maxBytes) {
      return {
        bytes,
        mimeType: "image/jpeg",
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        preprocessVersion: AI_PREPROCESS_VERSION,
        width,
        height,
      };
    }
    if (attempt % 3 === 2) edge = Math.max(64, Math.floor(edge * 0.75));
  }
  throw new Error(`压缩分析图仍超过 ${maxBytes} 字节上限，已拒绝发送。`);
}
