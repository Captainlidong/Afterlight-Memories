import sharp from "sharp";
import { getDb, dbHealth } from "@/lib/db/client";
import { resolveMode } from "@/lib/mode";
import { ok, handler } from "@/lib/api/errors";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const db = getDb();
  const dbOk = dbHealth(db);

  let sharpOk = false;
  try {
    const buf = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const meta = await sharp(buf).metadata();
    sharpOk = meta.width === 1;
  } catch {
    sharpOk = false;
  }

  return ok({
    ok: dbOk && sharpOk,
    mode: resolveMode(),
    db: dbOk ? "ok" : "error",
    sharp: sharpOk ? "ok" : "error",
    version: "0.1.0",
  });
});