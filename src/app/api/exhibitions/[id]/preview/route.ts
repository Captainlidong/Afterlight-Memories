import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { getNarrative } from "@/lib/db/narrative";
import { getLayout } from "@/lib/db/layout";
import { listPhotos } from "@/lib/db/photos";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 浏览/预览 bundle（§11）：一次取齐影展元信息 + 叙事 + 布局 + 照片资产。
 * 浏览页与设备预览 iframe 共用此载荷；布局只引用 photo_id/chapter_id，文案实时来自叙事。
 * 原图仅经 /api/files 本地路由访问，不在此暴露存储路径之外的公开 URL。
 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  const exhibition = getExhibition(db, id);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({
    exhibition,
    narrative: getNarrative(db, id),
    layout: getLayout(db, id),
    photos: listPhotos(db, id),
  });
});