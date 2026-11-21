import { handler, ok } from "@/lib/api/errors";
import { getDb } from "@/lib/db/client";
import { loadAiConfig } from "@/lib/ai/config";
import { getAiConnectionStatus } from "@/lib/ai/status";
import { resolveMode } from "@/lib/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只读状态查询，绝不调用模型或写入测试记录。 */
export const GET = handler(() => {
  const db = getDb();
  const config = loadAiConfig();
  return ok({ defaultMode: resolveMode(), connection: getAiConnectionStatus(db, config) }, {
    headers: { "Cache-Control": "no-store" },
  });
});
