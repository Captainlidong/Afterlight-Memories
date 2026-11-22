"use client";

import { apiUrl } from "@/lib/appBase";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { AiUsagePanel } from "@/components/AiUsagePanel";

const SOURCES = [
  ["travel", "旅行"],
  ["campus", "校园"],
  ["daily", "日常"],
  ["phase", "一个阶段"],
  ["other", "其他"],
] as const;

const TONES = [
  ["documentary", "纪实"],
  ["restrained", "克制"],
  ["poetic", "诗意"],
  ["direct", "直接"],
] as const;

const FOCUS = [
  ["people", "人物"],
  ["architecture", "建筑"],
  ["light", "光线"],
  ["color", "颜色"],
  ["space", "空间"],
] as const;

export function CreateForm({ demo, defaultMode }: { demo: boolean; defaultMode?: "demo" | "ai" }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(demo ? "在光线转弯之前" : "");
  const [sourceType, setSourceType] = useState(demo ? "campus" : "");
  const [userIntent, setUserIntent] = useState(
    demo ? "想记录一个学期里不断经过的空间" : "",
  );
  const [tone, setTone] = useState("restrained");
  const [repetition, setRepetition] = useState<"fewer" | "more">("fewer");
  const [focus, setFocus] = useState<string[]>([]);
  const [allowExif, setAllowExif] = useState(true);
  const [allowExternalAi, setAllowExternalAi] = useState(false);
  const [mode, setMode] = useState<"demo" | "ai">(demo ? "demo" : defaultMode ?? "demo");

  function toggleFocus(value: string) {
    setFocus((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/exhibitions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          source_type: sourceType || undefined,
          user_intent: userIntent || undefined,
          tone,
          aesthetic_prefs: { repetition, focus },
          allow_exif: allowExif,
          allow_external_ai: mode === "ai" && allowExternalAi,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "创建失败");
      }
      router.push(`/e/${data.id}/material`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-10 space-y-8">
      <Field label="影展暂定名称（可选）">
        <input
          className="field"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：在光线转弯之前"
          maxLength={60}
        />
      </Field>

      <Field label="照片来源">
        <div className="flex flex-wrap gap-2">
          {SOURCES.map(([value, label]) => (
            <Chip
              key={value}
              active={sourceType === value}
              onClick={() => setSourceType(value)}
            >
              {label}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="你想表达的主题（可选）">
        <textarea
          className="field min-h-24 resize-y"
          value={userIntent}
          onChange={(e) => setUserIntent(e.target.value)}
          placeholder="用一两句话描述这组照片的背景或你想表达的方向"
          maxLength={500}
        />
      </Field>

      <Field label="想要的语气">
        <div className="flex flex-wrap gap-2">
          {TONES.map(([value, label]) => (
            <Chip key={value} active={tone === value} onClick={() => setTone(value)}>
              {label}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="审美偏好">
        <div className="flex flex-wrap gap-2">
          <Chip active={repetition === "fewer"} onClick={() => setRepetition("fewer")}>
            少留重复
          </Chip>
          <Chip active={repetition === "more"} onClick={() => setRepetition("more")}>
            保留更多瞬间
          </Chip>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {FOCUS.map(([value, label]) => (
            <Chip
              key={value}
              active={focus.includes(value)}
              onClick={() => toggleFocus(value)}
            >
              {label}
            </Chip>
          ))}
        </div>
      </Field>

      <div className="space-y-3 border-t border-ink-line pt-6">
        <Toggle
          checked={allowExif}
          onChange={setAllowExif}
          label="允许在本地读取 EXIF（拍摄时间等）"
        />
        <p className="text-xs leading-relaxed text-muted">
          EXIF 仅在本地处理；不会向模型发送 GPS、完整元数据或本地文件路径。
        </p>
        <Toggle
          checked={allowExternalAi}
          onChange={setAllowExternalAi}
          label="允许把压缩分析图和必要文字发送给已配置的模型服务，用于本次照片理解与策展。原图保存在本地，压缩副本仍可能包含人物等画面信息。"
        />
        <p className="text-xs text-muted">仅在 AI 模式且主动勾选后生效；演示模式不会外发。</p>
        <div className="flex items-center gap-3 pt-2">
          <span className="text-sm text-muted">运行模式</span>
          <Chip active={mode === "demo"} onClick={() => setMode("demo")}>
            演示
          </Chip>
          <Chip active={mode === "ai"} onClick={() => setMode("ai")}>
            AI
          </Chip>
        </div>
        {mode === "ai" && (
          <p className="text-xs leading-relaxed text-warn">
            可以先创建影展并上传照片；未完成有效模型配置或未授权时，暂时不能进行 AI 生成。
            创建、上传或切换模式不会自动调用模型，也不会自动切回演示模式。
          </p>
        )}
        <AiUsagePanel />
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Spinner label="创建中" /> : "创建并上传照片"}
        </Button>
        <Link href="/" className="btn btn-ghost">
          返回首页
        </Link>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm text-text">{label}</span>
      {children}
    </label>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
        active
          ? "border-gold bg-gold/10 text-gold"
          : "border-ink-line text-muted hover:border-gold/40 hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#c9a86a]"
      />
      {label}
    </label>
  );
}