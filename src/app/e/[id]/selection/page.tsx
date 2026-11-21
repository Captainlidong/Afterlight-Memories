import { SelectionBoard } from "@/features/selection/SelectionBoard";

export const dynamic = "force-dynamic";

export default async function SelectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SelectionBoard exhibitionId={id} />;
}