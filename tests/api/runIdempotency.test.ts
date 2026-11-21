import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import { listRuns } from "@/lib/db/runs";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { prepareUpload } from "@/lib/image/pipeline";
import { uploadsDir, toRelative } from "@/lib/files";
import { newId } from "@/lib/id";
import { POST as postIngest } from "@/app/api/exhibitions/[id]/runs/ingest/route";
import type { DatabaseSync } from "node:sqlite";

let tmp: string;
let db: DatabaseSync;
let exhId: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function post(body?: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${exhId}/runs/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const res = await postIngest(req, ctx(exhId) as never);
  return { status: res.status, body: await res.json() };
}

async function waitDone(timeout = 10000): Promise<void> {
  const start = Date.now();
  while (isRunning(db, exhId)) {
    if (Date.now() - start > timeout) throw new Error("pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-runidem-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  db = getDb();
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;

  const colors = [
    { r: 60, g: 80, b: 120 },
    { r: 180, g: 140, b: 90 },
  ];
  for (const [i, c] of colors.entries()) {
    const buf = await sharp({ create: { width: 120, height: 90, channels: 3, background: c } }).jpeg().toBuffer();
    const pid = newId("photo");
    const prepared = await prepareUpload(buf);
    const dir = uploadsDir(exhId);
    fs.mkdirSync(dir, { recursive: true });
    const origAbs = path.join(dir, `${pid}.jpg`);
    fs.writeFileSync(origAbs, buf);
    fs.writeFileSync(path.join(dir, `thumb_${pid}.jpg`), prepared.thumbnail);
    insertPhotoAsset(db, {
      id: pid, exhibition_id: exhId, original_name: `p${i}.jpg`,
      storage_path: toRelative(origAbs), thumbnail_path: toRelative(path.join(dir, `thumb_${pid}.jpg`)),
      width: prepared.width, height: prepared.height, mime_type: "image/jpeg",
      file_size: buf.length, sha256: prepared.sha256, sort_order: i,
    });
  }
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("run 触发服务端幂等（§19.2.9）", () => {
  it("相同 request_id 重试返回同一 workflow/run，不新增 run、不 bump revision", async () => {
    const first = await post({ request_id: "req_ingest_1" });
    expect(first.status).toBe(202);
    expect(first.body.workflow_id).toMatch(/^wf_/);
    expect(first.body.idempotent).toBe(false);
    await waitDone();
    const runsAfterFirst = listRuns(db, exhId).length;
    const revAfterFirst = getExhibition(db, exhId)!.input_revision;

    const retry = await post({ request_id: "req_ingest_1" });
    expect(retry.status).toBe(202);
    expect(retry.body.workflow_id).toBe(first.body.workflow_id);
    expect(retry.body.run_id).toBe(first.body.run_id);
    expect(retry.body.idempotent).toBe(true);
    expect(listRuns(db, exhId).length).toBe(runsAfterFirst);
    expect(getExhibition(db, exhId)!.input_revision).toBe(revAfterFirst);
  });

  it("运行中相同 request_id 重试也幂等（不触发 409 并发守卫）", async () => {
    const first = await post({ request_id: "req_ingest_running" });
    const retry = await post({ request_id: "req_ingest_running" });
    expect(retry.body.workflow_id).toBe(first.body.workflow_id);
    expect(retry.body.idempotent).toBe(true);
    await waitDone();
  });

  it("新 request_id = 显式重跑：新 workflow，run 增加", async () => {
    const before = listRuns(db, exhId).length;
    const prevWf = (await post({ request_id: "req_ingest_1" })).body.workflow_id;
    const again = await post({ request_id: "req_ingest_2" });
    expect(again.body.idempotent).toBe(false);
    expect(again.body.workflow_id).not.toBe(prevWf);
    await waitDone();
    expect(listRuns(db, exhId).length).toBeGreaterThan(before);
  });

  it("无 request_id 仍可用，且不写幂等表", async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body.idempotent).toBe(false);
    await waitDone();
    const n = db.prepare("SELECT COUNT(*) AS n FROM workflow_requests").get() as { n: number };
    expect(n.n).toBe(3);
  });
});