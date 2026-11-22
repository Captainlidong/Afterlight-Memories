import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { visitorOwnsExhibition } from "@/lib/visitor/access";
import { VISITOR_COOKIE } from "@/lib/visitor/cookie";
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
  const cookieStore = await cookies();
  const sid = cookieStore.get(VISITOR_COOKIE)?.value ?? null;
  const db = getDb();
  if (!visitorOwnsExhibition(db, sid, id)) notFound();
  if (!getExhibition(db, id)) notFound();
  const sp = await searchParams;
  return <BrowseView exhibitionId={id} embed={sp.embed === "1"} playIntent={sp.play === "1"} />;
}