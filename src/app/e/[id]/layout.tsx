import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";
import { DemoBadge } from "@/components/DemoBadge";
import { Stepper } from "@/components/Stepper";
import { StaleBanner } from "@/components/StaleBanner";
import { AdvanceNotice } from "@/components/AdvanceNotice";
import { PrivacyDelete } from "@/components/PrivacyDelete";
import { ExhibitionUsage } from "@/components/AiUsagePanel";

export const dynamic = "force-dynamic";

export default async function EditorLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const exhibition = getExhibition(getDb(), id);
  if (!exhibition) notFound();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-line bg-ink/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-display text-lg text-text">
            留影 Afterlight
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm text-muted">
              {exhibition.title || "未命名影展"}
            </span>
            {exhibition.mode === "demo" && (
              <DemoBadge variant={exhibition.is_demo_set ? "preset" : "heuristic"} />
            )}
          </div>
        </div>
        <Stepper exhibitionId={id} />
      </header>
      <StaleBanner exhibitionId={id} />
      <ExhibitionUsage exhibitionId={id} />
      <main className="mx-auto max-w-6xl px-6 py-10 pb-24">
        <AdvanceNotice exhibitionId={id} />
        {children}
        <PrivacyDelete exhibitionId={id} />
      </main>
    </div>
  );
}