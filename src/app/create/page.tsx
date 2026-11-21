import { CreateForm } from "@/features/create/CreateForm";
import { resolveMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>;
}) {
  const { demo } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-display text-3xl text-text">创建影展</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        所有字段都可以跳过。先上传照片，再慢慢决定也不迟。
      </p>
      <CreateForm demo={demo === "1"} defaultMode={resolveMode()} />
    </main>
  );
}