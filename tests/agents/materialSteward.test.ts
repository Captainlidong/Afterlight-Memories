import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, getPhoto, getInspection } from "@/lib/db/photos";
import { CreateExhibitionInput, PhotoInspection } from "@/lib/agents/schemas";
import { runIngest } from "@/lib/agents/materialSteward";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import type { DatabaseSync } from "node:sqlite";

const SVG_A = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a4a7a"/><stop offset="1" stop-color="#a8c0d8"/></linearGradient></defs>
  <rect width="256" height="256" fill="url(#s)"/>
  <circle cx="70" cy="60" r="34" fill="#f0e0b0"/>
  <polygon points="0,256 90,150 180,256" fill="#1a2030"/></svg>`;
const SVG_B = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" fill="#14161c"/>
  <rect x="150" y="40" width="80" height="150" fill="#c8d8e8"/>
  <circle cx="60" cy="120" r="26" fill="#3a4658"/></svg>`;

let db: DatabaseSync;
let tmp: string;
let exhId: string;
let idA: string, idADup: string, idB: string, idBad: string;

async function addPhoto(buf: Buffer, name: string, order: number): Promise<string> {
  const id = newId("photo");
  const prepared = await prepareUpload(buf);
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const origAbs = path.join(dir, `${id}.jpg`);
  const thumbAbs = path.join(dir, `thumb_${id}.jpg`);
  fs.writeFileSync(origAbs, buf);
  fs.writeFileSync(thumbAbs, prepared.thumbnail);
  insertPhotoAsset(db, {
    id,
    exhibition_id: exhId,
    original_name: name,
    storage_path: toRelative(origAbs),
    thumbnail_path: toRelative(thumbAbs),
    width: prepared.width,
    height: prepared.height,
    mime_type: "image/jpeg",
    file_size: buf.length,
    sha256: prepared.sha256,
    sort_order: order,
  });
  return id;
}

function addBadPhoto(name: string, order: number): string {
  const id = newId("photo");
  const buf = Buffer.from("this is not an image");
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const origAbs = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(origAbs, buf);
  insertPhotoAsset(db, {
    id,
    exhibition_id: exhId,
    original_name: name,
    storage_path: toRelative(origAbs),
    thumbnail_path: null,
    width: null,
    height: null,
    mime_type: "image/jpeg",
    file_size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    sort_order: order,
  });
  return id;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-steward-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const a = await sharp(Buffer.from(SVG_A)).jpeg().toBuffer();
  const aDup = await sharp(a).jpeg({ quality: 35 }).toBuffer();
  const b = await sharp(Buffer.from(SVG_B)).jpeg().toBuffer();
  idA = await addPhoto(a, "a.jpg", 0);
  idADup = await addPhoto(aDup, "a_dup.jpg", 1);
  idB = await addPhoto(b, "b.jpg", 2);
  idBad = addBadPhoto("bad.jpg", 3);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("materialSteward", () => {
  it("真跑指标 + 近似重复分组 + 坏文件隔离", async () => {
    const out = await runIngest(db, { runId: "run_test", exhibition: getExhibition(db, exhId)! });
    expect(out.processed).toBe(3);
    expect(out.failed).toBe(1);
    expect(out.duplicate_groups).toBe(1);
    expect(out.failed_photos[0].photo_id).toBe(idBad);

    const insA = getInspection(db, idA)!;
    expect(insA).not.toBeNull();
    expect(() => PhotoInspection.parse(insA)).not.toThrow();
    expect(insA.sharpness_score).toBeGreaterThanOrEqual(0);
    expect(insA.dominant_colors.length).toBeGreaterThan(0);
    expect(insA.processing_mode).toBe("heuristic"); // 未命中 manifest（空）

    expect(insA.duplicate_group_id).not.toBeNull();
    expect(insA.duplicate_group_id).toBe(getInspection(db, idADup)!.duplicate_group_id);
    expect(getInspection(db, idB)!.duplicate_group_id).toBeNull();

    expect(getPhoto(db, idA)!.status).toBe("inspected");
    expect(getPhoto(db, idBad)!.status).toBe("failed");
    expect(getPhoto(db, idBad)!.error_message).toBeTruthy();
  });
});