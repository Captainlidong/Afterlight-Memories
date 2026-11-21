import { z } from "zod";
import { ApiError, handler, ok } from "@/lib/api/errors";
import { assertLocalMutation } from "@/lib/api/localRequest";
import { getDb } from "@/lib/db/client";
import { loadAiConfig } from "@/lib/ai/config";
import { runAiConnectionTest } from "@/lib/ai/connectionTest";
import { getAiConnectionStatus } from "@/lib/ai/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const confirmation = z.object({ confirmed: z.literal(true) }).strict();

export const POST = handler(async (req: Request) => {
  // 必须先拒绝不可信请求，不能先解析正文、读库或创建测试。
  assertLocalMutation(req);
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "连接测试仅接受 JSON 确认请求。");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "请求正文不是有效 JSON。");
  }
  if (!confirmation.safeParse(body).success) {
    // 不返回 Zod 的未知字段列表，避免反射调用方提供的敏感内容。
    throw new ApiError(400, "validation_error", "请明确确认连接测试；不接受其他参数。");
  }
  const db = getDb();
  const config = loadAiConfig();
  const results = await runAiConnectionTest(db, config, undefined, () => loadAiConfig());
  const connection = getAiConnectionStatus(db, config);
  const succeeded = results.text.state === "succeeded" && results.vision.state === "succeeded";
  // 预算拒绝可能没有新调用记录；本次回应不能沿用之前成功的状态。
  connection.capabilities = { text: results.text, vision: results.vision };
  connection.lastTestErrorClass = results.errorClass;
  connection.lastTestOk = succeeded;
  connection.lastTestAt = [results.text.at, results.vision.at].filter((at): at is string => at !== null).sort().at(-1) ?? null;
  connection.kind = succeeded ? "test_succeeded" : "connection_error";
  connection.label = succeeded ? "本次连接测试成功" : "本次连接测试未完成或未通过";
  connection.detail = succeeded ? "固定文字与合成图片均通过，真实照片质量仍待验证。" : "请查看各项结果；未执行的项目不视为成功。重新加载后显示最近已记录的外发测试。";
  return ok({ connection, results }, {
    headers: { "Cache-Control": "no-store" },
  });
});
