import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import {
  upsertAiDecision,
  setUserOverride,
  getDecision,
  listDecisions,
} from "@/lib/db/curation";
import type { CurationDecisionT } from "@/lib/agents/schemas";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;
let photoA: string;
let photoB: string;

function addPhoto(exhibitionId: string, name: string): string {
  const id = newId("photo");
  insertPhotoAsset(db, {
    id,
    exhibition_id: exhibitionId,
    original_name: name,
    storage_path: `uploads/${exhibitionId}/${id}.jpg`,
    thumbnail_path: null,
    width: 100,
    height: 80,
    mime_type: "image/jpeg",
    file_size: 1000,
    sha256: id,
    sort_order: 0,
  });
  return id;
}

function aiDecision(photoId: string, decision: CurationDecisionT["decision"]): CurationDecisionT {
  return {
    photo_id: photoId,
    decision,
    score: 0.8,
    confidence: 0.7,
    reasons: ["清晰度良好"],
    related_photo_ids: [],
    user_override_allowed: true,
  };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-curation-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  photoA = addPhoto(exh, "a.jpg");
  photoB = addPhoto(exh, "b.jpg");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("curation repos — ai/user 列分离", () => {
  it("写入 AI 决定后 effective = ai_decision，user_override 为空", () => {
    upsertAiDecision(db, exh, aiDecision(photoA, "keep"), "run_1");
    const d = getDecision(db, photoA)!;
    expect(d.ai_decision).toBe("keep");
    expect(d.user_override).toBeNull();
    expect(d.effective_decision).toBe("keep");
    expect(d.reasons).toEqual(["清晰度良好"]);
  });

  it("用户 must_keep 覆盖后 effective = must_keep", () => {
    setUserOverride(db, exh, photoA, "must_keep", "唯一现场瞬间");
    const d = getDecision(db, photoA)!;
    expect(d.user_override).toBe("must_keep");
    expect(d.override_reason).toBe("唯一现场瞬间");
    expect(d.effective_decision).toBe("must_keep");
  });

  it("重跑筛选只改 ai_* 列，must_keep 覆盖结构上不被触碰", () => {
    // AI 这次判 remove，但用户 must_keep 必须仍在。
    upsertAiDecision(db, exh, aiDecision(photoA, "remove"), "run_2");
    const d = getDecision(db, photoA)!;
    expect(d.ai_decision).toBe("remove");
    expect(d.user_override).toBe("must_keep");
    expect(d.effective_decision).toBe("must_keep");
    expect(d.run_id).toBe("run_2");
  });

  it("无覆盖时 effective 回落到 ai_decision", () => {
    upsertAiDecision(db, exh, aiDecision(photoB, "hold"), "run_1");
    const d = getDecision(db, photoB)!;
    expect(d.user_override).toBeNull();
    expect(d.effective_decision).toBe("hold");
  });

  it("listDecisions 返回该影展全部决定", () => {
    const all = listDecisions(db, exh);
    expect(all.length).toBe(2);
    expect(all.map((d) => d.photo_id).sort()).toEqual([photoA, photoB].sort());
  });
});