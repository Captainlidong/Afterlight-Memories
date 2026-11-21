import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { AiClient, type AiTransport } from "./client";
import { resolveTextModel, type AiConfig } from "./config";
import { AiConfigError, AiError, AiInvalidResponseError, AiUnauthorizedError, type AiErrorClass } from "./errors";
import { assertServerSide } from "./policy";
import type { AiChatMessage } from "./schemas";
import {
  CONNECTION_PROBE_AGENTS, CONNECTION_PROBE_VERSION, canTestAiConnection,
  connectionErrorClass, connectionErrorMessage, connectionSchemaVersion, type AiCapabilityStatus,
} from "./status";

export interface AiConnectionTestResults {
  text: AiCapabilityStatus;
  vision: AiCapabilityStatus;
  errorClass: AiErrorClass | null;
}

type Capability = "text" | "vision";

/** 只验证固定字面量，不回传或存储服务商回答。 */
function parseProbe(content: string, name: Capability): true {
  const valid = name === "text" ? content.trim() === "AFTERLIGHT_OK" : /^(red|红色)$/i.test(content.trim());
  if (!valid) throw new AiInvalidResponseError(connectionErrorMessage("invalid_response"));
  return true;
}

async function messagesFor(name: Capability): Promise<AiChatMessage[]> {
  if (name === "text") return [{ role: "user", content: "Reply with exactly AFTERLIGHT_OK and nothing else." }];
  // 纯内存合成，无文件、作者照片、EXIF 或客户端输入；文字不透露期望颜色。
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .jpeg({ quality: 90 }).toBuffer();
  return [{ role: "user", content: [
    { type: "text", text: "What is the dominant color in this image? Reply with only one color name in English or Chinese." },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
  ] }];
}

/** 一次明确确认最多外发两次；注入 transport 仅供 Mock 测试，绝不接收调用方提示词或图片。 */
export async function runAiConnectionTest(
  db: DatabaseSync, config: AiConfig, transport?: AiTransport,
  getCurrentConfig?: () => AiConfig,
): Promise<AiConnectionTestResults> {
  assertServerSide();
  // 直接调用也必须 fail closed，不能依赖路由守卫或公网代理。
  if (config.accessMode !== "local") throw new AiUnauthorizedError(connectionErrorMessage("unauthorized"));
  if (!canTestAiConnection(config)) throw new AiConfigError(connectionErrorMessage("config"));
  const probeConfig = { ...config, maxRetries: 0 };
  const client = new AiClient(db, probeConfig, transport);
  const scopeId = randomUUID();
  const schemaVersion = connectionSchemaVersion(probeConfig);
  const results: AiConnectionTestResults = {
    text: { state: "untested", at: null, message: null },
    vision: { state: "untested", at: null, message: null },
    errorClass: null,
  };
  for (const name of ["text", "vision"] as const) {
    const at = new Date().toISOString();
    try {
      await client.run({
        context: {
          purpose: "connection_test", scopeType: "connection_test", scopeId, exhibitionId: null,
          agentType: CONNECTION_PROBE_AGENTS[name], promptVersion: CONNECTION_PROBE_VERSION, schemaVersion,
        },
        model: name === "text" ? resolveTextModel(probeConfig) : probeConfig.visionModel!,
        messages: await messagesFor(name), maxTokens: 32, parse: (content) => parseProbe(content, name),
        getCurrentConfig: getCurrentConfig ? () => ({ ...getCurrentConfig(), maxRetries: 0 }) : undefined,
      });
      results[name] = {
        state: "succeeded", at,
        message: name === "text" ? "固定文字响应测试通过。" : "合成图片颜色测试通过；不代表真实照片语义理解已验证。",
      };
    } catch (error) {
      const cls = connectionErrorClass(error instanceof AiError ? error.cls : null);
      // 预算/本地图像处理等可能在预留记录前失败，仍明确返回本次失败信息。
      results[name] = { state: "failed", at, message: connectionErrorMessage(cls) };
      results.errorClass = cls;
      if (name === "text" && ["auth", "quota", "budget", "config", "unauthorized"].includes(cls)) {
        results.vision.message = "文字测试未通过，已停止后续图片测试。";
        break;
      }
    }
  }
  return results;
}
