import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { upsertAiDecision, getDecision } from "@/lib/db/curation";
import { CreateExhibitionInput, type CurationDecisionT } from "@/lib/agents/schemas";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { GET as getCuration } from "@/app/api/exhibitions/[id]/curation/route";
import { PATCH as patchDecision } from "@/app/api/exhibitions/[id]/photos/[photoId]/decision/route";

let tmp: string;
let exhId: string;
let photoId: string;

function ctx(id: string, pid?: string) {
  return { params: Promise.resolve(pid ? { id, photoId: pid } : { id }) };
}

async function patch(pid: string, body: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/photos/${pid}/decision`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await patchDecision(req, ctx(exhId, pid) as never);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-curation-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  const db = getDb();
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;

  const buf = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 60, g: 80, b: 120 } },
  }).jpeg().toBuffer();
  photoId = newId("photo");
  const prepared = await prepareUpload(buf);
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const origAbs = path.join(dir, `${photoId}.jpg`);
  fs.writeFileSync(origAbs, buf);
  fs.writeFileSync(path.join(dir, `thumb_${photoId}.jpg`), prepared.thumbnail);
  insertPhotoAsset(db, {
    id: photoId, exhibition_id: exhId, original_name: "x.jpg",
    storage_path: toRelative(origAbs), thumbnail_path: toRelative(path.join(dir, `thumb_${photoId}.jpg`)),
    width: prepared.width, height: prepared.height, mime_type: "image/jpeg",
    file_size: buf.length, sha256: prepared.sha256, sort_order: 0,
  });
  const d: CurationDecisionT = {
    photo_id: photoId, decision: "remove", score: 0.3, confidence: 0.55,
    reasons: ["欠曝且信息冗余"], related_photo_ids: [], user_override_allowed: true,
  };
  upsertAiDecision(db, exhId, d);
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("curation GET (§11.4)", () => {
  it("返回决定列表，effective = ai（无覆盖）", async () => {
    const res = await getCuration(new Request("http://localhost/x"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const { decisions } = await res.json();
    expect(decisions.length).toBe(1);
    expect(decisions[0].ai_decision).toBe("remove");
    expect(decisions[0].effective_decision).toBe("remove");
    expect(decisions[0].user_override).toBeNull();
  });

  it("影展不存在 → 404", async () => {
    const res = await getCuration(new Request("http://localhost/x"), ctx("exh_nope") as never);
    expect(res.status).toBe(404);
  });
});

describe("decision PATCH (§11.5)", () => {
  it("must_keep 覆盖 → effective must_keep，ai_decision 不变", async () => {
    const { status, body } = await patch(photoId, { decision: "must_keep", reason: "这张必须留下" });
    expect(status).toBe(200);
    expect(body.decision.effective_decision).toBe("must_keep");
    expect(body.decision.user_override).toBe("must_keep");
    expect(body.decision.ai_decision).toBe("remove");
    expect(getDecision(getDb(), photoId)!.effective_decision).toBe("must_keep");
  });

  it("改回 keep 覆盖 → effective keep", async () => {
    const { status, body } = await patch(photoId, { decision: "keep" });
    expect(status).toBe(200);
    expect(body.decision.effective_decision).toBe("keep");
  });

  it("非法决定 → 400 validation_error", async () => {
    const { status, body } = await patch(photoId, { decision: "must_remove" });
    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
  });

  it("照片不存在 → 404", async () => {
    const { status } = await patch("photo_nope", { decision: "keep" });
    expect(status).toBe(404);
  });
});