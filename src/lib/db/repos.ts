import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newId, now } from "../id";
import { AestheticPrefs, type CreateExhibitionInputT } from "../agents/schemas";
import type { RunMode } from "../mode";
import type { Exhibition } from "@/types";

interface ExhibitionRow {
  id: string;
  title: string;
  subtitle: string;
  source_type: string | null;
  user_intent: string | null;
  tone: string;
  aesthetic_prefs: string;
  allow_exif: number;
  allow_external_ai: number;
  privacy_mode: string;
  mode: string;
  is_demo_set: number;
  status: string;
  failed_stage: string | null;
  stale_from: string | null;
  selected_motif_id: string | null;
  template: string;
  current_version: number;
  input_revision: number;
  selection_confirmed_revision: number | null;
  selection_confirmed_photo_ids: string | null;
  selection_hold_policy: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: ExhibitionRow): Exhibition {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    source_type: r.source_type as Exhibition["source_type"],
    user_intent: r.user_intent,
    tone: r.tone as Exhibition["tone"],
    aesthetic_prefs: AestheticPrefs.parse(JSON.parse(r.aesthetic_prefs)),
    allow_exif: r.allow_exif === 1,
    allow_external_ai: r.allow_external_ai === 1,
    privacy_mode: r.privacy_mode,
    mode: r.mode as RunMode,
    is_demo_set: r.is_demo_set === 1,
    status: r.status as Exhibition["status"],
    failed_stage: r.failed_stage as Exhibition["failed_stage"],
    stale_from: r.stale_from as Exhibition["stale_from"],
    selected_motif_id: r.selected_motif_id,
    template: r.template as Exhibition["template"],
    current_version: r.current_version,
    input_revision: r.input_revision,
    selection_confirmed_revision: r.selection_confirmed_revision,
    selection_confirmed_photo_ids: r.selection_confirmed_photo_ids
      ? (JSON.parse(r.selection_confirmed_photo_ids) as string[])
      : null,
    selection_hold_policy: r.selection_hold_policy as Exhibition["selection_hold_policy"],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createExhibition(
  db: DatabaseSync,
  input: CreateExhibitionInputT,
  mode: RunMode,
  opts: { isDemoSet?: boolean; title?: string } = {},
): Exhibition {
  const id = newId("exh");
  const ts = now();
  const prefs = AestheticPrefs.parse(input.aesthetic_prefs ?? {});
  db.prepare(
    `INSERT INTO exhibitions
      (id, title, subtitle, source_type, user_intent, tone, aesthetic_prefs,
       allow_exif, allow_external_ai, privacy_mode, mode, is_demo_set, status,
       template, current_version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opts.title ?? input.title ?? "",
    "",
    input.source_type ?? null,
    input.user_intent ?? null,
    input.tone ?? "restrained",
    JSON.stringify(prefs),
    input.allow_exif ? 1 : 0,
    input.allow_external_ai ? 1 : 0,
    input.privacy_mode ?? "local_first",
    mode,
    opts.isDemoSet ? 1 : 0,
    "draft",
    "cinema_scroll",
    0,
    ts,
    ts,
  );
  return getExhibition(db, id)!;
}

export function getExhibition(db: DatabaseSync, id: string): Exhibition | null {
  const r = db.prepare("SELECT * FROM exhibitions WHERE id=?").get(id) as
    | ExhibitionRow
    | undefined;
  return r ? mapRow(r) : null;
}

export function listExhibitions(db: DatabaseSync): Exhibition[] {
  const rows = db
    .prepare("SELECT * FROM exhibitions ORDER BY updated_at DESC")
    .all() as unknown as ExhibitionRow[];
  return rows.map(mapRow);
}

export function setExternalAiConsent(db: DatabaseSync, id: string, allowed: boolean): void {
  db.prepare("UPDATE exhibitions SET allow_external_ai=?, updated_at=? WHERE id=?").run(allowed ? 1 : 0, now(), id);
}

export function deleteExhibition(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM exhibitions WHERE id=?").run(id);
}

/** 输入修订号 +1（乐观并发用，与展示版本 current_version 分离）。返回新值。 */
export function bumpInputRevision(db: DatabaseSync, id: string): number {
  const exh = getExhibition(db, id);
  if (!exh) throw new Error(`影展不存在：${id}`);
  const rev = exh.input_revision + 1;
  updateExhibition(db, id, { input_revision: rev });
  return rev;
}

/** 确认选片失效（§19.5）：保留集变化时关闭确认门，需用户重新确认。 */
export function clearConfirmation(db: DatabaseSync, id: string): void {
  updateExhibition(db, id, {
    selection_confirmed_revision: null,
    selection_confirmed_photo_ids: null,
    selection_hold_policy: null,
  });
}

/** 更新影展字段（状态/标题/语气/模板/stale 等）。仅白名单列。 */
const UPDATABLE = new Set([
  "title",
  "subtitle",
  "tone",
  "template",
  "status",
  "failed_stage",
  "stale_from",
  "selected_motif_id",
  "current_version",
  "input_revision",
  "selection_confirmed_revision",
  "selection_confirmed_photo_ids",
  "selection_hold_policy",
  "user_intent",
  "mode",
]);

export function updateExhibition(
  db: DatabaseSync,
  id: string,
  fields: Record<string, unknown>,
): void {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  const values = keys.map((k) => fields[k] as SQLInputValue);
  db.prepare(`UPDATE exhibitions SET ${sets}, updated_at=? WHERE id=?`).run(
    ...values,
    now(),
    id,
  );
}