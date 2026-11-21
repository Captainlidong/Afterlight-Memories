import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, getDb } from "@/lib/db/client";
import { createExhibition, getExhibition } from "@/lib/db/repos";
import { replaceMotifs, listMotifs, getMotif } from "@/lib/db/motifs";
import { CreateExhibitionInput, type MotifT } from "@/lib/agents/schemas";
import { GET as getMotifs } from "@/app/api/exhibitions/[id]/motifs/route";
import { POST as selectMotifRoute } from "@/app/api/exhibitions/[id]/motifs/select/route";
import { PATCH as patchMotif } from "@/app/api/exhibitions/[id]/motifs/[motifId]/route";
import { POST as runMotifsRoute } from "@/app/api/exhibitions/[id]/runs/motifs/route";

let tmp: string;
let exhId: string;
let motifIds: string[];

function ctx(id: string, motifId?: string) {
  return { params: Promise.resolve(motifId ? { id, motifId } : { id }) };
}

const seed: MotifT[] = [
  { title: "窗与背影", description: "d1", photo_ids: ["photo_a"], evidence: ["e1"], confidence: 0.8, alternative_readings: ["a1"] },
  { title: "蓝色光线", description: "d2", photo_ids: ["photo_b"], evidence: ["e2"], confidence: 0.7, alternative_readings: [] },
  { title: "人物与空间", description: "d3", photo_ids: ["photo_c"], evidence: ["e3"], confidence: 0.6, alternative_readings: [] },
];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-motifs-api-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb = createDb(":memory:");
  const db = getDb();
  exhId = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
  replaceMotifs(db, exhId, seed);
  motifIds = listMotifs(db, exhId).map((m) => m.id);
});

afterAll(() => {
  delete (globalThis as unknown as { __afterlightDb?: unknown }).__afterlightDb;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("motifs GET (§11.6)", () => {
  it("返回 3 候选，effective_title = title，state proposed", async () => {
    const res = await getMotifs(new Request("http://localhost/x"), ctx(exhId) as never);
    expect(res.status).toBe(200);
    const { motifs } = await res.json();
    expect(motifs.length).toBe(3);
    expect(motifs[0].effective_title).toBe("窗与背影");
    expect(motifs.every((m: { state: string }) => m.state === "proposed")).toBe(true);
  });

  it("影展不存在 → 404", async () => {
    const res = await getMotifs(new Request("http://localhost/x"), ctx("exh_nope") as never);
    expect(res.status).toBe(404);
  });
});

describe("motifs/select POST (§11.7)", () => {
  it("选择主线 → selected_motif_id 写入，目标 selected 其余 proposed", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ motif_id: motifIds[1] }),
    });
    const res = await selectMotifRoute(req, ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(getExhibition(getDb(), exhId)!.selected_motif_id).toBe(motifIds[1]);
    const motifs = listMotifs(getDb(), exhId);
    expect(motifs.find((m) => m.id === motifIds[1])!.state).toBe("selected");
    expect(motifs.filter((m) => m.state === "selected").length).toBe(1);
  });

  it("带 custom_title → effective_title 为用户命名", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ motif_id: motifIds[2], custom_title: "我的主线" }),
    });
    const res = await selectMotifRoute(req, ctx(exhId) as never);
    expect(res.status).toBe(200);
    expect(getMotif(getDb(), motifIds[2])!.effective_title).toBe("我的主线");
    expect(getExhibition(getDb(), exhId)!.selected_motif_id).toBe(motifIds[2]);
  });

  it("主题不存在 → 404", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ motif_id: "motif_nope" }),
    });
    const res = await selectMotifRoute(req, ctx(exhId) as never);
    expect(res.status).toBe(404);
  });

  it("缺少 motif_id → 400 validation_error", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await selectMotifRoute(req, ctx(exhId) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
  });
});

describe("motifs/[motifId] PATCH (§8.7)", () => {
  it("改名 → user_title 写入，title 不变", async () => {
    const req = new Request("http://localhost/x", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "窗边的蓝色时刻" }),
    });
    const res = await patchMotif(req, ctx(exhId, motifIds[0]) as never);
    expect(res.status).toBe(200);
    const m = getMotif(getDb(), motifIds[0])!;
    expect(m.title).toBe("窗与背影");
    expect(m.user_title).toBe("窗边的蓝色时刻");
    expect(m.effective_title).toBe("窗边的蓝色时刻");
  });

  it("拒绝已选主题 → 清空 selected_motif_id", async () => {
    const db = getDb();
    // 当前 selected = motifIds[2]。
    expect(getExhibition(db, exhId)!.selected_motif_id).toBe(motifIds[2]);
    const req = new Request("http://localhost/x", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "rejected" }),
    });
    const res = await patchMotif(req, ctx(exhId, motifIds[2]) as never);
    expect(res.status).toBe(200);
    expect(getMotif(db, motifIds[2])!.state).toBe("rejected");
    expect(getExhibition(db, exhId)!.selected_motif_id).toBeNull();
  });

  it("主题不存在 → 404", async () => {
    const req = new Request("http://localhost/x", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    const res = await patchMotif(req, ctx(exhId, "motif_nope") as never);
    expect(res.status).toBe(404);
  });
});

describe("runs/motifs POST (§11.6)", () => {
  it("无照片 → 400 no_photos", async () => {
    const emptyExh = createExhibition(getDb(), CreateExhibitionInput.parse({}), "demo").id;
    const req = new Request("http://localhost/x", { method: "POST" });
    const res = await runMotifsRoute(req, ctx(emptyExh) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("no_photos");
  });
});