import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { compile } from "tailwindcss";
import { LayoutRenderer } from "@/components/exhibition/LayoutRenderer";
import type { PhotoAsset } from "@/types";
import { getExhibition } from "../db/repos";
import { getNarrative } from "../db/narrative";
import { getLayout } from "../db/layout";
import { listPhotos } from "../db/photos";
import { toAbsolute } from "../files";
import { ApiError } from "../api/errors";
import { buildPlaybackRoute } from "../exhibition/playbackPlan";
import { PLAYBACK_CONTROLLER, PLAYBACK_CSS } from "./playbackScript";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 嵌图降采样：original ≤1600px/q80，thumb ≤800px/q75；绝不嵌原图（§导出 / 隐私）。 */
async function embedImages(markup: string, exhibitionId: string, photos: PhotoAsset[]): Promise<string> {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const re = new RegExp(`/api/files/${exhibitionId}/([A-Za-z0-9_-]+)\\?variant=(thumb|original)`, "g");
  const cache = new Map<string, string>();
  for (const m of markup.matchAll(re)) {
    if (cache.has(m[0])) continue;
    const photo = byId.get(m[1]);
    if (!photo) continue;
    const thumb = m[2] === "thumb";
    const max = thumb ? 800 : 1600;
    const buf = await sharp(toAbsolute(photo.storage_path))
      .rotate()
      .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: thumb ? 75 : 80 })
      .toBuffer();
    cache.set(m[0], `data:image/jpeg;base64,${buf.toString("base64")}`);
  }
  return markup.replace(re, (full) => cache.get(full) ?? full);
}

/** 与浏览页同一份 globals.css：Tailwind v4 compile API 按渲染 markup 的类名生成 CSS，零漂移。 */
async function buildCss(markup: string): Promise<string> {
  const globalsPath = path.join(process.cwd(), "src", "app", "globals.css");
  const source = fs.readFileSync(globalsPath, "utf8");
  const candidates = new Set<string>();
  for (const m of markup.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) candidates.add(c);
  }
  const compiler = await compile(source, {
    base: path.dirname(globalsPath),
    loadStylesheet: async (id, base) => {
      // 动态 require.resolve 会被 Webpack 改写为空模块上下文，CSS 需直接按文件读取。
      const file = id.startsWith(".") ? path.resolve(base, id) : path.join(process.cwd(), "node_modules", id, "index.css");
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  return compiler.build([...candidates]);
}

/**
 * 静态 HTML 导出（§导出）：renderToStaticMarkup(LayoutRenderer) + 内联 CSS + base64 降采样图。
 * 单文件独立可开；无 JS，故 .reveal 强制可见。
 */
export async function buildHtmlExport(db: DatabaseSync, exhibitionId: string): Promise<string> {
  const exhibition = getExhibition(db, exhibitionId);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");
  const narrative = getNarrative(db, exhibitionId);
  const layout = getLayout(db, exhibitionId);
  if (!narrative || !layout) throw new ApiError(409, "layout_not_ready", "还没有可导出的布局，请先生成布局。");
  const photos = listPhotos(db, exhibitionId);
  // 静态 import react-dom/server 会被 Next 客户端图层规则拒绝 → 服务端动态导入
  const { renderToStaticMarkup } = await import("react-dom/server");
  const markup = renderToStaticMarkup(
    <LayoutRenderer layout={layout} narrative={narrative} photos={photos} exhibitionId={exhibitionId} />,
  );
  const [withImages, css] = await Promise.all([embedImages(markup, exhibitionId, photos), buildCss(markup)]);
  const staticOverride = ".reveal{opacity:1!important;transform:none!important;transition:none!important}";

  // 放映路线：与浏览页同一 buildPlaybackRoute（零语义漂移）。序列化为非执行 JSON 数据块，
  // 把 < 转义为 \u003c，杜绝用户/模型文案中的 </script> 提前闭合 breakout。
  const route = buildPlaybackRoute({
    sections: layout.sections,
    chapters: narrative.chapters,
    photos: Object.fromEntries(
      photos.map((p) => [p.id, p.width != null && p.height != null ? { width: p.width, height: p.height } : undefined]),
    ),
    curatorialStatement: narrative.curatorial_statement,
  });
  const routeJson = JSON.stringify(route).replace(/</g, "\\u003c");
  // 固定控制器脚本的 CSP sha256 哈希（不用 unsafe-eval/unsafe-inline）；数据块非执行不受 script-src 限制。
  const scriptHash = createHash("sha256").update(PLAYBACK_CONTROLLER).digest("base64");
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-${scriptHash}'"/>`;
  const playback =
    `<style>${PLAYBACK_CSS}</style>` +
    `<script type="application/json" id="afterlight-playback-route">${routeJson}</script>` +
    `<script id="afterlight-playback">${PLAYBACK_CONTROLLER}</script>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="generator" content="留影 Afterlight"/>${csp}<title>${escapeHtml(narrative.title)}</title><style>${css}${staticOverride}</style></head><body>${withImages}${playback}</body></html>`;
}