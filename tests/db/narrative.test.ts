import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput, type NarrativePlanT } from "@/lib/agents/schemas";
import { replaceNarrative, getNarrative } from "@/lib/db/narrative";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;

const plan: NarrativePlanT = {
  title: "在光线转弯之前",
  subtitle: "一组关于窗、背影与经过的照片",
  curatorial_statement: "人物很少占据画面中心，窗与光线反复出现，像是在记录经过而非停留。",
  chapters: [
    { id: "chapter_01", title: "进入", description: "先让空间出现，人物只作为尺度线索。", photo_ids: ["photo_a"], locked: false, placement_reasons: [] },
    { id: "chapter_02", title: "经过", description: "人物更接近，但仍未进入画面中心。", photo_ids: ["photo_b"], locked: false, placement_reasons: [] },
    { id: "chapter_03", title: "留下", description: "当人物离开，窗边光线仍保留观看方向。", photo_ids: ["photo_c"], locked: false, placement_reasons: [] },
  ],
  tone: "restrained",
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-narrative-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("narrative_plans repo（每影展一条当前行）", () => {
  it("尚未生成 → getNarrative 返回 null", () => {
    expect(getNarrative(db, exh)).toBeNull();
  });

  it("replaceNarrative 落库，chapters/tone/source 正确解析", () => {
    replaceNarrative(db, exh, plan, { source: "demo_preset", inputVersion: 2, runId: "run_1", selectedMotifId: "motif_x" });
    const n = getNarrative(db, exh)!;
    expect(n.title).toBe("在光线转弯之前");
    expect(n.subtitle).toBe("一组关于窗、背影与经过的照片");
    expect(n.tone).toBe("restrained");
    expect(n.source).toBe("demo_preset");
    expect(n.input_version).toBe(2);
    expect(n.run_id).toBe("run_1");
    expect(n.selected_motif_id).toBe("motif_x");
    expect(n.chapters.length).toBe(3);
    expect(n.chapters[0].photo_ids).toEqual(["photo_a"]);
    expect(n.chapters[0].id).toBe("chapter_01");
  });

  it("再次 replaceNarrative 覆盖同一行（不新增）", () => {
    const next: NarrativePlanT = { ...plan, title: "新的标题", tone: "poetic" };
    replaceNarrative(db, exh, next, { source: "heuristic", inputVersion: 3, runId: "run_2", selectedMotifId: "motif_y" });
    const n = getNarrative(db, exh)!;
    expect(n.title).toBe("新的标题");
    expect(n.tone).toBe("poetic");
    expect(n.source).toBe("heuristic");
    expect(n.input_version).toBe(3);
    expect(n.selected_motif_id).toBe("motif_y");
    const rows = db.prepare("SELECT COUNT(*) AS c FROM narrative_plans WHERE exhibition_id=?").get(exh) as { c: number };
    expect(rows.c).toBe(1);
  });
});