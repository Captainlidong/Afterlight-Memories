import { MotifsBoard } from "@/features/motifs/MotifsBoard";

export const dynamic = "force-dynamic";

export default async function MotifsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MotifsBoard exhibitionId={id} />;
}