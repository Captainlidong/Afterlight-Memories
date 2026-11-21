import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { now } from "../id";
import type { PhotoInspectionT } from "../agents/schemas";
import type { ExifSummary } from "../image/exif";
import type { PhotoAsset } from "@/types";

interface PhotoRow {
  id: string;
  exhibition_id: string;
  original_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  mime_type: string;
  file_size: number;
  sha256: string;
  phash: string | null;
  exif_json: string | null;
  has_exif: number;
  privacy_status: string;
  status: string;
  error_message: string | null;
  sort_order: number;
  created_at: string;
}

function mapPhoto(r: PhotoRow): PhotoAsset {
  return {
    id: r.id,
    exhibition_id: r.exhibition_id,
    original_name: r.original_name,
    storage_path: r.storage_path,
    thumbnail_path: r.thumbnail_path,
    width: r.width,
    height: r.height,
    mime_type: r.mime_type,
    file_size: r.file_size,
    sha256: r.sha256,
    phash: r.phash,
    exif: r.exif_json ? (JSON.parse(r.exif_json) as ExifSummary) : null,
    has_exif: r.has_exif === 1,
    privacy_status: r.privacy_status,
    status: r.status,
    error_message: r.error_message,
    sort_order: r.sort_order,
    created_at: r.created_at,
  };
}

export interface NewPhotoAsset {
  id: string;
  exhibition_id: string;
  original_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  mime_type: string;
  file_size: number;
  sha256: string;
  sort_order: number;
  status?: string;
  error_message?: string | null;
}

export function insertPhotoAsset(db: DatabaseSync, p: NewPhotoAsset): void {
  db.prepare(
    `INSERT INTO photo_assets
      (id, exhibition_id, original_name, storage_path, thumbnail_path, width, height,
       mime_type, file_size, sha256, has_exif, privacy_status, status, error_message, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,'not_checked',?,?,?,?)`,
  ).run(
    p.id,
    p.exhibition_id,
    p.original_name,
    p.storage_path,
    p.thumbnail_path,
    p.width,
    p.height,
    p.mime_type,
    p.file_size,
    p.sha256,
    p.status ?? "uploaded",
    p.error_message ?? null,
    p.sort_order,
    now(),
  );
}

export function getPhoto(db: DatabaseSync, photoId: string): PhotoAsset | null {
  const r = db.prepare("SELECT * FROM photo_assets WHERE id=?").get(photoId) as PhotoRow | undefined;
  return r ? mapPhoto(r) : null;
}

export function listPhotos(db: DatabaseSync, exhibitionId: string): PhotoAsset[] {
  const rows = db
    .prepare("SELECT * FROM photo_assets WHERE exhibition_id=? ORDER BY sort_order, created_at")
    .all(exhibitionId) as unknown as PhotoRow[];
  return rows.map(mapPhoto);
}

export function countPhotos(db: DatabaseSync, exhibitionId: string): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM photo_assets WHERE exhibition_id=?")
    .get(exhibitionId) as { n: number };
  return r.n;
}

export function deletePhoto(db: DatabaseSync, photoId: string): void {
  db.prepare("DELETE FROM photo_assets WHERE id=?").run(photoId);
}

const PHOTO_UPDATABLE = new Set([
  "status",
  "error_message",
  "phash",
  "width",
  "height",
  "thumbnail_path",
  "exif_json",
  "has_exif",
  "sha256",
  "sort_order",
]);

export function updatePhoto(
  db: DatabaseSync,
  photoId: string,
  fields: Record<string, unknown>,
): void {
  const keys = Object.keys(fields).filter((k) => PHOTO_UPDATABLE.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE photo_assets SET ${sets} WHERE id=?`).run(
    ...keys.map((k) => fields[k] as SQLInputValue),
    photoId,
  );
}

// ---------- 技术分析 ----------
interface InspectionRow {
  photo_id: string;
  sharpness_score: number;
  laplacian_var: number;
  brightness_score: number;
  highlight_clip_ratio: number;
  shadow_clip_ratio: number;
  dominant_colors: string;
  color_temp: number | null;
  saturation: number | null;
  subjects: string;
  composition_tags: string;
  visual_embedding: string | null;
  visual_facts_json: string | null;
  visual_source: string | null;
  analysis_image_sha256: string | null;
  duplicate_group_id: string | null;
  processing_mode: string;
  created_at: string;
}

function mapInspection(r: InspectionRow): PhotoInspectionT {
  return {
    photo_id: r.photo_id,
    sharpness_score: r.sharpness_score,
    laplacian_var: r.laplacian_var,
    brightness_score: r.brightness_score,
    highlight_clip_ratio: r.highlight_clip_ratio,
    shadow_clip_ratio: r.shadow_clip_ratio,
    dominant_colors: JSON.parse(r.dominant_colors),
    color_temp: r.color_temp,
    saturation: r.saturation,
    subjects: JSON.parse(r.subjects),
    composition_tags: JSON.parse(r.composition_tags),
    visual_embedding: r.visual_embedding ? JSON.parse(r.visual_embedding) : null,
    visual_facts: r.visual_facts_json ? JSON.parse(r.visual_facts_json) : null,
    visual_source: r.visual_source as PhotoInspectionT["visual_source"],
    analysis_image_sha256: r.analysis_image_sha256,
    duplicate_group_id: r.duplicate_group_id,
    processing_mode: r.processing_mode as PhotoInspectionT["processing_mode"],
  };
}

export function upsertInspection(db: DatabaseSync, ins: PhotoInspectionT): void {
  db.prepare(
    `INSERT INTO photo_inspections
      (photo_id, sharpness_score, laplacian_var, brightness_score, highlight_clip_ratio,
       shadow_clip_ratio, dominant_colors, color_temp, saturation, subjects, composition_tags,
       visual_embedding, visual_facts_json, visual_source, analysis_image_sha256,
       duplicate_group_id, processing_mode, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(photo_id) DO UPDATE SET
       sharpness_score=excluded.sharpness_score, laplacian_var=excluded.laplacian_var,
       brightness_score=excluded.brightness_score, highlight_clip_ratio=excluded.highlight_clip_ratio,
       shadow_clip_ratio=excluded.shadow_clip_ratio, dominant_colors=excluded.dominant_colors,
       color_temp=excluded.color_temp, saturation=excluded.saturation, subjects=excluded.subjects,
       composition_tags=excluded.composition_tags, visual_embedding=excluded.visual_embedding,
       visual_facts_json=excluded.visual_facts_json, visual_source=excluded.visual_source,
       analysis_image_sha256=excluded.analysis_image_sha256,
       duplicate_group_id=excluded.duplicate_group_id, processing_mode=excluded.processing_mode`,
  ).run(
    ins.photo_id,
    ins.sharpness_score,
    ins.laplacian_var,
    ins.brightness_score,
    ins.highlight_clip_ratio,
    ins.shadow_clip_ratio,
    JSON.stringify(ins.dominant_colors),
    ins.color_temp ?? null,
    ins.saturation ?? null,
    JSON.stringify(ins.subjects),
    JSON.stringify(ins.composition_tags),
    ins.visual_embedding ? JSON.stringify(ins.visual_embedding) : null,
    ins.visual_facts ? JSON.stringify(ins.visual_facts) : null,
    ins.visual_source ?? null,
    ins.analysis_image_sha256 ?? null,
    ins.duplicate_group_id ?? null,
    ins.processing_mode,
    now(),
  );
}

export function getInspection(db: DatabaseSync, photoId: string): PhotoInspectionT | null {
  const r = db.prepare("SELECT * FROM photo_inspections WHERE photo_id=?").get(photoId) as
    | InspectionRow
    | undefined;
  return r ? mapInspection(r) : null;
}

export function listInspections(db: DatabaseSync, exhibitionId: string): PhotoInspectionT[] {
  const rows = db
    .prepare(
      `SELECT i.* FROM photo_inspections i
       JOIN photo_assets p ON p.id = i.photo_id
       WHERE p.exhibition_id=? ORDER BY p.sort_order, p.created_at`,
    )
    .all(exhibitionId) as unknown as InspectionRow[];
  return rows.map(mapInspection);
}