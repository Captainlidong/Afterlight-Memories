import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { uploadsDir } from "@/lib/files";
import { setUserOverride } from "@/lib/db/curation";
import { POST as confirmSelection } from "@/app/api/exhibitions/[id]/curation/confirm/route";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition, updateExhibition } from "@/lib/db/repos";
import { insertPhotoAsset, upsertInspection, listInspections } from "@/lib/db/photos";
import { upsertAiDecision } from "@/lib/db/curation";
import { replaceMotifs, listMotifs, selectMotif } from "@/lib/db/motifs";
import { replaceNarrative, getNarrative } from "@/lib/db/narrative";
import { getLayout, replaceLayout } from "@/lib/db/layout";
import { getQa } from "@/lib/db/qa";
import { listRuns } from "@/lib/db/runs";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { CreateExhibitionInput, PhotoInspection, Motif, NarrativePlan, ExhibitionLayout } from "@/lib/agents/schemas";
import type { NarrativePlanT, ExhibitionLayoutT } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { POST as runLayoutRoute } from "@/app/api/exhibitions/[id]/runs/layout/route";
import { POST as runNarrativeRoute } from "@/app/api/exhibitions/[id]/runs/narrative/route";
import { POST as runMotifsRoute } from "@/app/api/exhibitions/[id]/runs/motifs/route";
import { POST as selectMotifRoute } from "@/app/api/exhibitions/[id]/motifs/select/route";
import { POST as runQaRoute } from "@/app/api/exhibitions/[id]/runs/qa/route";
import { POST as retryRoute } from "@/app/api/exhibitions/[id]/runs/retry/route";
import { POST as rerunRoute } from "@/app/api/exhibitions/[id]/rerun/route";
import { GET as getQaRoute } from "@/app/api/exhibitions/[id]/qa/route";
import { POST as ignoreRoute } from "@/app/api/exhibitions/[id]/qa/issues/[issueId]/ignore/route";
import { POST as fixRoute } from "@/app/api/exhibitions/[id]/qa/issues/[issueId]/fix/route";
import { DELETE as deletePhoto } from "@/app/api/exhibitions/[id]/photos/[photoId]/route";
import { PATCH as patchExhibition } from "@/app/api/exhibitions/[id]/route";

let tmp: string;

function ctx(id: string, issueId?: string) {
  return { params: Promise.resolve(issueId ? { id, issueId } : { id }) };
}
function jsonReq(body: unknown, method = "POST") {
  return new Request("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function seedPhoto(exhId: string, subjects: string[], tags: string[]): string {
  const db = getDb();
  const id = newId("photo");
  insertPhotoAsset(db, {
    id, exhibition_id: exhId, original_name: "x.jpg",
    storage_path: `uploads/${exhId}/${id}.jpg`, thumbnail_path: null,
    width: 1600, height: 1000, mime_type: "image/jpeg", file_size: 1000,
    sha256: newId("sha"), sort_order: 0,
  });
  upsertInspection(db, PhotoInspection.parse({
    photo_id: id, sharpness_score: 0.7, laplacian_var: 100, brightness_score: 0.5,
    highlight_clip_ratio: 0.02, shadow_clip_ratio: 0.05, dominant_colors: ["#465a82"],
    color_temp: null, saturation: 0.3, subjects, composition_tags: tags,
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

function readyExh(titles: [string, string] = ["反复出现的框景与窗", "反复出现的背影"]) {
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const ids = [
    seedPhoto(exhId, ["窗"], ["框景"]),
    seedPhoto(exhId, ["窗"], ["框景"]),
    seedPhoto(exhId, ["人物背影"], ["背影"]),
    seedPhoto(exhId, ["人物背影"], ["背影"]),
  ];
  replaceMotifs(db, exhId, [
    Motif.parse({ title: titles[0], description: "d", photo_ids: ids, evidence: ["e"], confidence: 0.7 }),
    Motif.parse({ title: titles[1], description: "d", photo_ids: ids, evidence: ["e"], confidence: 0.6 }),
  ]);
  const motifId = listMotifs(db, exhId)[0].id;
  selectMotif(db, exhId, motifId);
  replaceNarrative(db, exhId, makePlan(ids), { source: "heuristic", inputVersion: 0, selectedMotifId: motifId });
  // 模拟已走完确认选片门的影展（draft 不标记 stale；未确认会被 gateCeiling 截断）。
  updateExhibition(db, exhId, { status: "awaiting_user_review", selection_confirmed_revision: 1 });
  return { exhId, ids, motifId };
}

/** 注入跨 section 重复引用的布局 → repetition（high, auto_fix）；插在 statement 前保持结尾完整。 */
function injectDupLayout(exhId: string): ExhibitionLayoutT {
  const layout = getLayout(getDb(), exhId)!;
  const hero = layout.sections.find((s) => s.type === "hero")!;
  const at = layout.sections.findIndex((s) => s.type === "statement");
  const sections = [...layout.sections];
  sections.splice(at, 0, { id: "dup_extra", type: "single_image", photo_id: (hero as { photo_id: string }).photo_id, size: "large", spacing: "medium" });
  const dup: ExhibitionLayoutT = { ...layout, sections };
  replaceLayout(getDb(), exhId, ExhibitionLayout.parse(dup), { inputVersion: 0 });
  return dup;
}

async function waitDone(exhId: string, timeout = 10000): Promise<void> {
  const start = Date.now();
  while (isRunning(getDb(), exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fullFlow(exhId: string) {
  await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
  await waitDone(exhId);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-qa-api-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("runs/qa + 管线终点接线", () => {
  it("无布局 → 409 layout_not_ready", async () => {
    const { exhId } = readyExh();
    const res = await runQaRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("layout_not_ready");
  });

  it("runs/layout 现在 layout→qa：状态 awaiting_user_review + curatorial_qa completed + 报告落库", async () => {
    const { exhId } = readyExh();
    const res = await runLayoutRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    expect(getExhibition(getDb(), exhId)!.status).toBe("awaiting_user_review");
    const qaRun = listRuns(getDb(), exhId).find((r) => r.agent_type === "curatorial_qa");
    expect(qaRun?.status).toBe("completed");
    const qa = getQa(getDb(), exhId)!;
    expect(qa.status).toBe("passed");
    expect(qa.issues.some((i) => i.type === "privacy_hint")).toBe(true);
    expect(qa.passed_checks.length).toBeGreaterThan(0);
  });

  it("runs/narrative 现在 narrative→qa：终点 awaiting_user_review", async () => {
    const { exhId } = readyExh();
    await fullFlow(exhId);
    const res = await runNarrativeRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    expect(getExhibition(getDb(), exhId)!.status).toBe("awaiting_user_review");
    expect(getQa(getDb(), exhId)).not.toBeNull();
  });

  it("qa GET：未质检 → qa null；质检后 → 完整 DTO", async () => {
    const { exhId } = readyExh();
    const before = await getQaRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    expect((await before.json()).qa).toBeNull();
    await fullFlow(exhId);
    const after = await getQaRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    const body = await after.json();
    expect(body.qa.exhibition_id).toBe(exhId);
    expect(Array.isArray(body.qa.issues)).toBe(true);
    expect(Array.isArray(body.qa.ignored_keys)).toBe(true);
  });
});

describe("忽略 / 自动修复", () => {
  it("ignore 持久化跨重跑；undo 恢复；status 随活跃问题重算", async () => {
    const { exhId } = readyExh();
    await fullFlow(exhId);
    injectDupLayout(exhId);
    await runQaRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    let qa = getQa(getDb(), exhId)!;
    const rep = qa.issues.find((i) => i.type === "repetition")!;
    expect(rep).toBeTruthy();
    expect(qa.status).toBe("needs_review");

    const ig = await ignoreRoute(jsonReq({}), ctx(exhId, rep.id) as never);
    expect(ig.status).toBe(200);
    qa = (await ig.json()).qa;
    expect(qa.issues.some((i) => i.type === "repetition")).toBe(false);
    expect(qa.status).toBe("passed");
    expect(qa.ignored_issues.some((i) => i.id === rep.id)).toBe(true);

    // 重跑质检 → 忽略键延续。
    await runQaRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    qa = getQa(getDb(), exhId)!;
    expect(qa.issues.some((i) => i.type === "repetition")).toBe(false);
    expect(qa.status).toBe("passed");

    // undo → 问题回到活跃列表。
    const un = await ignoreRoute(jsonReq({ ignored: false }), ctx(exhId, rep.id) as never);
    qa = (await un.json()).qa;
    expect(qa.issues.some((i) => i.type === "repetition")).toBe(true);
    expect(qa.status).toBe("needs_review");
  });

  it("fix 修复 repetition：布局引用唯一 + 报告刷新", async () => {
    const { exhId } = readyExh();
    await fullFlow(exhId);
    injectDupLayout(exhId);
    await runQaRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    const rep = getQa(getDb(), exhId)!.issues.find((i) => i.type === "repetition")!;
    const res = await fixRoute(jsonReq({}), ctx(exhId, rep.id) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    const refs: string[] = [];
    for (const s of body.layout.sections as ExhibitionLayoutT["sections"]) {
      if (s.type === "hero" || s.type === "single_image") refs.push(s.photo_id);
      else if (s.type === "image_pair" || s.type === "image_group" || s.type === "ending") refs.push(...s.photo_ids);
    }
    expect(new Set(refs).size).toBe(refs.length);
    expect(body.qa.issues.some((i: { type: string }) => i.type === "repetition")).toBe(false);
    expect(getLayout(getDb(), exhId)!.sections.some((s) => s.id === "dup_extra")).toBe(false);
  });

  it("fix 不可自动修复的 issue → 400 not_auto_fixable；未知 issue → 404", async () => {
    const { exhId } = readyExh();
    await fullFlow(exhId);
    const hint = getQa(getDb(), exhId)!.issues.find((i) => i.type === "privacy_hint")!;
    const res = await fixRoute(jsonReq({}), ctx(exhId, hint.id) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("not_auto_fixable");
    const missing = await fixRoute(jsonReq({}), ctx(exhId, "qa_nope_1") as never);
    expect(missing.status).toBe(404);
  });
});

describe("重跑矩阵接线：rerun / retry", () => {
  it("删照片 → stale_from=motifs → POST rerun 跑 motifs→qa，选择延续、叙事剔除、stale 清空", async () => {
    const { exhId, ids } = readyExh();
    // 选「背影」主线：删一张窗照片后该聚类仍成立 → 选择延续，管线可跑完。
    const back = listMotifs(getDb(), exhId).find((m) => m.title === "反复出现的背影")!;
    selectMotif(getDb(), exhId, back.id);
    await fullFlow(exhId);
    const del = await deletePhoto(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ id: exhId, photoId: ids[0] }) } as never);
    expect(del.status).toBe(200);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBe("motifs");

    const res = await rerunRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    const exh = getExhibition(getDb(), exhId)!;
    expect(exh.status).toBe("awaiting_user_review");
    expect(exh.stale_from).toBeNull();
    expect(exh.selected_motif_id).not.toBeNull();
    const narrative = getNarrative(getDb(), exhId)!;
    for (const ch of narrative.chapters) expect(ch.photo_ids).not.toContain(ids[0]);
    const agents = listRuns(getDb(), exhId).map((r) => r.agent_type);
    expect(agents).toContain("motif_finder");
    expect(agents).toContain("curatorial_qa");
    expect(getQa(getDb(), exhId)).not.toBeNull();
  });

  it("重跑中已选主线消失 → 停在主题门（非 stage_failed），重选后 rerun 补齐 narrative→qa", async () => {
    const { exhId, ids } = readyExh(); // 默认选「框景与窗」主线
    await fullFlow(exhId);
    await deletePhoto(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ id: exhId, photoId: ids[0] }) } as never);
    await rerunRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    const stopped = getExhibition(getDb(), exhId)!;
    expect(stopped.status).toBe("awaiting_theme_choice");
    expect(stopped.failed_stage).toBeNull();
    expect(stopped.selected_motif_id).toBeNull();
    const skipped = listRuns(getDb(), exhId).filter((r) => r.status === "skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(3); // narrative/layout/qa 被跳过

    const motif = listMotifs(getDb(), exhId)[0];
    await selectMotifRoute(jsonReq({ motif_id: motif.id }), ctx(exhId) as never);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBe("narrative");
    await rerunRoute(jsonReq({}), ctx(exhId) as never);
    await waitDone(exhId);
    expect(getExhibition(getDb(), exhId)!.status).toBe("awaiting_user_review");
    expect(getQa(getDb(), exhId)).not.toBeNull();
  });

  it("无 stale → rerun 409 nothing_stale", async () => {
    const { exhId } = readyExh();
    await fullFlow(exhId);
    const res = await rerunRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("nothing_stale");
  });

  it("ai 失败保留结果；切回 demo 重新分析与确认，再选择主线完成", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "ai").id;
    updateExhibition(db, exhId, { selection_confirmed_revision: 1 });
    fs.mkdirSync(uploadsDir(exhId), { recursive: true });
    for (let i = 0; i < 4; i++) {
      const pid = seedPhoto(exhId, ["窗"], ["框景"]);
      const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 50 + i * 40, g: 100, b: 160 } } }).jpeg().toBuffer();
      fs.writeFileSync(path.join(uploadsDir(exhId), `${pid}.jpg`), jpeg);
      setUserOverride(db, exhId, pid, "must_keep");
    }
    const res = await runMotifsRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    const failed = getExhibition(db, exhId)!;
    expect(failed.status).toBe("stage_failed");
    expect(failed.failed_stage).toBe("motifs");
    expect(listMotifs(db, exhId).length).toBe(0);
    expect(listInspections(db, exhId).length).toBe(4); // 前阶段结果不动

    const noRetry = await retryRoute(jsonReq({}), ctx(exhId) as never);
    expect(noRetry.status).toBe(202); // failed_stage 存在 → 仍 ai → 再次失败
    await waitDone(exhId);
    expect(getExhibition(db, exhId)!.failed_stage).toBe("motifs");

    await patchExhibition(jsonReq({ mode: "demo" }, "PATCH"), ctx(exhId) as never);
    const retry = await retryRoute(jsonReq({}), ctx(exhId) as never);
    expect(retry.status).toBe(202);
    await waitDone(exhId);
    expect(getExhibition(db, exhId)!.status).toBe("awaiting_selection_confirm");
    expect(listRuns(db, exhId).some((run) => run.agent_type === "material_steward" && run.status === "completed")).toBe(true);
    const confirmed = await confirmSelection(jsonReq({ expected_revision: getExhibition(db, exhId)!.input_revision, hold_policy: "exclude", discover_motifs: true, request_id: "mode-change-confirm" }), ctx(exhId));
    expect(confirmed.status).toBe(200);
    await waitDone(exhId);
    expect(getExhibition(db, exhId)!.status).toBe("awaiting_theme_choice");
    expect(listMotifs(db, exhId).length).toBeGreaterThanOrEqual(2);

    const motif = listMotifs(db, exhId)[0];
    const sel = await selectMotifRoute(jsonReq({ motif_id: motif.id }), ctx(exhId) as never);
    expect(sel.status).toBe(200);
    const narr = await runNarrativeRoute(jsonReq({}), ctx(exhId) as never);
    expect(narr.status).toBe(202);
    await waitDone(exhId);
    const exh = getExhibition(db, exhId)!;
    expect(exh.status).toBe("awaiting_user_review");
    expect(exh.failed_stage).toBeNull();
    expect(getQa(db, exhId)).not.toBeNull();
  });

  it("无 failed_stage → retry 409 no_failed_stage", async () => {
    const { exhId } = readyExh();
    const res = await retryRoute(jsonReq({}), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_failed_stage");
  });
});