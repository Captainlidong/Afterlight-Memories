import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { replaceNarrative } from "@/lib/db/narrative";
import { replaceLayout } from "@/lib/db/layout";
import { getNarrative } from "@/lib/db/narrative";
import { getLayout } from "@/lib/db/layout";
import { listPhotos } from "@/lib/db/photos";
import { uploadsDir, toRelative } from "@/lib/files";
import { CreateExhibitionInput, NarrativePlan, ExhibitionLayout } from "@/lib/agents/schemas";
import { newId } from "@/lib/id";
import { buildHtmlExport } from "@/lib/export/html";
import { buildJsonPack } from "@/lib/export/jsonPack";
import { buildPlaybackRoute } from "@/lib/exhibition/playbackPlan";
import { POST as exportRoute } from "@/app/api/exhibitions/[id]/export/route";

let tmp: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function jsonReq(body: unknown) {
  return new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** 真文件落盘（2400px 宽，验证导出降采样），返回照片 id。 */
async function seedRealPhoto(exhId: string, name: string): Promise<string> {
  const db = getDb();
  const id = newId("photo");
  const buf = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 70, g: 90, b: 130 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const dir = uploadsDir(exhId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(abs, buf);
  insertPhotoAsset(db, {
    id, exhibition_id: exhId, original_name: name,
    storage_path: toRelative(abs), thumbnail_path: null,
    width: 2400, height: 1600, mime_type: "image/jpeg", file_size: buf.length,
    sha256: newId("sha"), sort_order: 0,
  });
  return id;
}

async function readyExh() {
  const db = getDb();
  const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  const a = await seedRealPhoto(exhId, "窗.jpg");
  const b = await seedRealPhoto(exhId, "背影.jpg");
  replaceNarrative(db, exhId, NarrativePlan.parse({
    title: "在光线转弯之前", subtitle: "副标题", curatorial_statement: "窗与光线反复出现。",
    chapters: [
      { id: "chapter_01", title: "进入", description: "空间先出现。", photo_ids: [a], opening_photo_id: a },
      { id: "chapter_02", title: "留下", description: "观看收束。", photo_ids: [b], closing_photo_id: b },
    ],
    tone: "restrained",
  }), { source: "heuristic", inputVersion: 0 });
  replaceLayout(db, exhId, ExhibitionLayout.parse({
    template: "cinema_scroll", background: "#101114", text_color: "#f5f1e8",
    sections: [
      { id: "hero", type: "hero", photo_id: a, height: "92vh", caption_position: "bottom-left" },
      { id: "intro_chapter_01", type: "chapter_intro", chapter_id: "chapter_01", spacing: "large" },
      { id: `single_${a}`, type: "single_image", photo_id: a, size: "large", spacing: "medium" },
      { id: "intro_chapter_02", type: "chapter_intro", chapter_id: "chapter_02", spacing: "large" },
      { id: "statement", type: "statement" },
      { id: "ending", type: "ending", photo_ids: [b] },
    ],
  }), { inputVersion: 0 });
  return { exhId, a, b };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-export-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("静态 HTML 导出", () => {
  it("单文件自包含：doctype/标题/锚点/内联 CSS/base64 图，且不再引用 /api/files", async () => {
    const { exhId } = await readyExh();
    const html = await buildHtmlExport(getDb(), exhId);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>在光线转弯之前</title>");
    for (const id of ["hero", "intro_chapter_01", "statement", "ending"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("data:image/jpeg;base64,");
    expect(html).not.toContain("/api/files/");
    expect(html).toContain(".exhibition-root");
    expect(html).toContain(".max-w-4xl");
    expect(html).toContain("@media");
    expect(html).toMatch(/\.reveal\{opacity:1!important/);
  });

  it("嵌图降采样 ≤1600px（绝不嵌原图）", async () => {
    const { exhId } = await readyExh();
    const html = await buildHtmlExport(getDb(), exhId);
    const m = html.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/);
    expect(m).not.toBeNull();
    const meta = await sharp(Buffer.from(m![1], "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
  });

  it("无布局 → 409 layout_not_ready", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    await expect(buildHtmlExport(db, exhId)).rejects.toMatchObject({ status: 409, code: "layout_not_ready" });
  });
});

describe("静态 HTML 导出 · 内联放映（UX-3c）", () => {
  const ROUTE_RE = /<script type="application\/json" id="afterlight-playback-route">([\s\S]*?)<\/script>/;
  const CTRL_RE = /<script id="afterlight-playback">([\s\S]*?)<\/script>/;

  it("内嵌放映路线 JSON，与浏览页同一 buildPlaybackRoute（零语义漂移）", async () => {
    const { exhId } = await readyExh();
    const db = getDb();
    const html = await buildHtmlExport(db, exhId);
    const m = html.match(ROUTE_RE);
    expect(m).not.toBeNull();
    const route = JSON.parse(m![1]);
    const narrative = getNarrative(db, exhId)!;
    const layout = getLayout(db, exhId)!;
    const photos = listPhotos(db, exhId);
    const expected = buildPlaybackRoute({
      sections: layout.sections,
      chapters: narrative.chapters,
      photos: Object.fromEntries(photos.map((p) => [p.id, p.width != null && p.height != null ? { width: p.width, height: p.height } : undefined])),
      curatorialStatement: narrative.curatorial_statement,
    });
    expect(route).toEqual(expected);
    expect(route.stops.length).toBe(6);
    expect(route.stops[0].sectionId).toBe("hero");
    expect(route.stops[0].dwellMs).toBe(5000);
    expect(route.baseTotalMs).toBeGreaterThan(0);
  });

  it("固定无框架控制器 + 中文控制 + 默认静止 + 结束文案；公开导出不含本地编辑入口", async () => {
    const { exhId } = await readyExh();
    const html = await buildHtmlExport(getDb(), exhId);
    expect(html.match(CTRL_RE)).not.toBeNull();
    expect(html).toContain("开始放映");
    expect(html).toContain("暂停");
    expect(html).toContain("上一段");
    expect(html).toContain("下一段");
    expect(html).toContain("舒缓");
    expect(html).toContain("放映结束。你可以重新观看，或回到作品继续调整。");
    // 默认静止：初始 phase=idle，由访客点击开始
    expect(html).toContain('"idle"');
    // 无 JS 仍可读（reveal 强制可见）
    expect(html).toMatch(/\.reveal\{opacity:1!important/);
    // 公开静态文件不得携带失效的本地编辑链接
    expect(html).not.toContain("返回编辑");
    expect(html).not.toContain(`/e/${exhId}`);
  });

  it("escape 安全：用户/模型文案不进入可执行脚本，JSON 中 </script> 被转义", async () => {
    const db = getDb();
    const exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const a = await seedRealPhoto(exhId, "窗.jpg");
    const b = await seedRealPhoto(exhId, "背影.jpg");
    replaceNarrative(db, exhId, NarrativePlan.parse({
      title: "光影</script><script>alert(1)</script>",
      subtitle: "",
      curatorial_statement: "窗与光线。",
      chapters: [
        { id: "chapter_01", title: "<img src=x onerror=alert(2)>", description: "空间。", photo_ids: [a], opening_photo_id: a },
        { id: "chapter_02", title: "留下", description: "收束。", photo_ids: [b], closing_photo_id: b },
      ],
      tone: "restrained",
    }), { source: "heuristic", inputVersion: 0 });
    replaceLayout(db, exhId, ExhibitionLayout.parse({
      template: "cinema_scroll", background: "#101114", text_color: "#f5f1e8",
      sections: [
        { id: "hero", type: "hero", photo_id: a, height: "92vh", caption_position: "bottom-left" },
        { id: "intro_chapter_01", type: "chapter_intro", chapter_id: "chapter_01", spacing: "large" },
        { id: "ending", type: "ending", photo_ids: [b] },
      ],
    }), { inputVersion: 0 });
    const html = await buildHtmlExport(db, exhId);
    // 可执行脚本（非 application/json 数据块）绝不含注入载荷
    const execScripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(execScripts.length).toBeGreaterThan(0);
    for (const s of execScripts) {
      expect(s[1]).not.toContain("alert(1)");
      expect(s[1]).not.toContain("onerror");
    }
    // 路线 JSON 数据块把 < 转义为 \u003c，内部不得出现裸 </script>
    const jm = html.match(ROUTE_RE)!;
    expect(jm[1]).not.toContain("</script>");
    expect(jm[1]).toContain("\\u003c");
    // 全文 </script> 恰好两块（数据 + 控制器），无提前闭合 breakout
    expect((html.match(/<\/script>/g) ?? []).length).toBe(2);
    // <title> 与正文 markup 中的文案被 HTML 转义
    expect(html).toContain("&lt;/script&gt;");
  });

  it("CSP 固定脚本哈希（自洽），无 unsafe-eval", async () => {
    const { exhId } = await readyExh();
    const html = await buildHtmlExport(getDb(), exhId);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).not.toContain("unsafe-eval");
    const cm = html.match(/script-src 'sha256-([A-Za-z0-9+/=]+)'/);
    expect(cm).not.toBeNull();
    const ctrl = html.match(CTRL_RE)!;
    const hash = createHash("sha256").update(ctrl[1]).digest("base64");
    expect(cm![1]).toBe(hash);
  });

  it("beforeprint 暂停 + 打印隐藏控制条 + afterprint 不自动恢复", async () => {
    const { exhId } = await readyExh();
    const html = await buildHtmlExport(getDb(), exhId);
    expect(html).toContain("beforeprint");
    expect(html).toContain("afterprint");
    expect(html).toContain(".al-bar,.al-end{display:none!important}");
  });

  it("不泄露原图本地路径 / API 路由 / 存储字段", async () => {
    const { exhId } = await readyExh();
    const db = getDb();
    const html = await buildHtmlExport(db, exhId);
    expect(html).not.toContain("/api/files/");
    expect(html).not.toContain("storage_path");
    for (const p of listPhotos(db, exhId)) {
      expect(html).not.toContain(p.storage_path);
    }
  });
});

describe("JSON 包导出", () => {
  it("schema_version + 全量结果 + 编辑 + 版本", async () => {
    const { exhId } = await readyExh();
    const pack = buildJsonPack(getDb(), exhId);
    expect(pack.schema_version).toBe(1);
    expect(pack.exhibition.id).toBe(exhId);
    expect(pack.narrative?.title).toBe("在光线转弯之前");
    expect(pack.layout?.sections.length).toBe(6);
    expect(pack.photos.length).toBe(2);
    expect(Array.isArray(pack.user_edits)).toBe(true);
    expect(Array.isArray(pack.versions)).toBe(true);
    expect(typeof pack.exported_at).toBe("string");
  });
});

describe("POST /api/exhibitions/[id]/export", () => {
  it("html → 200 text/html + attachment 文件名", async () => {
    const { exhId } = await readyExh();
    const res = await exportRoute(jsonReq({ format: "html" }), ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toContain(`afterlight-${exhId}.html`);
    expect((await res.text()).startsWith("<!doctype html>")).toBe(true);
  });

  it("json → 200 application/json + attachment；默认 format=html", async () => {
    const { exhId } = await readyExh();
    const res = await exportRoute(jsonReq({ format: "json" }), ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(`afterlight-${exhId}.json`);
    const pack = await res.json();
    expect(pack.schema_version).toBe(1);
    const def = await exportRoute(jsonReq({}), ctx(exhId) as never);
    expect(def.headers.get("content-type")).toContain("text/html");
  });

  it("无布局 html → 409；不存在 → 404", async () => {
    const db = getDb();
    const bare = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
    const res = await exportRoute(jsonReq({ format: "html" }), ctx(bare) as never);
    expect(res.status).toBe(409);
    const missing = await exportRoute(jsonReq({}), ctx("exh_nope") as never);
    expect(missing.status).toBe(404);
  });
});