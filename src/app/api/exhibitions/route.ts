import { getDb } from "@/lib/db/client";
import { createExhibition, listExhibitions } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { resolveMode } from "@/lib/mode";
import { ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const body = CreateExhibitionInput.parse(await req.json());
  const mode = body.mode ?? resolveMode();
  const exhibition = createExhibition(getDb(), body, mode);
  return ok({ id: exhibition.id, exhibition }, { status: 201 });
});

export const GET = handler(async () => {
  return ok({ exhibitions: listExhibitions(getDb()) });
});