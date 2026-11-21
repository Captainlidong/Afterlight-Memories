import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { upsertEdit, listEdits, getEdit, deleteEdit, deleteEdits } from "@/lib/db/edits";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-edits-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("user_edits repo（覆盖层，UNIQUE(exh,target_path)）", () => {
  it("upsertEdit 新建编辑，value 解析、locked 默认 false", () => {
    const e = upsertEdit(db, exh, "narrative.title", "我的标题");
    expect(e.target_path).toBe("narrative.title");
    expect(e.value).toBe("我的标题");
    expect(e.locked).toBe(false);
    expect(getEdit(db, exh, "narrative.title")!.value).toBe("我的标题");
  });

  it("同路径再次 upsert 覆盖 value/locked，保留 created_at，仅一行", () => {
    const first = getEdit(db, exh, "narrative.title")!;
    const updated = upsertEdit(db, exh, "narrative.title", "锁定的标题", true);
    expect(updated.value).toBe("锁定的标题");
    expect(updated.locked).toBe(true);
    expect(updated.created_at).toBe(first.created_at);
    expect(updated.id).toBe(first.id);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM user_edits WHERE exhibition_id=? AND target_path=?").get(exh, "narrative.title") as { c: number };
    expect(rows.c).toBe(1);
  });

  it("listEdits 按创建序（created_at, rowid）返回，供 merge 回放", () => {
    upsertEdit(db, exh, "narrative.curatorial_statement", "策展语");
    upsertEdit(db, exh, "chapter:chapter_01.title", "进入·改");
    const edits = listEdits(db, exh);
    expect(edits.map((e) => e.target_path)).toEqual([
      "narrative.title",
      "narrative.curatorial_statement",
      "chapter:chapter_01.title",
    ]);
  });

  it("value 支持数组/对象（顺序、归属、位置）", () => {
    upsertEdit(db, exh, "narrative.chapter_order", ["chapter_03", "chapter_01", "chapter_02"]);
    upsertEdit(db, exh, "photo:photo_a.membership", "chapter_02");
    expect(getEdit(db, exh, "narrative.chapter_order")!.value).toEqual(["chapter_03", "chapter_01", "chapter_02"]);
    expect(getEdit(db, exh, "photo:photo_a.membership")!.value).toBe("chapter_02");
  });

  it("deleteEdit 删除单条；deleteEdits 清空该影展", () => {
    deleteEdit(db, exh, "photo:photo_a.membership");
    expect(getEdit(db, exh, "photo:photo_a.membership")).toBeNull();
    deleteEdits(db, exh);
    expect(listEdits(db, exh).length).toBe(0);
  });
});