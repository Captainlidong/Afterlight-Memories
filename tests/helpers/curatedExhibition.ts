import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { DatabaseSync } from "node:sqlite";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { CreateExhibitionInput, type AiDecisionT, type CurationDecisionT } from "@/lib/agents/schemas";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { POST as postIngest } from "@/app/api/exhibitions/[id]/runs/ingest/route";

export interface CuratedFixture {
  tmp: string;
  db: DatabaseSync;
  exhId: string;
  photoIds: string[];
  cleanup: () => void;
}

/** 建 N 张纯色照片的影展并跑完 ingest→select，停在确认选片门。 */
export async function setupCuratedExhibition(count = 6): Promise<CuratedFixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-batch-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const photoIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = await sharp({
      create: {
        width: 120,
        height: 90,
        channels: 3,
        background: { r: 40 + i * 30, g: 70 + i * 20, b: 110 + i * 15 },
      },
    }).jpeg().toBuffer();
    const pid = newId("photo");
    const prepared = await prepareUpload(buf);
    const dir = uploadsDir(exhId);
    fs.mkdirSync(dir, { recursive: true });
    const origAbs = path.join(dir, `${pid}.jpg`);
    fs.writeFileSync(origAbs, buf);
    fs.writeFileSync(path.join(dir, `thumb_${pid}.jpg`), prepared.thumbnail);
    insertPhotoAsset(db, {
      id: pid, exhibition_id: exhId, original_name: `p${i}.jpg`,
      storage_path: toRelative(origAbs), thumbnail_path: toRelative(path.join(dir, `thumb_${pid}.jpg`)),
      width: prepared.width, height: prepared.height, mime_type: "image/jpeg",
      file_size: buf.length, sha256: prepared.sha256, sort_order: i,
    });
    photoIds.push(pid);
  }
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/runs/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: `fixture_ingest_${exhId}` }),
  });
  const res = await postIngest(req, { params: Promise.resolve({ id: exhId }) } as never);
  if (res.status !== 202) throw new Error(`fixture ingest 失败：${res.status}`);
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > 15000) throw new Error("fixture pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
  const cleanup = () => {
    delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AFTERLIGHT_DATA_DIR;
  };
  return { tmp, db, exhId, photoIds, cleanup };
}

/** 每个用例前重置决定/操作历史/运行记录与影展门状态，写入基线 AI 决定。 */
export function resetDecisions(
  db: DatabaseSync,
  exhId: string,
  photoIds: string[],
  ai: AiDecisionT[],
): void {
  db.exec("DELETE FROM curation_decisions");
  db.exec("DELETE FROM curation_operations");
  db.exec("DELETE FROM agent_runs");
  db.exec("DELETE FROM workflow_requests");
  updateExhibition(db, exhId, {
    status: "awaiting_selection_confirm",
    stale_from: null,
    failed_stage: null,
    selection_confirmed_revision: null,
    selection_confirmed_photo_ids: null,
    selection_hold_policy: null,
    selected_motif_id: null,
    input_revision: 0,
  });
  photoIds.forEach((pid, i) => {
    const d: CurationDecisionT = {
      photo_id: pid, decision: ai[i], score: 0.7, confidence: 0.8,
      reasons: ["测试决定"], related_photo_ids: [], user_override_allowed: true,
    };
    upsertAiDecision(db, exhId, d);
  });
}