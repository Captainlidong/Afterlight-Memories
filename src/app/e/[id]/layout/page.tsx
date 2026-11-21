import { LayoutBoard } from "@/features/layout/LayoutBoard";

export const dynamic = "force-dynamic";

export default async function LayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LayoutBoard exhibitionId={id} />;
}