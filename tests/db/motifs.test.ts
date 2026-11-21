import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import {
  replaceMotifs,
  listMotifs,
  getMotif,
  selectMotif,
  updateMotif,
} from "@/lib/db/motifs";
import { CreateExhibitionInput, type MotifT } from "@/lib/agents/schemas";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exhId: string;

const M = (title: string, i: number): MotifT => ({
  title,
  description: `${title} 的描述。`,
  photo_ids: [`photo_p0${i}`],
  evidence: [`${i} 张照片支持`],
  confidence: 0.8,
  alternative_readings: ["另一种理解"],
});

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-motifs-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("motifs repo", () => {
  it("replaceMotifs 写入 3 条，state proposed，effective_title=title", () => {
    replaceMotifs(db, exhId, [M("窗与背影", 1), M("反复蓝色光线", 2), M("人物与空间距离", 3)]);
    const list = listMotifs(db, exhId);
    expect(list).toHaveLength(3);
    expect(list[0].state).toBe("proposed");
    expect(list[0].effective_title).toBe("窗与背影");
    expect(list[0].user_title).toBeNull();
    expect(list[0].photo_ids).toEqual(["photo_p01"]);
  });

  it("selectMotif 设 selected + exhibitions.selected_motif_id + custom_title", () => {
    const list = listMotifs(db, exhId);
    const target = list[2];
    selectMotif(db, exhId, target.id, "我改的主线名");
    expect(getMotif(db, target.id)!.state).toBe("selected");
    expect(getMotif(db, target.id)!.effective_title).toBe("我改的主线名");
    expect(getExhibition(db, exhId)!.selected_motif_id).toBe(target.id);
    // 其余回到 proposed。
    expect(getMotif(db, list[0].id)!.state).toBe("proposed");
  });

  it("updateMotif 改名持久化（刷新后仍在）", () => {
    const list = listMotifs(db, exhId);
    updateMotif(db, exhId, list[0].id, { user_title: "窗边的蓝色时刻" });
    expect(getMotif(db, list[0].id)!.effective_title).toBe("窗边的蓝色时刻");
    expect(getMotif(db, list[0].id)!.title).toBe("窗与背影");
  });

  it("重跑 replaceMotifs 保留同名改名；已选主题仍在候选中 → 延续选择", () => {
    const before = listMotifs(db, exhId);
    replaceMotifs(db, exhId, [M("窗与背影", 1), M("反复蓝色光线", 2), M("人物与空间距离", 3)]);
    const list = listMotifs(db, exhId);
    expect(list[0].effective_title).toBe("窗边的蓝色时刻"); // 改名按标题延续
    expect(list[2].state).toBe("selected"); // 主线仍在 → 延续选择（重跑矩阵 motifs→qa 依赖）
    expect(getExhibition(db, exhId)!.selected_motif_id).toBe(list[2].id);
    expect(list[2].id).not.toBe(before[2].id);
  });

  it("重跑后已选主题消失 → 重置选择回主题门", () => {
    replaceMotifs(db, exhId, [M("窗与背影", 1), M("反复蓝色光线", 2)]);
    expect(getExhibition(db, exhId)!.selected_motif_id).toBeNull();
    expect(listMotifs(db, exhId).every((m) => m.state === "proposed")).toBe(true);
  });

  it("拒绝已选主题 → 清空 selected_motif_id", () => {
    const list = listMotifs(db, exhId);
    selectMotif(db, exhId, list[1].id);
    expect(getExhibition(db, exhId)!.selected_motif_id).toBe(list[1].id);
    updateMotif(db, exhId, list[1].id, { state: "rejected" });
    expect(getMotif(db, list[1].id)!.state).toBe("rejected");
    expect(getExhibition(db, exhId)!.selected_motif_id).toBeNull();
  });
});