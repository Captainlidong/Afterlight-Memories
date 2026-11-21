import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { createAiVisionAdapter } from "@/lib/adapters/aiVisionAdapter";
import type { VisionInput } from "@/lib/adapters/types";
import { prepareForAi, type PreparedVisionImage } from "@/lib/image/prepareForAi";
import { loadAiConfig } from "@/lib/ai/config";
import { listAiCalls } from "@/lib/ai/records";
import { insertPhotoAsset } from "@/lib/db/photos";
import { AiInvalidResponseError, AiUnauthorizedError } from "@/lib/ai/errors";

const FACTS = {
  summary: "一扇窗边有一个背对镜头的人。",
  subjects: ["窗", "人物背影"],
  composition_tags: ["框景"],
  light_tags: ["侧光"],
  spatial_relations: ["人物靠近窗边"],
  evidence: [
    { kind: "observation", text: "人物没有正面朝向镜头" },
    { kind: "interpretation", text: "留白形成安静的观看感受" },
  ],
  uncertainties: ["无法判断人物与拍摄者的关系"],
};

function response(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200 },
  );
}

describe("aiVisionAdapter（V05/V08/V14）", () => {
  let db: DatabaseSync;
  let exhibitionId: string;
  let image: PreparedVisionImage;

  beforeEach(async () => {
    db = createDb(":memory:");
    exhibitionId = createExhibition(
      db,
      CreateExhibitionInput.parse({ allow_external_ai: true }),
      "ai",
    ).id;
    insertPhotoAsset(db, { id: "photo_1", exhibition_id: exhibitionId, original_name: "synthetic.jpg",
      storage_path: "unused-synthetic.jpg", thumbnail_path: null, width: 96, height: 64,
      mime_type: "image/jpeg", file_size: 1, sha256: "original-sha", sort_order: 0 });
    image = await prepareForAi(
      await sharp({
        create: { width: 96, height: 64, channels: 3, background: { r: 50, g: 80, b: 120 } },
      }).jpeg().toBuffer(),
      { maxEdge: 1280 },
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function config(cache = true) {
    return loadAiConfig({
      NODE_ENV: "test",
      AI_API_KEY: "sk-test-only-123456",
      AI_BASE_URL: "https://api.example.com/v1",
      AI_VISION_MODEL: "vision-x",
      AI_MAX_RETRIES: "0",
      AI_CACHE_ENABLED: String(cache),
    } as NodeJS.ProcessEnv);
  }

  function input(overrides: Partial<VisionInput> = {}): VisionInput {
    return {
      photoId: "photo_1",
      exhibitionId,
      workflowId: "wf_vision",
      sha256: "original-sha",
      image,
      metrics: {
        sharpness_score: 0.7,
        brightness_score: 0.5,
        highlight_clip_ratio: 0.01,
        shadow_clip_ratio: 0.02,
        color_temp: -0.1,
        saturation: 0.3,
        dominant_colors: ["#325078"],
      },
      ...overrides,
    };
  }

  it("请求体包含真实 Base64 图片，解码字节与分析副本一致，不包含本地 URL 或路径", async () => {
    let captured = "";
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return response(FACTS);
    });
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    const result = await adapter.describePhoto(input());
    const body = JSON.parse(captured);
    const user = body.messages[1].content;
    const imagePart = user.find((p: { type: string }) => p.type === "image_url");

    expect(imagePart.image_url.url).toBe(`data:image/jpeg;base64,${image.bytes.toString("base64")}`);
    expect(Buffer.from(imagePart.image_url.url.split(",")[1], "base64").equals(image.bytes)).toBe(true);
    expect(captured).not.toContain("localhost");
    expect(captured).not.toContain("data/uploads");
    expect(result).toMatchObject({
      processing_mode: "ai",
      visual_facts: FACTS,
      visual_source: "fresh",
      analysis_image_sha256: image.sha256,
    });
    expect(listAiCalls(db, { scopeId: "wf_vision" })[0].preprocess_version).toBe(image.preprocessVersion);
  });

  it("相同分析图第二次命中缓存；改变实际分析图后重新外发", async () => {
    const transport = vi.fn(async () => response(FACTS));
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    await adapter.describePhoto(input());
    const cached = await adapter.describePhoto(input());
    expect(cached.visual_source).toBe("cache");
    expect(transport).toHaveBeenCalledTimes(1);

    const changedBytes = await sharp(image.bytes).modulate({ brightness: 1.1 }).jpeg().toBuffer();
    const changedImage = await prepareForAi(changedBytes, { maxEdge: 1280 });
    await adapter.describePhoto(input({ image: changedImage }));
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("跨 workflow 复用并返回原 call_id provenance", async () => {
    const transport = vi.fn(async () => response(FACTS));
    const first = await createAiVisionAdapter({ db, config: config(), transport }).describePhoto(input());
    const second = await createAiVisionAdapter({ db, config: { ...config(), textModel: "changed-text" }, transport })
      .describePhoto(input({ workflowId: "wf_retry" }));
    expect(second.visual_source).toBe("cache");
    expect(second).toHaveProperty("provenance.call_id", listAiCalls(db)[0].id);
    expect(first).toHaveProperty("provenance.call_id", listAiCalls(db)[0].id);
    expect(second.source_call_id).toBe(first.source_call_id);
    expect(first.source_call_id).toBe(listAiCalls(db)[0].id);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["deleted", "replaced", "other-exhibition"])("缓存命中前仍检查照片 %s", async (kind) => {
    const transport = vi.fn(async () => response(FACTS));
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    await adapter.describePhoto(input());
    if (kind === "deleted") db.prepare("DELETE FROM photo_assets WHERE id='photo_1'").run();
    if (kind === "replaced") db.prepare("UPDATE photo_assets SET sha256='changed' WHERE id='photo_1'").run();
    const request = input(kind === "other-exhibition" ? { photoId: "missing-photo" } : {});
    await expect(adapter.describePhoto(request)).rejects.toMatchObject({ cls: "unauthorized" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("不信任调用者提供的图片 hash，相同 hash 不同发送字节失效", async () => {
    const transport = vi.fn(async () => response(FACTS));
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    await adapter.describePhoto(input());
    const changed = { ...image, bytes: await sharp(image.bytes).negate().jpeg().toBuffer() };
    expect((await adapter.describePhoto(input({ image: changed }))).visual_source).toBe("fresh");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("结构无效会拒绝且不写缓存；撤销授权后零外发", async () => {
    const invalidTransport = vi.fn(async () => response({ summary: "缺字段" }));
    const invalidAdapter = createAiVisionAdapter({ db, config: config(), transport: invalidTransport });
    await expect(invalidAdapter.describePhoto(input())).rejects.toThrow(AiInvalidResponseError);
    expect(listAiCalls(db, { scopeId: "wf_vision" })[0].error_class).toBe("invalid_response");
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get() as { n: number }).n).toBe(0);

    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    const blockedTransport = vi.fn(async () => response(FACTS));
    const blocked = createAiVisionAdapter({ db, config: config(), transport: blockedTransport });
    await expect(blocked.describePhoto(input({ workflowId: "wf_revoked" }))).rejects.toThrow(
      AiUnauthorizedError,
    );
    expect(blockedTransport).not.toHaveBeenCalled();
  });

  it("已有有效缓存也不能绕过撤销授权，恢复授权后仍复用原来源", async () => {
    const transport = vi.fn(async () => response(FACTS));
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    const first = await adapter.describePhoto(input());
    db.prepare("UPDATE exhibitions SET allow_external_ai=0 WHERE id=?").run(exhibitionId);
    await expect(adapter.describePhoto(input({ workflowId: "wf_revoked_cache" })))
      .rejects.toMatchObject({ cls: "unauthorized" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(listAiCalls(db)).toHaveLength(1);
    db.prepare("UPDATE exhibitions SET allow_external_ai=1 WHERE id=?").run(exhibitionId);
    expect(await adapter.describePhoto(input({ workflowId: "wf_authorized_again" })))
      .toMatchObject({ visual_source: "cache", source_call_id: first.source_call_id });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("同图同模型也不跨影展复用视觉事实", async () => {
    const transport = vi.fn(async () => response(FACTS));
    const adapter = createAiVisionAdapter({ db, config: config(), transport });
    await adapter.describePhoto(input());
    const otherId = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id;
    insertPhotoAsset(db, { id: "photo_other", exhibition_id: otherId, original_name: "synthetic.jpg",
      storage_path: "unused.jpg", thumbnail_path: null, width: 96, height: 64,
      mime_type: "image/jpeg", file_size: 1, sha256: "original-sha", sort_order: 0 });
    expect(await adapter.describePhoto(input({ exhibitionId: otherId, photoId: "photo_other", workflowId: "wf_other" })))
      .toMatchObject({ visual_source: "fresh" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
