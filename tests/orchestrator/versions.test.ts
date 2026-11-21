import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition, bumpInputRevision, clearConfirmation } from "@/lib/db/repos";
import { insertPhotoAsset, deletePhoto } from "@/lib/db/photos";
import { upsertAiDecision, setUserOverride, getDecision } from "@/lib/db/curation";
import { replaceMotifs, listMotifs, selectMotif, getMotif, updateMotif } from "@/lib/db/motifs";
import { replaceNarrative, getNarrative } from "@/lib/db/narrative";
import { upsertEdit, getEdit, listEdits } from "@/lib/db/edits";
import { listVersions, getVersion, insertVersion } from "@/lib/db/versions";
import { replaceLayout, getLayout } from "@/lib/db/layout";
import { snapshotVersion, restoreVersion, buildSnapshot } from "@/lib/orchestrator/versions";
import { CreateExhibitionInput, NarrativePlan, Motif, ExhibitionLayout } from "@/lib/agents/schemas";
import type { NarrativePlanT, ExhibitionLayoutT } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { ApiError } from "@/lib/api/errors";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;

function addPhoto(exhId: string, sha: string): string {
  const id = newId("photo");
  insertPhotoAsset(db, {
    id,
    exhibition_id: exhId,
    original_name: "x.jpg",
    storage_path: `uploads/${exhId}/${id}.jpg`,
    thumbnail_path: null,
    width: 100,
    height: 80,
    mime_type: "image/jpeg",
    file_size: 1000,
    sha256: sha,
    sort_order: 0,
  });
  return id;
}

function decide(exhId: string, photoId: string, decision: "keep" | "hold" | "remove"): void {
  upsertAiDecision(db, exhId, {
    photo_id: photoId,
    decision,
    score: 0.7,
    confidence: 0.6,
    reasons: ["test"],
    related_photo_ids: [],
    user_override_allowed: true,
  });
}

function makePlan(title: string, ids: string[]): NarrativePlanT {
  const mid = Math.ceil(ids.length / 2);
  return NarrativePlan.parse({
    title,
    subtitle: "副标题",
    curatorial_statement: "一段克制的策展语。",
    chapters: [
      { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: ids.slice(0, mid) },
      { id: "chapter_02", title: "留下", description: "观看收束。", photo_ids: ids.slice(mid) },
    ],
    tone: "restrained",
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-versions-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("版本快照 snapshotVersion", () => {
  it("递增 current_version 并落含叙事/编辑的快照", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = addPhoto(exh, "sha-a");
    const b = addPhoto(exh, "sha-b");
    decide(exh, a, "keep");
    decide(exh, b, "keep");
    replaceNarrative(db, exh, makePlan("版本一", [a, b]), { source: "heuristic", inputVersion: 0 });
    upsertEdit(db, exh, "narrative.title", "锁定标题", true);

    const v = snapshotVersion(db, exh, "叙事生成");
    expect(v).toBe(1);
    expect(getExhibition(db, exh)!.current_version).toBe(1);
    expect(listVersions(db, exh).length).toBe(1);
    const snap = getVersion(db, exh, 1)!.snapshot as ReturnType<typeof buildSnapshot>;
    expect(snap.narrative!.title).toBe("版本一");
    expect(snap.user_edits.length).toBe(1);
    expect(snap.decisions.length).toBe(2);
    expect(snap.template).toBe("cinema_scroll");
    expect(snap.tone).toBe("restrained");
  });

  it("连续快照只保留最近 10 个", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    for (let i = 0; i < 12; i++) snapshotVersion(db, exh);
    const versions = listVersions(db, exh);
    expect(versions.length).toBe(10);
    expect(versions[0].version).toBe(12);
    expect(versions[versions.length - 1].version).toBe(3);
    expect(getExhibition(db, exh)!.current_version).toBe(12);
  });
});

describe("版本回滚 restoreVersion", () => {
  it("恢复叙事/编辑/锁定/主题改名/决定覆盖，并新增回滚版本", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = addPhoto(exh, "sha-a");
    const b = addPhoto(exh, "sha-b");
    decide(exh, a, "keep");
    decide(exh, b, "keep");
    replaceMotifs(db, exh, [
      Motif.parse({ title: "窗与背影", description: "框景反复出现。", photo_ids: [a, b], evidence: ["2 张框景"], confidence: 0.7 }),
      Motif.parse({ title: "冷光", description: "蓝色光线。", photo_ids: [a], evidence: ["1 张冷光"], confidence: 0.6 }),
    ]);
    const m1 = listMotifs(db, exh)[0].id;
    selectMotif(db, exh, m1, "我的窗");
    setUserOverride(db, exh, a, "must_keep", "必留");
    replaceNarrative(db, exh, makePlan("版本一", [a, b]), { source: "heuristic", inputVersion: 0, selectedMotifId: m1 });
    upsertEdit(db, exh, "narrative.title", "锁定标题", true);
    snapshotVersion(db, exh, "叙事生成");

    // 破坏性修改：改主题名、覆盖决定、换叙事、解锁改标题。
    updateMotif(db, exh, m1, { user_title: "改掉了" });
    setUserOverride(db, exh, a, "remove", "不要了");
    replaceNarrative(db, exh, makePlan("版本二", [a, b]), { source: "heuristic", inputVersion: 1, selectedMotifId: m1 });
    upsertEdit(db, exh, "narrative.title", "新标题", false);
    snapshotVersion(db, exh, "再次生成");
    expect(getNarrative(db, exh)!.title).toBe("版本二");

    const restored = restoreVersion(db, exh, 1);
    expect(restored).toBe(3);
    expect(getExhibition(db, exh)!.current_version).toBe(3);
    expect(getNarrative(db, exh)!.title).toBe("版本一");
    expect(getEdit(db, exh, "narrative.title")!.value).toBe("锁定标题");
    expect(getEdit(db, exh, "narrative.title")!.locked).toBe(true);
    expect(getMotif(db, m1)!.user_title).toBe("我的窗");
    expect(getMotif(db, m1)!.state).toBe("selected");
    expect(getExhibition(db, exh)!.selected_motif_id).toBe(m1);
    expect(getDecision(db, a)!.effective_decision).toBe("must_keep");
    expect(listVersions(db, exh)[0].label).toBe("回滚到版本 1");
  });

  it("未知版本 → 404 version_not_found", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    try {
      restoreVersion(db, exh, 99);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
      expect((e as ApiError).code).toBe("version_not_found");
    }
  });

  it("回滚到无叙事的早期版本 → 清空当前叙事", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = addPhoto(exh, "sha-a");
    const b = addPhoto(exh, "sha-b");
    decide(exh, a, "keep");
    decide(exh, b, "keep");
    snapshotVersion(db, exh, "空叙事"); // v1：尚无叙事
    replaceNarrative(db, exh, makePlan("后来才有", [a, b]), { source: "heuristic", inputVersion: 1 });
    snapshotVersion(db, exh, "有叙事"); // v2
    expect(getNarrative(db, exh)).not.toBeNull();
    restoreVersion(db, exh, 1);
    expect(getNarrative(db, exh)).toBeNull();
    expect(listEdits(db, exh).length).toBe(0);
  });
});

function layoutOf(template: "cinema_scroll" | "archive_collage", a: string, b: string): ExhibitionLayoutT {
  if (template === "archive_collage") {
    return ExhibitionLayout.parse({
      template,
      background: "#111111",
      text_color: "#eeeeee",
      sections: [
        { id: "s1", type: "image_pair", photo_ids: [a, b] },
        { id: "s2", type: "statement", text_override: "档案拼贴" },
      ],
    });
  }
  return ExhibitionLayout.parse({
    template,
    background: "#0b0b0d",
    text_color: "#f5f1e8",
    sections: [
      { id: "s1", type: "hero", photo_id: a },
      { id: "s2", type: "chapter_intro", chapter_id: "chapter_01" },
      { id: "s3", type: "ending", photo_ids: [b] },
    ],
  });
}

function ready(exh: string): { a: string; b: string } {
  const a = addPhoto(exh, "sha-a");
  const b = addPhoto(exh, "sha-b");
  decide(exh, a, "keep");
  decide(exh, b, "keep");
  replaceNarrative(db, exh, makePlan("布局版本", [a, b]), { source: "heuristic", inputVersion: 0 });
  return { a, b };
}

describe("R04 版本快照包含真实布局", () => {
  it("快照保存实际布局；A 模板 → B 模板 → 回滚 A 后布局与模板一致", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const { a, b } = ready(exh);
    replaceLayout(db, exh, layoutOf("cinema_scroll", a, b), { inputVersion: 0 });
    snapshotVersion(db, exh, "布局 A");
    expect((getVersion(db, exh, 1)!.snapshot as ReturnType<typeof buildSnapshot>).layout!.template).toBe("cinema_scroll");

    replaceLayout(db, exh, layoutOf("archive_collage", a, b), { inputVersion: 1 });
    updateExhibition(db, exh, { template: "archive_collage" });
    snapshotVersion(db, exh, "布局 B");
    expect(getLayout(db, exh)!.template).toBe("archive_collage");

    restoreVersion(db, exh, 1);
    const restored = getLayout(db, exh)!;
    expect(restored.template).toBe("cinema_scroll");
    expect(restored.sections.map((s) => s.type)).toEqual(["hero", "chapter_intro", "ending"]);
    expect(getExhibition(db, exh)!.template).toBe("cinema_scroll");
    expect(getNarrative(db, exh)!.title).toBe("布局版本");
  });

  it("旧快照 layout=null：删除当前布局并标记需重建（不保留另一模板成品）", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const { a, b } = ready(exh);
    updateExhibition(db, exh, { status: "awaiting_theme_choice" });
    const base = buildSnapshot(db, exh);
    insertVersion(db, exh, 1, { ...base, layout: null, selection_confirmed_photo_ids: null, selection_hold_policy: null });
    updateExhibition(db, exh, { current_version: 1 });
    replaceLayout(db, exh, layoutOf("archive_collage", a, b), { inputVersion: 1 });

    const next = restoreVersion(db, exh, 1);
    expect(next).toBe(2);
    expect(getLayout(db, exh)).toBeNull();
    expect(getExhibition(db, exh)!.stale_from).toBe("layout");
    expect(getExhibition(db, exh)!.selection_confirmed_revision).toBeNull();
    expect(getNarrative(db, exh)!.title).toBe("布局版本");
  });

  it("照片真正删除后回滚：布局/叙事/编辑不引用不存在的图片", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = addPhoto(exh, "sha-a");
    const b = addPhoto(exh, "sha-b");
    decide(exh, a, "keep");
    decide(exh, b, "keep");
    replaceNarrative(db, exh, makePlan("两章", [a, b]), { source: "heuristic", inputVersion: 0 });
    replaceLayout(db, exh, layoutOf("cinema_scroll", a, b), { inputVersion: 0 });
    upsertEdit(db, exh, `photo:${a}.membership`, "chapter_01", true);
    upsertEdit(db, exh, `chapter:chapter_01.photo_order`, [a], true);
    snapshotVersion(db, exh, "含 a 的版本");

    deletePhoto(db, a);
    bumpInputRevision(db, exh);
    const next = restoreVersion(db, exh, 1);
    expect(next).toBe(2);

    const layout = getLayout(db, exh)!;
    const refs = layout.sections.flatMap((s) => (s.type === "hero" || s.type === "single_image" ? [s.photo_id] : "photo_ids" in s ? s.photo_ids : []));
    expect(refs).not.toContain(a);
    expect(refs.every((id) => id === b)).toBe(true);
    const narrative = getNarrative(db, exh)!;
    expect(narrative.chapters.flatMap((c) => c.photo_ids)).not.toContain(a);
    expect(narrative.chapters.every((c) => c.photo_ids.length > 0)).toBe(true);
    expect(listEdits(db, exh).map((e) => e.target_path)).not.toContain(`photo:${a}.membership`);
    expect(getExhibition(db, exh)!.selection_confirmed_revision).toBeNull();
  });

  it("确认状态随快照恢复：保留集一致时重新有效，回滚推进 input_revision", () => {
    const exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const { a, b } = ready(exh);
    updateExhibition(db, exh, {
      status: "awaiting_theme_choice",
      selection_confirmed_revision: 1,
      selection_confirmed_photo_ids: JSON.stringify([a, b]),
      selection_hold_policy: "exclude",
    });
    snapshotVersion(db, exh, "已确认选片");

    setUserOverride(db, exh, b, "remove", "不要了");
    bumpInputRevision(db, exh);
    clearConfirmation(db, exh);
    const restored = restoreVersion(db, exh, 1);
    const after = getExhibition(db, exh)!;
    expect(restored).toBe(2);
    expect(after.input_revision).toBe(2);
    expect(after.selection_confirmed_revision).toBe(2);
    expect(after.selection_confirmed_photo_ids).toEqual([a, b]);
    expect(after.selection_hold_policy).toBe("exclude");
  });
});