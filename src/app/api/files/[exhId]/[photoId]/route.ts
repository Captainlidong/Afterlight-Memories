import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getPhoto } from "@/lib/db/photos";
import { uploadsDir, toAbsolute } from "@/lib/files";
import { ApiError, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ exhId: string; photoId: string }> };

/**
 * 本地图片路由（§17.1）：原图绝不落在 public/ 下，仅经此路由读取。
 * variant=thumb（默认）| original。路径越界守卫确保只能读到本影展 uploads 目录内。
 */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const { exhId, photoId } = await params;
  const photo = getPhoto(getDb(), photoId);
  if (!photo || photo.exhibition_id !== exhId) {
    throw new ApiError(404, "not_found", "照片不存在。");
  }
  const variant = new URL(req.url).searchParams.get("variant") ?? "thumb";
  if (variant !== "thumb" && variant !== "original") {
    throw new ApiError(400, "invalid_variant", "variant 仅支持 thumb 或 original。");
  }
  const rel = variant === "original" ? photo.storage_path : photo.thumbnail_path;
  if (!rel) throw new ApiError(404, "not_found", "该照片没有可用的图片文件。");

  const base = path.resolve(uploadsDir(exhId));
  const abs = path.resolve(toAbsolute(rel));
  if (!abs.startsWith(base + path.sep)) {
    throw new ApiError(403, "forbidden", "非法的文件路径。");
  }
  if (!fs.existsSync(abs)) throw new ApiError(404, "not_found", "图片文件缺失。");

  const buf = fs.readFileSync(abs);
  const mime = variant === "original" ? photo.mime_type : "image/jpeg";
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(buf.length),
    },
  });
});