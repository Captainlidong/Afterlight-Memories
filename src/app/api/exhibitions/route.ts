import { getDb } from "@/lib/db/client";
import { createExhibition, listExhibitions, listExhibitionsForVisitor } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { resolveMode } from "@/lib/mode";
import { ok, handler } from "@/lib/api/errors";
import { resolveVisitorSessionForCreate, resolveVisitorSid } from "@/lib/visitor/access";
import { isVisitorMode } from "@/lib/db/visitorSessions";
import { purgeExpiredVisitorData } from "@/lib/db/visitorSessions";
import { uploadsDir } from "@/lib/files";
import fs from "node:fs";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const body = CreateExhibitionInput.parse(await req.json());
  const mode = body.mode ?? resolveMode();
  const db = getDb();
  const { sid, setCookie } = resolveVisitorSessionForCreate(db, req);
  const exhibition = createExhibition(db, body, mode, sid ? { sessionId: sid } : {});
  return ok({ id: exhibition.id, exhibition }, {
    status: 201,
    headers: setCookie ? { "set-cookie": setCookie } : undefined,
  });
});

export const GET = handler(async (req: Request) => {
  const db = getDb();
  if (isVisitorMode()) {
    // 惰性清理：列表请求顺带回收过期访客数据（成套删除）。
    purgeExpiredVisitorData(db, process.env.AFTERLIGHT_DATA_DIR ?? "./data", (id) => {
      fs.rmSync(uploadsDir(id), { recursive: true, force: true, maxRetries: 3 });
    });
    const sid = resolveVisitorSid(req);
    return ok({ exhibitions: sid ? listExhibitionsForVisitor(db, sid) : [] });
  }
  return ok({ exhibitions: listExhibitions(db) });
});
