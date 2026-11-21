import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { replaceMotifs, listMotifs, selectMotif } from "@/lib/db/motifs";
import { replaceNarrative, getNarrative } from "@/lib/db/narrative";
import { getLayout } from "@/lib/db/layout";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { CreateExhibitionInput, PhotoInspection, Motif, NarrativePlan, ExhibitionLayout } from "@/lib/agents/schemas";
import type { NarrativePlanT } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { POST as runLayoutRoute } from "@/app/api/exhibitions/[id]/runs/layout/route";
import { GET as getLayoutRoute } from "@/app/api/exhibitions/[id]/layout/route";
import { GET as getPreviewRoute } from "@/app/api/exhibitions/[id]/preview/route";
import { PATCH as patchExhibition } from "@/app/api/exhibitions/[id]/route";

let tmp: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function jsonReq(body: unknown, method = "POST") {
  return new Request("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function seedPhoto(exhId: string, subjects: string[] = []): string {
  const db = getDb();
  const id = newId("photo");
  insertPhotoAsset(db, {
    id, exhibition_id: exhId, original_name: "x.jpg",
    storage_path: `uploads/${exhId}/${id}.jpg`, thumbnail_path: null,
    width: 100, height: 80, mime_type: "image/jpeg", file_size: 1000,
    sha256: newId("sha"), sort_order: 0,
  });
  upsertInspection(db, PhotoInspection.parse({
    photo_id: id, sharpness_score: 0.7, laplacian_var: 100, brightness_score: 0.5,
    highlight_clip_ratio: 0.02, shadow_clip_ratio: 0.05, dominant_colors: ["#465a82"],
    color_temp: null, saturation: 0.3, subjects, composition_tags: [],
    duplicate_group_id: null, processing_mode: "heuristic",
  }));
  upsertAiDecision(db, exhId, {
    photo_id: id, decision: "keep", score: 0.7, confidence: 0.6,
    reasons: ["t"], related_photo_ids: [], user_override_allowed: true,
  });
  return id;
}

function makePlan(ids: string[]): NarrativePlanT {
  const mid = Math.ceil(ids.length / 2);
  return NarrativePlan.parse({
    title: "在光线转弯之前", subtitle: "副标题", curatorial_statement: "窗与光线反复出现。",
    chapters: [
      { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: ids.slice(0, mid), opening_photo_id: ids[0] },
      { id: "chapter_02", title: "留下", description: "观看收束。", photo_ids: ids.slice(mid), closing_photo_id: ids[ids.length - 1] },
    ],
    tone: "restrained",
  });
}

function readyExh(withNarrative = true) {
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const ids = [seedPhoto(exhId, ["窗"]), seedPhoto(exhId, ["背影"]), seedPhoto(exhId, ["反光"]), seedPhoto(exhId, ["广场"])];
  replaceMotifs(db, exhId, [Motif.parse({ title: "窗与背影", description: "d", photo_ids: ids, evidence: ["e"], confidence: 0.7 })]);
  const motifId = listMotifs(db, exhId)[0].id;
  selectMotif(db, exhId, motifId);
  if (withNarrative) replaceNarrative(db, exhId, makePlan(ids), { source: "heuristic", inputVersion: 0, selectedMotifId: motifId });
  // 已有生成结果的影展不应停留在 draft（draft 不标记 stale）。
  updateExhibition(db, exhId, { status: "awaiting_user_review" });
  return { exhId, ids, motifId };
}

async function waitDone(exhId: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (isRunning(getDb(), exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-layout-api-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("runs/layout POST", () => {
  it("无叙事 → 409 narrative_not_ready", async () => {
    const { exhId } = readyExh(false);
    const res = await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("narrative_not_ready");
  });

  it("有叙事 → 202，落库布局通过校验，状态进入 awaiting_user_review（layout→qa）", async () => {
    const { exhId } = readyExh();
    const res = await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    const layout = getLayout(getDb(), exhId)!;
    expect(layout).toBeTruthy();
    expect(() => ExhibitionLayout.parse(layout)).not.toThrow();
    expect(layout.template).toBe(getExhibition(getDb(), exhId)!.template);
    expect(getExhibition(getDb(), exhId)!.status).toBe("awaiting_user_review");
    expect(getExhibition(getDb(), exhId)!.stale_from).toBeNull();
  });
});

describe("layout GET + preview GET", () => {
  it("尚未布局 → layout null；preview 仍返回 exhibition/narrative/photos", async () => {
    const { exhId } = readyExh();
    const lres = await getLayoutRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    expect((await lres.json()).layout).toBeNull();
    const pres = await getPreviewRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    const bundle = await pres.json();
    expect(bundle.exhibition.id).toBe(exhId);
    expect(bundle.narrative.title).toBe("在光线转弯之前");
    expect(bundle.layout).toBeNull();
    expect(bundle.photos.length).toBe(4);
  });

  it("布局后 preview bundle 含 layout", async () => {
    const { exhId } = readyExh();
    await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    const pres = await getPreviewRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    const bundle = await pres.json();
    expect(bundle.layout.sections.length).toBeGreaterThan(0);
    expect(bundle.photos[0].width).toBe(100);
  });
});

describe("换模板（仅 layout，照片/叙事不变）", () => {
  it("PATCH template → stale_from=layout", async () => {
    const { exhId } = readyExh();
    const res = await patchExhibition(jsonReq({ template: "archive_collage" }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const exh = getExhibition(getDb(), exhId)!;
    expect(exh.template).toBe("archive_collage");
    expect(exh.stale_from).toBe("layout");
  });

  it("PATCH 仅标题 → 不标记 stale", async () => {
    const { exhId } = readyExh();
    await patchExhibition(jsonReq({ title: "新标题" }, "PATCH"), ctx(exhId) as never);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBeNull();
  });

  it("换模板重跑 layout → 模板更新但叙事/照片不变", async () => {
    const { exhId, ids } = readyExh();
    await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    const before = getNarrative(getDb(), exhId)!;
    await patchExhibition(jsonReq({ template: "archive_collage" }, "PATCH"), ctx(exhId) as never);
    await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    const layout = getLayout(getDb(), exhId)!;
    expect(layout.template).toBe("archive_collage");
    expect(layout.background).toBe("#f5f1e8");
    const after = getNarrative(getDb(), exhId)!;
    expect(after.chapters).toEqual(before.chapters);
    expect(after.title).toBe(before.title);
    expect(getLayout(getDb(), exhId)!.sections.length).toBeGreaterThan(0);
    expect(ids.length).toBe(4);
  });
});