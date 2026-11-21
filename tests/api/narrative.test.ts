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
import { upsertEdit, listEdits, getEdit } from "@/lib/db/edits";
import { listVersions } from "@/lib/db/versions";
import { createRun, updateRun, listRuns } from "@/lib/db/runs";
import { getRegenerationIntent } from "@/lib/db/regenerations";
import { snapshotVersion } from "@/lib/orchestrator/versions";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { CreateExhibitionInput, PhotoInspection, Motif, NarrativePlan } from "@/lib/agents/schemas";
import type { NarrativePlanT } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { GET as getNarrativeRoute, PATCH as patchNarrative } from "@/app/api/exhibitions/[id]/narrative/route";
import { POST as regenerate } from "@/app/api/exhibitions/[id]/narrative/regenerate/route";
import { POST as runNarrativeRoute } from "@/app/api/exhibitions/[id]/runs/narrative/route";
import { GET as getVersions } from "@/app/api/exhibitions/[id]/versions/route";
import { POST as restoreVersionRoute } from "@/app/api/exhibitions/[id]/versions/[version]/route";

let tmp: string;

function ctx(id: string, version?: string) {
  return { params: Promise.resolve(version ? { id, version } : { id }) };
}
function jsonReq(body: unknown, method = "POST") {
  return new Request("http://localhost/x", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedPhoto(exhId: string, opts: { tags?: string[]; subjects?: string[]; decision?: "keep" | "hold" | "remove" } = {}): string {
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
    color_temp: null, saturation: 0.3, subjects: opts.subjects ?? [], composition_tags: opts.tags ?? [],
    duplicate_group_id: null, processing_mode: "heuristic",
  }));
  upsertAiDecision(db, exhId, {
    photo_id: id, decision: opts.decision ?? "keep", score: 0.7, confidence: 0.6,
    reasons: ["t"], related_photo_ids: [], user_override_allowed: true,
  });
  return id;
}

function makePlan(title: string, ids: string[]): NarrativePlanT {
  const mid = Math.ceil(ids.length / 2);
  return NarrativePlan.parse({
    title, subtitle: "初始副标题", curatorial_statement: "初始策展语。",
    chapters: [
      { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: ids.slice(0, mid) },
      { id: "chapter_02", title: "留下", description: "观看收束。", photo_ids: ids.slice(mid) },
    ],
    tone: "restrained",
  });
}

function readyExh(title = "初始影展") {
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const ids = [
    seedPhoto(exhId, { tags: ["框景"] }),
    seedPhoto(exhId, { tags: ["背影"], subjects: ["人物背影"] }),
    seedPhoto(exhId, { tags: ["反光"], subjects: ["水面"] }),
  ];
  replaceMotifs(db, exhId, [Motif.parse({ title: "窗与背影", description: "d", photo_ids: ids, evidence: ["e"], confidence: 0.7 })]);
  const motifId = listMotifs(db, exhId)[0].id;
  selectMotif(db, exhId, motifId);
  replaceNarrative(db, exhId, makePlan(title, ids), { source: "heuristic", inputVersion: 0, selectedMotifId: motifId });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-narrative-api-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

function revision(exhId: string) {
  const n = getNarrative(getDb(), exhId)!;
  return { expected_version: getExhibition(getDb(), exhId)!.current_version, expected_edit_revision: n?.edit_revision ?? 0 };
}

describe("叙事原子编辑回归", () => {
  it("同生成版本的两个标签页只能有一个保存成功", async () => {
    const { exhId } = readyExh();
    const expected = revision(exhId);
    const save = (value: string) => patchNarrative(jsonReq({ ...expected, edits: [{ target_path: "narrative.title", value }] }, "PATCH"), ctx(exhId) as never);
    expect((await save("标签一")).status).toBe(200);
    const second = await save("标签二");
    expect(second.status).toBe(409);
    expect((await second.json()).error.message).toBe("内容已在其他操作中更新，你的草稿已保留，请查看最新内容后再保存。");
    expect(getNarrative(getDb(), exhId)!.title).toBe("标签一");
  });

  it("请求体解析期间发生重生成，拒绝旧请求而非使用 await 前的快照", async () => {
    const { exhId, ids } = readyExh();
    const expected = revision(exhId);
    const request = { json: async () => {
      replaceNarrative(getDb(), exhId, makePlan("刚生成", ids), { source: "heuristic", inputVersion: 0 });
      snapshotVersion(getDb(), exhId);
      return { ...expected, edits: [{ target_path: "narrative.title", value: "旧草稿" }] };
    } } as Request;
    expect((await patchNarrative(request, ctx(exhId) as never)).status).toBe(409);
    expect(getNarrative(getDb(), exhId)!.title).toBe("刚生成");
    expect(listEdits(getDb(), exhId)).toEqual([]);
  });

  it("必须同时提供生成版本和编辑修订，不允许省略绕过", async () => {
    const { exhId } = readyExh();
    for (const expected of [{}, { expected_version: 0 }, { expected_edit_revision: 0 }]) {
      expect((await patchNarrative(jsonReq({ ...expected, edits: [{ target_path: "narrative.title", value: "覆盖" }] }, "PATCH"), ctx(exhId) as never)).status).toBe(400);
    }
    expect(listEdits(getDb(), exhId)).toEqual([]);
  });

  it.each([
    { target_path: "chapter:missing.title", value: "无效章", locked: true },
    { target_path: "photo:missing.membership", value: "chapter_01", locked: true },
    { target_path: "narrative.chapter_order", value: ["chapter_01", "chapter_01"] },
    { target_path: "narrative.unknown", value: "无效字段" },
  ])("无效目标/引用拒绝且整批编辑回滚：%j", async (invalid) => {
    const { exhId } = readyExh();
    const before = getNarrative(getDb(), exhId);
    const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "不应落库" }, invalid] }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(422);
    expect(getNarrative(getDb(), exhId)).toEqual(before);
    expect(listEdits(getDb(), exhId)).toEqual([]);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBeNull();
  });

  it("保存失败回滚覆盖层、stale 和修订", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    const before = getNarrative(db, exhId);
    db.exec("CREATE TRIGGER fail_narrative BEFORE UPDATE ON narrative_plans BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    try {
      const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.chapter_order", value: ["chapter_02", "chapter_01"] }] }, "PATCH"), ctx(exhId) as never);
      expect(res.status).toBe(500);
      expect(listEdits(db, exhId)).toEqual([]);
      expect(getNarrative(db, exhId)).toEqual(before);
      expect(getExhibition(db, exhId)!.stale_from).toBeNull();
    } finally { db.exec("DROP TRIGGER fail_narrative"); }
  });

  it("普通 runs 拒绝请求时不提前写 tone", async () => {
    const { exhId } = readyExh();
    updateExhibition(getDb(), exhId, { selected_motif_id: null });
    const res = await runNarrativeRoute(jsonReq({ tone: "poetic" }), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect(getExhibition(getDb(), exhId)!.tone).toBe("restrained");
  });

  it("普通 runs 预留 preserve 意图，重复 id 不重复发布或改 tone", async () => {
    const { exhId } = readyExh();
    const first = await runNarrativeRoute(jsonReq({ tone: "poetic", request_id: "preserve_once" }), ctx(exhId) as never);
    const a = await first.json();
    expect(first.status).toBe(202);
    expect(getRegenerationIntent(getDb(), a.run_id)?.scope).toBe("preserve");
    await waitDone(exhId);
    const n = getNarrative(getDb(), exhId);
    const second = await runNarrativeRoute(jsonReq({ tone: "direct", request_id: "preserve_once" }), ctx(exhId) as never);
    expect((await second.json()).run_id).toBe(a.run_id);
    expect(getExhibition(getDb(), exhId)!.tone).toBe("poetic");
    expect(getNarrative(getDb(), exhId)).toEqual(n);
  });

  it("回滚版本快照写入失败时连同叙事修订全部回滚", async () => {
    const { exhId, ids } = readyExh();
    const db = getDb();
    snapshotVersion(db, exhId);
    replaceNarrative(db, exhId, makePlan("当前作品", ids), { source: "heuristic", inputVersion: 1 });
    const before = { narrative: getNarrative(db, exhId), exhibition: getExhibition(db, exhId), edits: listEdits(db, exhId), versions: listVersions(db, exhId) };
    db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON exhibition_versions BEGIN SELECT RAISE(ABORT, 'snapshot failed'); END");
    try {
      expect((await restoreVersionRoute(jsonReq({}), ctx(exhId, "1") as never)).status).toBe(500);
      expect({ narrative: getNarrative(db, exhId), exhibition: getExhibition(db, exhId), edits: listEdits(db, exhId), versions: listVersions(db, exhId) }).toEqual(before);
    } finally { db.exec("DROP TRIGGER fail_restore"); }
  });

  it("回滚到无叙事再生成也不会复位编辑修订", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    snapshotVersion(db, exhId);
    const ids = [seedPhoto(exhId), seedPhoto(exhId)];
    for (let i = 0; i < 5; i++) replaceNarrative(db, exhId, makePlan("旧作品", ids), { source: "heuristic", inputVersion: 1 });
    const old = getNarrative(db, exhId)!.edit_revision;
    expect((await restoreVersionRoute(jsonReq({}), ctx(exhId, "1") as never)).status).toBe(200);
    expect(getNarrative(db, exhId)).toBeNull();
    replaceNarrative(db, exhId, makePlan("新作品", ids), { source: "heuristic", inputVersion: 2 });
    expect(getNarrative(db, exhId)!.edit_revision).toBeGreaterThan(old);
  });

  it("回滚不恢复旧 edit_revision", async () => {
    const { exhId, ids } = readyExh();
    const db = getDb();
    snapshotVersion(db, exhId);
    replaceNarrative(db, exhId, makePlan("第二版", ids), { source: "heuristic", inputVersion: 1 });
    const prior = getNarrative(db, exhId)!.edit_revision;
    expect((await restoreVersionRoute(jsonReq({}), ctx(exhId, "1") as never)).status).toBe(200);
    expect(getNarrative(db, exhId)!.edit_revision).toBeGreaterThan(prior);
  });
});

describe("narrative GET (§11.9)", () => {
  it("返回当前叙事 + 编辑覆盖层", async () => {
    const { exhId } = readyExh();
    upsertEdit(getDb(), exhId, "narrative.title", "改过的标题", false);
    const res = await getNarrativeRoute(new Request("http://localhost/x"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const { narrative, edits } = await res.json();
    expect(narrative.title).toBe("初始影展");
    expect(edits.length).toBe(1);
    expect(edits[0].target_path).toBe("narrative.title");
  });

  it("影展不存在 → 404", async () => {
    const res = await getNarrativeRoute(new Request("http://localhost/x"), ctx("exh_nope") as never);
    expect(res.status).toBe(404);
  });
});

describe("narrative PATCH (§11.9)", () => {
  it("文本编辑 → 写覆盖层并立即合并进叙事", async () => {
    const { exhId } = readyExh();
    const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "我的标题" }] }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const { narrative } = await res.json();
    expect(narrative.title).toBe("我的标题");
    expect(getNarrative(getDb(), exhId)!.title).toBe("我的标题");
    expect(getEdit(getDb(), exhId, "narrative.title")!.value).toBe("我的标题");
  });

  it("锁定策展语 → locked=true 落覆盖层", async () => {
    const { exhId } = readyExh();
    const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.curatorial_statement", value: "锁定策展语。", locked: true }] }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(getEdit(getDb(), exhId, "narrative.curatorial_statement")!.locked).toBe(true);
    expect(getNarrative(getDb(), exhId)!.curatorial_statement).toBe("锁定策展语。");
  });

  it("章节重排 → stale_from=layout；纯文本编辑不改 stale", async () => {
    const { exhId } = readyExh();
    await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "文本" }] }, "PATCH"), ctx(exhId) as never);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBeNull();
    await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.chapter_order", value: ["chapter_02", "chapter_01"] }] }, "PATCH"), ctx(exhId) as never);
    expect(getExhibition(getDb(), exhId)!.stale_from).toBe("layout");
    expect(getNarrative(getDb(), exhId)!.chapters[0].id).toBe("chapter_02");
  });

  it("尚无叙事 → 409 no_narrative", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const ids = [seedPhoto(exhId, {}), seedPhoto(exhId, {})];
    replaceMotifs(db, exhId, [Motif.parse({ title: "m", description: "d", photo_ids: ids, evidence: ["e"], confidence: 0.7 })]);
    selectMotif(db, exhId, listMotifs(db, exhId)[0].id);
    const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "x" }] }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_narrative");
  });

  it("expected_version 过期 → 409 version_conflict，旧稿不覆盖新内容", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    const stale = getExhibition(db, exhId)!.current_version + 1;
    const res = await patchNarrative(
      jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "旧稿标题" }], expected_version: stale }, "PATCH"),
      ctx(exhId) as never,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("version_conflict");
    expect(getEdit(db, exhId, "narrative.title")).toBeNull();
    expect(getNarrative(db, exhId)!.title).toBe("初始影展");
  });

  it("expected_version 匹配 → 正常保存", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    const v = getExhibition(db, exhId)!.current_version;
    const res = await patchNarrative(
      jsonReq({ ...revision(exhId), edits: [{ target_path: "narrative.title", value: "新稿标题" }], expected_version: v }, "PATCH"),
      ctx(exhId) as never,
    );
    expect(res.status).toBe(200);
    expect(getNarrative(db, exhId)!.title).toBe("新稿标题");
  });

  it("空 edits → 400 validation_error", async () => {
    const { exhId } = readyExh();
    const res = await patchNarrative(jsonReq({ ...revision(exhId), edits: [] }, "PATCH"), ctx(exhId) as never);
    expect(res.status).toBe(400);
  });
});

describe("runs/narrative POST", () => {
  it("已选主题 → 202 + 叙事重生成 + 终点 awaiting_user_review（narrative→qa）", async () => {
    const { exhId } = readyExh();
    const res = await runNarrativeRoute(new Request("http://localhost/x", { method: "POST" }), ctx(exhId) as never);
    expect(res.status).toBe(202);
    const { run_id } = await res.json();
    expect(run_id).toBeTruthy();
    await waitDone(exhId);
    expect(getExhibition(getDb(), exhId)!.status).toBe("awaiting_user_review");
    expect(getNarrative(getDb(), exhId)).not.toBeNull();
  });

  it("未选主题 → 409 theme_not_selected", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    seedPhoto(exhId, {});
    seedPhoto(exhId, {});
    const res = await runNarrativeRoute(new Request("http://localhost/x", { method: "POST" }), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("theme_not_selected");
  });

  it("带 tone 重跑 → 更新语气且保留全部用户编辑（含非锁定标题，merge 回放）", async () => {
    const { exhId } = readyExh();
    upsertEdit(getDb(), exhId, "narrative.title", "我的标题", false);
    upsertEdit(getDb(), exhId, "narrative.curatorial_statement", "锁定策展语。", true);
    const res = await runNarrativeRoute(jsonReq({ tone: "poetic" }), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    const n = getNarrative(getDb(), exhId)!;
    expect(n.tone).toBe("poetic");
    expect(n.title).toBe("我的标题");
    expect(n.curatorial_statement).toBe("锁定策展语。");
    expect(getEdit(getDb(), exhId, "narrative.title")).not.toBeNull();
    expect(getEdit(getDb(), exhId, "narrative.curatorial_statement")!.locked).toBe(true);
  });
});

describe("narrative/regenerate POST (§提示词8)", () => {
  it("scope=unlocked + 改语气 → 丢弃非锁定编辑、保留锁定标题、语气更新", async () => {
    const { exhId } = readyExh();
    upsertEdit(getDb(), exhId, "narrative.title", "锁定标题", true);
    upsertEdit(getDb(), exhId, "narrative.subtitle", "用户副标题", false);
    const res = await regenerate(jsonReq({ scope: "unlocked", tone: "poetic" }), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    const n = getNarrative(getDb(), exhId)!;
    expect(n.title).toBe("锁定标题");
    expect(n.subtitle).not.toBe("用户副标题");
    expect(n.tone).toBe("poetic");
    expect(getEdit(getDb(), exhId, "narrative.subtitle")).toBeNull();
    expect(getEdit(getDb(), exhId, "narrative.title")!.locked).toBe(true);
  });

  it("scope=all → 连锁定编辑一并丢弃（用户显式动作）", async () => {
    const { exhId } = readyExh();
    upsertEdit(getDb(), exhId, "narrative.title", "锁定标题", true);
    const res = await regenerate(jsonReq({ scope: "all" }), ctx(exhId) as never);
    expect(res.status).toBe(202);
    await waitDone(exhId);
    expect(listEdits(getDb(), exhId).length).toBe(0);
    expect(getNarrative(getDb(), exhId)!.title).not.toBe("锁定标题");
  });
});

describe("R01 重新生成：拒绝/失败不丢编辑与语气（v3）", () => {
  it("运行中 → 409，编辑与语气完全不变", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    upsertEdit(db, exhId, "narrative.title", "锁定标题", true);
    upsertEdit(db, exhId, "narrative.subtitle", "草稿副标题", false);
    const blocker = createRun(db, {
      exhibitionId: exhId, agentType: "material_steward", status: "running", inputVersion: 0,
    });
    try {
      const res = await regenerate(jsonReq({ scope: "all", tone: "poetic" }), ctx(exhId) as never);
      expect(res.status).toBe(409);
      expect(getExhibition(db, exhId)!.tone).toBe("restrained");
      expect(listEdits(db, exhId).length).toBe(2);
      expect(getEdit(db, exhId, "narrative.subtitle")!.value).toBe("草稿副标题");
      expect(listRuns(db, exhId).some((r) => r.agent_type === "narrative_editor")).toBe(false);
    } finally {
      updateRun(db, blocker.id, { status: "failed", error_message: "test cleanup" });
    }
  });

  it("主题未选 → 409，编辑与语气不变", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    upsertEdit(db, exhId, "narrative.title", "想保留的编辑", false);
    updateExhibition(db, exhId, { selected_motif_id: null });
    const res = await regenerate(jsonReq({ scope: "all", tone: "poetic" }), ctx(exhId) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("theme_not_selected");
    expect(getExhibition(db, exhId)!.tone).toBe("restrained");
    expect(listEdits(db, exhId).length).toBe(1);
    expect(getNarrative(db, exhId)!.title).toBe("初始影展");
  });

  it("叙事阶段失败 → 旧叙事/编辑/语气原样，意图不生效", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    upsertEdit(db, exhId, "narrative.title", "锁定标题", true);
    upsertEdit(db, exhId, "narrative.subtitle", "草稿副标题", false);
    updateExhibition(db, exhId, { mode: "ai" });
    const res = await regenerate(
      jsonReq({ scope: "all", tone: "poetic", request_id: "req_regen_fail" }),
      ctx(exhId) as never,
    );
    expect(res.status).toBe(202);
    const { run_id } = await res.json();
    await waitDone(exhId);
    expect(getExhibition(db, exhId)!.status).toBe("stage_failed");
    expect(getExhibition(db, exhId)!.tone).toBe("restrained");
    expect(listEdits(db, exhId).length).toBe(2);
    expect(getNarrative(db, exhId)!.title).toBe("初始影展");
    expect(getRegenerationIntent(db, run_id)!.state).toBe("pending");
  });

  it("同一 request_id 重发只有一次任务、一个意图", async () => {
    const { exhId } = readyExh();
    const db = getDb();
    upsertEdit(db, exhId, "narrative.title", "锁定标题", true);
    const first = await regenerate(jsonReq({ scope: "unlocked", request_id: "req_regen_once" }), ctx(exhId) as never);
    const second = await regenerate(jsonReq({ scope: "unlocked", request_id: "req_regen_once" }), ctx(exhId) as never);
    const a = await first.json();
    const b = await second.json();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(b.run_id).toBe(a.run_id);
    expect(b.workflow_id).toBe(a.workflow_id);
    await waitDone(exhId);
    const n = db.prepare("SELECT COUNT(*) AS n FROM narrative_regenerations WHERE exhibition_id=?").get(exhId) as { n: number };
    expect(n.n).toBe(1);
    expect(getRegenerationIntent(db, a.run_id)!.state).toBe("applied");
    // 成功后锁定编辑保留
    expect(getEdit(db, exhId, "narrative.title")!.locked).toBe(true);
  });
});

describe("versions GET / restore (§10.11)", () => {
  it("GET 返回版本摘要（不含 snapshot）", async () => {
    const { exhId } = readyExh();
    snapshotVersion(getDb(), exhId, "v1");
    const res = await getVersions(new Request("http://localhost/x"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const { versions } = await res.json();
    expect(versions.length).toBe(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot).toBeUndefined();
  });

  it("restore → 单事务恢复叙事并新增回滚版本", async () => {
    const { exhId, ids } = readyExh("版本一");
    snapshotVersion(getDb(), exhId, "v1");
    replaceNarrative(getDb(), exhId, makePlan("版本二", ids), { source: "heuristic", inputVersion: 1 });
    snapshotVersion(getDb(), exhId, "v2");
    expect(getNarrative(getDb(), exhId)!.title).toBe("版本二");

    const res = await restoreVersionRoute(new Request("http://localhost/x", { method: "POST" }), ctx(exhId, "1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(3);
    expect(getNarrative(getDb(), exhId)!.title).toBe("版本一");
    expect(getExhibition(getDb(), exhId)!.current_version).toBe(3);
    expect(listVersions(getDb(), exhId)[0].label).toBe("回滚到版本 1");
  });

  it("restore 未知版本 → 404", async () => {
    const { exhId } = readyExh();
    const res = await restoreVersionRoute(new Request("http://localhost/x", { method: "POST" }), ctx(exhId, "99") as never);
    expect(res.status).toBe(404);
  });
});