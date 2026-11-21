"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { Button, Spinner } from "@/components/ui";
import { jsonFetcher, useStatus } from "@/lib/hooks";
import { STAGE_META } from "@/lib/orchestrator/stateMachine";
import type { AiConnectionStatus } from "@/lib/ai/status";
import { AI_ERROR_GUIDANCE } from "@/lib/ai/feedback";
import type { AiErrorClass } from "@/lib/ai/errors";

export function ExhibitionUsage({ exhibitionId }: { exhibitionId: string }) {
  const { data } = useStatus(exhibitionId);
  const usage = data?.ai_usage;
  if (!usage || data?.exhibition.mode !== "ai") return null;
  const material = usage.material;
  const currentRuns = data.runs.filter(r => r.workflow_id === data.workflow_id && r.status !== "skipped");
  const latest = currentRuns.find(r => r.status === "running")
    ?? [...currentRuns].reverse().find(r => r.status === "failed")
    ?? [...currentRuns].reverse().find(r => r.status === "completed")
    ?? currentRuns[0];
  const stage = Object.values(STAGE_META).find(s => s.agent === latest?.agent_type)?.userLabel;
  const activity = usage.activity;
  const stateLabel = activity.queued > 0 && activity.in_flight === 0 ? "正在排队"
    : activity.in_flight > 0 ? "正在请求模型"
    : latest?.status === "running" ? "任务执行中" : latest?.status === "failed" ? "未完成"
    : latest?.status === "completed" ? "阶段完成" : "等待中";
  return (
    <aside aria-label="AI 运行与消耗" className="mx-auto mt-4 max-w-6xl px-6 text-xs leading-relaxed text-muted">
      <div className="rounded-lg border border-ink-line px-4 py-3 space-y-1">
        <p className="text-text" role="status">{stage ?? "等待分析"}{latest ? ` · ${stateLabel}` : ""}</p>
        {(activity.queued > 0 || activity.in_flight > 0) && <p>{`本次排队 ${activity.queued} 个，正在处理 ${activity.in_flight} 个请求。`}</p>}
        {material && <p>{material.current_input ? "素材分析" : "上次素材分析（输入已变化）"}：{`${material.processed}/${material.total} 张已完成，复用 ${material.reused} 张，新完成 ${material.newly_completed} 张，失败 ${material.failed} 张，待处理 ${material.pending} 张。`}</p>}
        <p>{`本次已发送 ${usage.run.attempts} 次请求；当前影展业务额度剩余 ${usage.business.remaining} 次。`}</p>
        {usage.business.remaining === 0 ? <p className="text-warn">业务额度已用完，已完成结果保留；重试、重启或切换模式不会重置额度。</p>
          : material && (material.failed > 0 || material.pending > 0) && !data.is_running ? <p>重试将复用仍有效的成功分析，只补失败或失效项；之后的策展阶段也会消耗调用额度。</p> : null}
        <details>
          <summary className="cursor-pointer text-gold">查看调用与消耗详情</summary>
          <div className="mt-2 space-y-1">
            <p>业务累计 {usage.business.used}/{usage.business.limit} 次；全局日额度 {usage.daily.used}/{usage.daily.limit} 次（{usage.daily.timezone}）。</p>
            <p>连接测试独立计入日额及小时额度，不占影展业务额：本小时 {usage.probes.hourly_used}/{usage.probes.hourly_limit} 次；最近测试 {usage.probes.latest_attempts} 次{usage.probes.latest_at ? `（${usage.probes.latest_at}）` : "，尚未测试"}。</p>
            <p>本次成功 {usage.run.succeeded} 次，失败 {usage.run.failed} 次，已发送待确认 {usage.run.uncertain} 次；已知请求耗时 {(usage.run.duration_ms / 1000).toFixed(1)} 秒。</p>
            {usage.run.models.length > 0 && <p>模型：{usage.run.models.join("、")}</p>}
            {usage.run.errors.length > 0 && <p>处理说明：{usage.run.errors.map(error => Object.hasOwn(AI_ERROR_GUIDANCE, error) ? AI_ERROR_GUIDANCE[error as AiErrorClass] : "请求未完成，请检查状态后重试。").join("；")}</p>}
            <p>{usage.run.known_total_tokens == null ? "消耗未知" : `已知 token 小计 ${usage.run.known_total_tokens}`}{usage.run.unknown_usage > 0 ? `；${usage.run.unknown_usage} 次请求缺少完整 usage，估算不完整。` : ""}</p>
            <p>未配置价格，暂不估算费用。次数上限不是金额上限；费用以服务商账单为准。</p>
            <p>本地结果复用不新增模型请求，不抹除历史消耗；排队、轮询、浏览和导出不调用模型。并发限制适用于当前单服务进程。</p>
          </div>
        </details>
      </div>
    </aside>
  );
}

type StatusPayload = { defaultMode: "demo" | "ai"; connection: AiConnectionStatus };

function useAiConnection() {
  const { data, error, mutate } = useSWR<StatusPayload>("/api/ai/status", jsonFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canTest = Boolean(data?.connection.canTest) && !error;

  async function testConnection() {
    if (inFlight.current || !canTest || !confirmed || !data) return;
    inFlight.current = true;
    setPending(true);
    setConfirmed(false);
    setTestError(null);
    try {
      const response = await fetch("/api/ai/connection-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const result = await response.json();
      if (!response.ok) {
        setTestError(typeof result?.error?.message === "string" ? result.error.message : "连接测试失败，请稍后重试。");
        return;
      }
      // Only the display-safe connection contract is used; probe debug output is never rendered.
      await mutate({ ...data, connection: result.connection }, { revalidate: false });
    } catch {
      setTestError("连接测试请求未完成，请检查网络后重试。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return { data, error, mutate, confirmed, setConfirmed, pending, testError, canTest, testConnection };
}

export function AiUsagePanel() {
  const { data, error, mutate, confirmed, setConfirmed, pending, testError, canTest, testConnection } = useAiConnection();

  return (
    <aside className="space-y-3 rounded-lg border border-ink-line p-4 text-xs leading-relaxed text-muted">
      <p>本地演示始终可用，无需模型配置，也不会向模型服务发送照片。</p>
      <details>
        <summary className="cursor-pointer text-sm text-text">AI 使用说明与连接状态</summary>
        <div className="mt-4 space-y-4">
          <p>查看状态不会调用模型。AI 需要有效配置和本次影展的外发授权，不会自动降级为演示。</p>
          {error ? (
            <div role="alert" className="space-y-2">
              <p>无法加载 AI 连接状态；仍可创建影展、上传照片或使用本地演示。</p>
              <Button type="button" variant="outline" onClick={() => void mutate()}>重新加载状态</Button>
            </div>
          ) : data ? (
            <ConnectionDetails connection={data.connection} />
          ) : (
            <p role="status">正在加载 AI 连接状态…</p>
          )}
          <div className="space-y-2">
            <p>请在服务端 .env.local 配置 AI_BASE_URL、AI_API_KEY、AI_VISION_MODEL，然后重启服务并重新加载状态。本页不接收密钥或自定义服务地址。</p>
            <p>AI_TEXT_MODEL 可选，未设置时复用视觉模型；AFTERLIGHT_MODE=ai 仅设置新影展的默认模式，不代表已授权或连接可用。</p>
            <p>配置缺失、无效或尚未授权时，可以先创建并上传照片，但暂时不能进行 AI 生成。</p>
          </div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#c9a86a]"
              checked={confirmed}
              disabled={pending || !canTest}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我确认仅测试两个固定探测：一段固定文字和一张固定测试图片，最多 2 次模型调用，不使用个人照片；计入全局预算并受每小时连接测试限额约束。这不等于授权影展照片外发。
          </label>
          <Button type="button" variant="outline" disabled={pending || !canTest || !confirmed} onClick={testConnection}>
            {pending ? <Spinner label="连接测试中" /> : testError ? "重试连接测试" : "测试模型连接"}
          </Button>
          {!canTest && !error && data && <p>当前不能发起连接测试，请检查配置或稍后重新加载状态。</p>}
          {testError && <p role="alert" className="text-error">{testError} 请重新勾选测试确认后重试。</p>}
        </div>
      </details>
    </aside>
  );
}

function ConnectionDetails({ connection }: { connection: AiConnectionStatus }) {
  const { text, vision } = connection.capabilities;
  return (
    <div className="space-y-2" role="status">
      <p className="text-text">{connection.label}</p>
      <p>{connection.detail}</p>
      {connection.missing.length > 0 && <p>缺少配置：{connection.missing.join("、")}</p>}
      {connection.issues.length > 0 && <p>配置问题：{connection.issues.join("；")}</p>}
      <Capability label="文本" capability={text} />
      <Capability label="视觉" capability={vision} />
      {text.state === "succeeded" && vision.state !== "succeeded" && (
        <p className="text-warn">文本探测通过不代表视觉可用；照片理解仍需视觉模型。</p>
      )}
      {text.state === "succeeded" && vision.state === "succeeded" && (
        <p>文本与视觉探测均已通过；仅代表测试时的连接情况，不保证每次生成成功。</p>
      )}
      {connection.lastTestAt && <p>最近测试：<time dateTime={connection.lastTestAt}>{connection.lastTestAt}</time></p>}
    </div>
  );
}

const CAPABILITY_LABELS = { untested: "未测试", running: "测试中", succeeded: "通过", failed: "未通过" } as const;

function Capability({ label, capability }: { label: string; capability: AiConnectionStatus["capabilities"]["text"] }) {
  return (
    <div>
      <p>{label}探测：{CAPABILITY_LABELS[capability.state]}</p>
      {capability.message && <p>{capability.message}</p>}
      {capability.at && <p><time dateTime={capability.at}>{capability.at}</time></p>}
    </div>
  );
}
