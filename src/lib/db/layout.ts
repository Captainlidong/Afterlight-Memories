import type { DatabaseSync } from "node:sqlite";
import type { ExhibitionLayoutT } from "../agents/schemas";
import type { LayoutDTO } from "@/types";
import { now } from "../id";

/**
 * 布局持久化（§10.7）。每影展一条当前行，完整历史在 agent_runs.output_json + 版本快照。
 * replaceLayout 是布局设计师重跑的落库点：整行覆盖。布局只引用 chapter_id/photo_id，
 * 文案实时从叙事 plan 读取，故改文案无需重跑布局（§7.3）。
 */
export function replaceLayout(
  db: DatabaseSync,
  exhibitionId: string,
  layout: ExhibitionLayoutT,
  opts: { inputVersion: number; runId?: string | null },
): void {
  db.prepare(
    `INSERT INTO exhibition_layouts
       (exhibition_id, template, background, text_color, sections, input_version, run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exhibition_id) DO UPDATE SET
       template=excluded.template, background=excluded.background, text_color=excluded.text_color,
       sections=excluded.sections, input_version=excluded.input_version, run_id=excluded.run_id, updated_at=excluded.updated_at`,
  ).run(
    exhibitionId,
    layout.template,
    layout.background,
    layout.text_color,
    JSON.stringify(layout.sections),
    opts.inputVersion,
    opts.runId ?? null,
    now(),
  );
}

export function deleteLayout(db: DatabaseSync, exhibitionId: string): void {
  db.prepare("DELETE FROM exhibition_layouts WHERE exhibition_id = ?").run(exhibitionId);
}

export function getLayout(db: DatabaseSync, exhibitionId: string): LayoutDTO | null {
  const r = db
    .prepare("SELECT * FROM exhibition_layouts WHERE exhibition_id = ?")
    .get(exhibitionId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    exhibition_id: r.exhibition_id as string,
    template: r.template as LayoutDTO["template"],
    background: r.background as string,
    text_color: r.text_color as string,
    sections: JSON.parse(r.sections as string),
    input_version: r.input_version as number,
    run_id: (r.run_id as string | null) ?? null,
    updated_at: r.updated_at as string,
  };
}