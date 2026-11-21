import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput, type ExhibitionLayoutT } from "@/lib/agents/schemas";
import { replaceLayout, getLayout } from "@/lib/db/layout";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;

const layout: ExhibitionLayoutT = {
  template: "cinema_scroll",
  background: "#101114",
  text_color: "#f5f1e8",
  sections: [
    { id: "hero", type: "hero", photo_id: "photo_a", height: "92vh", caption_position: "bottom-left" },
    { id: "c1", type: "chapter_intro", chapter_id: "chapter_01", spacing: "large" },
    { id: "s1", type: "single_image", photo_id: "photo_a", size: "large", spacing: "medium" },
    { id: "end", type: "ending", photo_ids: ["photo_c"] },
  ],
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-layout-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("exhibition_layouts repo（每影展一条当前行）", () => {
  it("尚未生成 → getLayout 返回 null", () => {
    expect(getLayout(db, exh)).toBeNull();
  });

  it("replaceLayout 落库，template/background/text_color/sections 正确解析", () => {
    replaceLayout(db, exh, layout, { inputVersion: 2, runId: "run_1" });
    const l = getLayout(db, exh)!;
    expect(l.template).toBe("cinema_scroll");
    expect(l.background).toBe("#101114");
    expect(l.text_color).toBe("#f5f1e8");
    expect(l.input_version).toBe(2);
    expect(l.run_id).toBe("run_1");
    expect(l.sections.length).toBe(4);
    expect(l.sections[0].type).toBe("hero");
    expect(l.sections[3].type).toBe("ending");
  });

  it("再次 replaceLayout 覆盖同一行（不新增）", () => {
    const next: ExhibitionLayoutT = { ...layout, template: "archive_collage", background: "#f5f1e8", text_color: "#101114" };
    replaceLayout(db, exh, next, { inputVersion: 3, runId: "run_2" });
    const l = getLayout(db, exh)!;
    expect(l.template).toBe("archive_collage");
    expect(l.background).toBe("#f5f1e8");
    expect(l.input_version).toBe(3);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM exhibition_layouts WHERE exhibition_id=?").get(exh) as { c: number };
    expect(rows.c).toBe(1);
  });
});