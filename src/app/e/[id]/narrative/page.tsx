import { NarrativeBoard } from "@/features/narrative/NarrativeBoard";

export const dynamic = "force-dynamic";

export default async function NarrativePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <NarrativeBoard exhibitionId={id} />;
}