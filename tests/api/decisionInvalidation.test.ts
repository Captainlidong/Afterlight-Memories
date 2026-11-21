import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupCuratedExhibition, resetDecisions, type CuratedFixture } from "../helpers/curatedExhibition";
import { getExhibition } from "@/lib/db/repos";
import { isRunning } from "@/lib/orchestrator/orchestrator";
import { POST as postConfirm } from "@/app/api/exhibitions/[id]/curation/confirm/route";
import { PATCH as patchDecision } from "@/app/api/exhibitions/[id]/photos/[photoId]/decision/route";

let fx: CuratedFixture;
let p: string[];
let seq = 0;

const BASE_AI = ["keep", "keep", "hold", "hold", "remove", "remove"] as const;

async function confirm() {
  const rev = getExhibition(fx.db, fx.exhId)!.input_revision;
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/curation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_revision: rev,
      hold_policy: "exclude",
      discover_motifs: false,
      request_id: `fixture_confirm_${++seq}`,
    }),
  });
  const res = await postConfirm(req, { params: Promise.resolve({ id: fx.exhId }) } as never);
  return { status: res.status, body: await res.json() };
}

async function patch(pid: string, body: unknown) {
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/photos/${pid}/decision`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await patchDecision(req, { params: Promise.resolve({ id: fx.exhId, photoId: pid }) } as never);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  fx = await setupCuratedExhibition(6);
  p = fx.photoIds;
});

beforeEach(() => {
  resetDecisions(fx.db, fx.exhId, p, [...BASE_AI]);
});

afterAll(() => {
  fx.cleanup();
});

describe("单张 PATCH 的确认失效（§19.5.7 与批量同规则）", () => {
  it("确认后 keep→hold（保留集缩小）→ 确认失效 + 回到待确认选片 + stale motifs", async () => {
    const c = await confirm();
    expect(c.status).toBe(200);
    const { status } = await patch(p[0], { decision: "hold" });
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBeNull();
    expect(exh.selection_confirmed_photo_ids).toBeNull();
    expect(exh.selection_hold_policy).toBeNull();
    expect(exh.status).toBe("awaiting_selection_confirm");
    expect(exh.stale_from).toBe("motifs");
  });

  it("确认后 keep→must_keep（保留集不变）→ 保留确认，stale narrative", async () => {
    const c = await confirm();
    const { status } = await patch(p[0], { decision: "must_keep" });
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBe(c.body.revision);
    expect(exh.stale_from).toBe("narrative");
    expect(exh.status).toBe("awaiting_selection_confirm");
  });

  it("确认后 hold→must_keep（进入保留集）→ 确认失效 + stale motifs", async () => {
    await confirm();
    const { status } = await patch(p[2], { decision: "must_keep" });
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBeNull();
    expect(exh.status).toBe("awaiting_selection_confirm");
    expect(exh.stale_from).toBe("motifs");
  });

  it("未确认时 hold→remove → stale narrative，状态不变", async () => {
    const { status } = await patch(p[2], { decision: "remove" });
    expect(status).toBe(200);
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.selection_confirmed_revision).toBeNull();
    expect(exh.status).toBe("awaiting_selection_confirm");
    expect(exh.stale_from).toBe("narrative");
  });
});

async function confirmDiscover() {
  const rev = getExhibition(fx.db, fx.exhId)!.input_revision;
  const req = new Request(`http://localhost/api/exhibitions/${fx.exhId}/curation/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_revision: rev,
      hold_policy: "exclude",
      discover_motifs: true,
      request_id: `fixture_confirm_d_${++seq}`,
    }),
  });
  const res = await postConfirm(req, { params: Promise.resolve({ id: fx.exhId }) } as never);
  expect(res.status).toBe(200);
  const start = Date.now();
  while (isRunning(fx.db, fx.exhId)) {
    if (Date.now() - start > 15000) throw new Error("motifs pipeline 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("重新确认后 stale 清除（motifs 已按新保留集重跑）", () => {
  it("确认→保留集变化→再确认：motifs 重跑完成后不应残留 stale 横幅", async () => {
    await confirmDiscover();
    expect(getExhibition(fx.db, fx.exhId)!.status).toBe("awaiting_theme_choice");
    expect(getExhibition(fx.db, fx.exhId)!.stale_from).toBeNull();

    const { status } = await patch(p[0], { decision: "hold" });
    expect(status).toBe(200);
    expect(getExhibition(fx.db, fx.exhId)!.stale_from).toBe("motifs");

    await confirmDiscover();
    const exh = getExhibition(fx.db, fx.exhId)!;
    expect(exh.status).toBe("awaiting_theme_choice");
    expect(exh.stale_from).toBeNull();
  });
});