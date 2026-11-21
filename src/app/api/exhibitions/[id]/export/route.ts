import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { buildHtmlExport } from "@/lib/export/html";
import { buildJsonPack } from "@/lib/export/jsonPack";
import { ExportInput } from "@/lib/agents/schemas";
import { ApiError, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 导出（§导出）：html 单文件自包含 / json 全量包；均以 attachment 下载。 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  const { format } = ExportInput.parse(await req.json().catch(() => ({})));
  if (format === "json") {
    return new NextResponse(JSON.stringify(buildJsonPack(db, id), null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="afterlight-${id}.json"`,
      },
    });
  }
  const html = await buildHtmlExport(db, id);
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="afterlight-${id}.html"`,
    },
  });
});