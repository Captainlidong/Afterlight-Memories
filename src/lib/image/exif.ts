import ExifReader from "exifreader";

/**
 * EXIF 摘要（设计文档 §10.2 / §13.1 隐私）。
 * 默认不保留 GPS 与相机型号（camera='hidden'，经纬度=null）；
 * 拍摄时间仅在用户允许（allow_exif）时读取。无 EXIF 也能继续处理（§6.2）。
 */
export interface ExifSummary {
  taken_at: string | null;
  latitude: number | null;
  longitude: number | null;
  camera: string;
  has_exif: boolean;
}

const PHOTO_TAGS = [
  "DateTimeOriginal",
  "DateTime",
  "Make",
  "Model",
  "ExposureTime",
  "FNumber",
  "ISOSpeedRatings",
  "GPSLatitude",
  "GPSLongitude",
];

/** "2026:10:18 17:12:00" → "2026-10-18T17:12:00"（不臆造时区）。 */
function parseExifDate(raw: string): string | null {
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

export function extractExif(buffer: Buffer, allowExif: boolean): ExifSummary {
  const empty: ExifSummary = {
    taken_at: null,
    latitude: null,
    longitude: null,
    camera: "hidden",
    has_exif: false,
  };
  let tags: Record<string, { description?: string }>;
  try {
    tags = ExifReader.load(buffer) as Record<string, { description?: string }>;
  } catch {
    return empty;
  }
  const hasExif = PHOTO_TAGS.some((k) => tags[k] != null);
  if (!hasExif) return empty;

  let takenAt: string | null = null;
  if (allowExif) {
    const raw =
      tags.DateTimeOriginal?.description ?? tags.DateTime?.description ?? null;
    if (raw) takenAt = parseExifDate(String(raw));
  }
  // GPS 与相机型号在 MVP 一律隐藏（隐私默认，§13.1）。
  return { taken_at: takenAt, latitude: null, longitude: null, camera: "hidden", has_exif: true };
}