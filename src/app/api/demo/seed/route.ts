import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import {
  DEMO_COUNT,
  demoPhotoPath,
  demoPhotoName,
  demoPhotoMeta,
} from "@/lib/demo/manifest";
import { ApiError, ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * 演示种子（§9.3 / §14）：每次创建全新影展 id（is_demo_set=1, mode=demo），
 * 复制 24 张内置示例图到该影展 uploads 目录。3 次连续演示互不碰撞、无需改库/重启。
 * 真实 sharp 指标在随后的 ingest 中实跑；预设语义标签按 sha256 manifest 命中合并。
 */
export const POST = handler(async () => {
  const db = getDb();
  const input = CreateExhibitionInput.parse({
    title: "在光线转弯之前",
    source_type: "campus",
    user_intent: "想记录一个学期里不断经过的空间",
    tone: "restrained",
    aesthetic_prefs: { repetition: "fewer", focus: ["space", "light"] },
    allow_exif: true,
    allow_external_ai: false,
    mode: "demo",
  });
  const exhibition = createExhibition(db, input, "demo", { isDemoSet: true });
  const dir = uploadsDir(exhibition.id);
  fs.mkdirSync(dir, { recursive: true });

  for (let index = 1; index <= DEMO_COUNT; index++) {
    const src = demoPhotoPath(index);
    if (!fs.existsSync(src)) {
      throw new ApiError(
        500,
        "demo_assets_missing",
        `示例图缺失：${demoPhotoName(index)}。请先运行示例图生成（阶段 1e）。`,
      );
    }
    const buf = fs.readFileSync(src);
    const prepared = await prepareUpload(buf);
    const photoId = newId("photo");
    const origAbs = path.join(dir, `${photoId}.jpg`);
    const thumbAbs = path.join(dir, `thumb_${photoId}.jpg`);
    fs.writeFileSync(origAbs, buf);
    fs.writeFileSync(thumbAbs, prepared.thumbnail);
    insertPhotoAsset(db, {
      id: photoId,
      exhibition_id: exhibition.id,
      original_name: demoPhotoMeta(index)?.original_name ?? demoPhotoName(index),
      storage_path: toRelative(origAbs),
      thumbnail_path: toRelative(thumbAbs),
      width: prepared.width,
      height: prepared.height,
      mime_type: "image/jpeg",
      file_size: buf.length,
      sha256: prepared.sha256,
      sort_order: index - 1,
    });
  }

  return ok({ id: exhibition.id, exhibition, photos: DEMO_COUNT }, { status: 201 });
});