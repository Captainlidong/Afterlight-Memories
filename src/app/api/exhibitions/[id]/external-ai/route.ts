import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getExhibition, setExternalAiConsent } from "@/lib/db/repos";
import { assertWritable } from "@/lib/orchestrator/guard";
import { ApiError, handler, ok } from "@/lib/api/errors";

import { requireVisitorMutation } from "@/lib/visitor/access";
export const runtime = "nodejs";
const Input = z.object({ allow_external_ai: z.boolean() }).strict();

export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const body = Input.parse(await req.json());
  const { id } = await params;
  const db = getDb();
  requireVisitorMutation(db, req, id);
  const exhibition = getExhibition(db, id);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");
  if (body.allow_external_ai) {
    assertWritable(db, id);
    if (exhibition.mode !== "ai") throw new ApiError(409, "ai_mode_required", "请先显式选择 AI 模式，再决定是否授权。");
  }
  // 撤销不受生成锁限制，阻止下一次外发；已经发出的数据无法收回。
  setExternalAiConsent(db, id, body.allow_external_ai);
  return ok({ allow_external_ai: body.allow_external_ai });
});
