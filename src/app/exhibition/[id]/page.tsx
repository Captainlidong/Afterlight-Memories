import { notFound } from "next/navigation";
import { BrowseView } from "@/features/exhibition/BrowseView";
import { getDb } from "@/lib/db/client";
import { getExhibition } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export default async function ExhibitionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string; play?: string }>;
}) {
  const { id } = await params;
  if (!getExhibition(getDb(), id)) notFound();
  const sp = await searchParams;
  return <BrowseView exhibitionId={id} embed={sp.embed === "1"} playIntent={sp.play === "1"} />;
}