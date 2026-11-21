import fs from "node:fs";
import { getDb } from "@/lib/db/client";
import { getExhibition, updateExhibition, deleteExhibition, setExternalAiConsent, clearConfirmation, bumpInputRevision } from "@/lib/db/repos";
import { uploadsDir } from "@/lib/files";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { assertWritable } from "@/lib/orchestrator/guard";
import { Tone, Template } from "@/lib/agents/schemas";
import { ApiError, ok, handler } from "@/lib/api/errors";
import { z } from "zod";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const PatchInput = z.object({
  title: z.string().max(60).optional(),
  subtitle: z.string().max(80).optional(),
  user_intent: z.string().max(500).optional(),
  tone: Tone.optional(),
  template: Template.optional(),
  mode: z.enum(["demo", "ai"]).optional(),
});

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const exhibition = getExhibition(getDb(), id);
  if (!exhibition) throw new ApiError(404, "not_found", "影展不存在。");
  return ok({ exhibition });
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = PatchInput.parse(await req.json());
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getExhibition(db, id);
    if (!current) throw new ApiError(404, "not_found", "影展不存在。");
    assertWritable(db, id);
    updateExhibition(db, id, body);
    if (body.mode && body.mode !== current.mode) {
      setExternalAiConsent(db, id, false);
      clearConfirmation(db, id);
      bumpInputRevision(db, id);
      markStale(db, id, "ingest");
    }
    if (body.template && body.template !== current.template) markStale(db, id, "layout");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return ok({ exhibition: getExhibition(db, id) });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const db = getDb();
  if (!getExhibition(db, id)) throw new ApiError(404, "not_found", "影展不存在。");
  assertWritable(db, id);
  deleteExhibition(db, id);
  fs.rmSync(uploadsDir(id), { recursive: true, force: true, maxRetries: 3 });
  return ok({ deleted: id });
});