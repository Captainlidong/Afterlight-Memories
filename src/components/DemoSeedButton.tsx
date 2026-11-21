"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui";

/** 首页「先看一个例子」：创建演示影展（24 张内置示例图）并自动开始分析。 */
export function DemoSeedButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function seed() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/seed", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "演示初始化失败");
      router.push(`/e/${data.id}/material?autostart=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "演示初始化失败");
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className="btn btn-outline" onClick={seed} disabled={loading}>
        {loading ? <Spinner label="准备示例" /> : "先看一个例子"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}