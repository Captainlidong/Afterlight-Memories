import { describe, it, expect } from "vitest";
import { createDb } from "@/lib/db/client";
import {
  createExhibition,
  getExhibition,
  listExhibitions,
  deleteExhibition,
  updateExhibition,
} from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";

describe("db repos (in-memory)", () => {
  it("创建/读取/列表/更新/删除影展", () => {
    const db = createDb(":memory:");
    const input = CreateExhibitionInput.parse({ title: "测试影展", tone: "poetic" });
    const created = createExhibition(db, input, "demo");
    expect(created.id).toMatch(/^exh_/);
    expect(created.title).toBe("测试影展");
    expect(created.tone).toBe("poetic");
    expect(created.mode).toBe("demo");
    expect(created.status).toBe("draft");

    expect(getExhibition(db, created.id)?.title).toBe("测试影展");
    expect(listExhibitions(db)).toHaveLength(1);

    updateExhibition(db, created.id, { status: "ingesting", title: "改名" });
    const updated = getExhibition(db, created.id)!;
    expect(updated.status).toBe("ingesting");
    expect(updated.title).toBe("改名");

    deleteExhibition(db, created.id);
    expect(getExhibition(db, created.id)).toBeNull();
    expect(listExhibitions(db)).toHaveLength(0);
    db.close();
  });

  it("aesthetic_prefs 默认值解析", () => {
    const db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    expect(e.aesthetic_prefs.repetition).toBe("fewer");
    expect(e.aesthetic_prefs.focus).toEqual([]);
    db.close();
  });
});