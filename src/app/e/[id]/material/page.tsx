import { MaterialBoard } from "@/features/material/MaterialBoard";

export const dynamic = "force-dynamic";

export default async function MaterialPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autostart?: string }>;
}) {
  const { id } = await params;
  const { autostart } = await searchParams;
  return <MaterialBoard exhibitionId={id} autostart={autostart === "1"} />;
}