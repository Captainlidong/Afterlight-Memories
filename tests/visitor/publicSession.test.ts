import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrations";
import { createExhibition } from "@/lib/db/repos";
import { insertPhotoAsset } from "@/lib/db/photos";
import {
  getOrCreateVisitorSession,
  hasAiExperience,
  markAiExperienceUsed,
  purgeExpiredVisitorData,
} from "@/lib/db/visitorSessions";
import { assertVisitorApiMutation } from "@/lib/api/localRequest";
import { requireVisitorMutation, requireVisitorRead, visitorOwnsExhibition } from "@/lib/visitor/access";
import { assertVisitorAiExperienceStart, markVisitorAiExperience, assertVisitorUploadDiskCap } from "@/lib/visitor/quota";
import { aiWindowNow } from "@/lib/ai/schedule";

/** 公网匿名会话（AFTERLIGHT_PUBLIC=1）回归：会话生命周期、归属隔离、AI 额度三层、空闲时段、本机零变化。 */

const dbHandles: DatabaseSync[] = [];
function freshDb(): DatabaseSync {
  const db = createDb(":memory:");
  migrate(db);
  dbHandles.push(db);
  return db;
}

const sid = "sess_aaaaaaaaaaaaaaaaaaaaaaaa";
const sid2 = "sess_bbbbbbbbbbbbbbbbbbbbbbbb";
const cookieHeader = `afterlight_sid=${sid}`;
const visitorReq = () => new Request("https://site.test/api/x", { headers: { origin: "https://site.test", host: "site.test", cookie: cookieHeader } });

function insertPhoto(db: DatabaseSync, exhibitionId: string, size = 1024): void {
  insertPhotoAsset(db, {
    id: "photo_" + Math.random().toString(36).slice(2, 10),
    exhibition_id: exhibitionId,
    original_name: "p.jpg",
    storage_path: "unused",
    thumbnail_path: null,
    width: 10,
    height: 10,
    mime_type: "image/jpeg",
    file_size: size,
    sha256: "x" + Math.random(),
    sort_order: 0,
  });
}

beforeEach(() => {
  vi.stubEnv("AFTERLIGHT_PUBLIC", "1");
  vi.stubEnv("AFTERLIGHT_VISITOR_TTL_MINUTES", "60");
  vi.stubEnv("AFTERLIGHT_PUBLIC_DAILY_AI_EXPERIENCES", "10");
  vi.stubEnv("AFTERLIGHT_VISITOR_AI_PHOTOS", "10");
  delete process.env.AI_PEAK_HOLIDAYS;
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of dbHandles.splice(0)) db.close();
});

describe("匿名会话生命周期", () => {
  it("创建即写行，二次调用滑动续期", () => {
    const db = freshDb();
    const first = getOrCreateVisitorSession(db, sid)!;
    expect(first.ai_experience_used).toBe(0);
    const later = new Date(Date.now() + 60_000);
    const second = getOrCreateVisitorSession(db, sid, later)!;
    expect(second.last_seen_at).toBe(later.toISOString());
  });

  it("无效 sid 拒绝（不重签，防伪造）", () => {
    const db = freshDb();
    expect(getOrCreateVisitorSession(db, "forged")).toBeNull();
    expect(getOrCreateVisitorSession(db, null)).toBeNull();
  });

  it("滑动过期清理：过期会话的影展成套删除，运行中跳过", () => {
    const db = freshDb();
    getOrCreateVisitorSession(db, sid, new Date(Date.now() - 2 * 3600_000));
    const running = createExhibition(db, {} as never, "demo", { sessionId: sid });
    db.prepare("UPDATE exhibitions SET status='ingesting' WHERE id=?").run(running.id);
    const idle = createExhibition(db, {} as never, "demo", { sessionId: sid });
    insertPhoto(db, idle.id, 5 * 1024 * 1024);
    const removed: string[] = [];
    const summary = purgeExpiredVisitorData(db, "/tmp/x", (id) => removed.push(id));
    expect(summary.sessions).toBe(1);
    expect(summary.exhibitions).toBe(1);
    expect(removed).toEqual([idle.id]);
    expect(db.prepare("SELECT COUNT(*) c FROM exhibitions WHERE id=?").get(running.id)!.c).toBe(1);
  });

  it("本机模式（env 未设）不清理、归属恒通过", () => {
    vi.stubEnv("AFTERLIGHT_PUBLIC", "");
    const db = freshDb();
    const exh = createExhibition(db, {} as never, "demo");
    expect(visitorOwnsExhibition(db, null, exh.id)).toBe(true);
    const summary = purgeExpiredVisitorData(db, "/tmp/x", () => {});
    expect(summary.sessions).toBe(0);
  });
});

describe("归属访问层", () => {
  it("跨会话读写均 404，不暴露存在性；本会话通过", () => {
    const db = freshDb();
    getOrCreateVisitorSession(db, sid);
    getOrCreateVisitorSession(db, sid2);
    const exh = createExhibition(db, {} as never, "demo", { sessionId: sid });
    expect(requireVisitorMutation(db, visitorReq(), exh.id).sid).toBe(sid);
    requireVisitorRead(db, visitorReq(), exh.id);
    const other = new Request("https://site.test/api/x", { headers: { origin: "https://site.test", host: "site.test", cookie: `afterlight_sid=${sid2}` } });
    expect(() => requireVisitorMutation(db, other, exh.id)).toThrow(/影展不存在/);
    expect(() => requireVisitorRead(db, other, exh.id)).toThrow(/影展不存在/);
    // 无会话 Cookie → 401
    const anon = new Request("https://site.test/api/x", { headers: { origin: "https://site.test", host: "site.test" } });
    expect(() => requireVisitorMutation(db, anon, exh.id)).toThrow(/刷新页面/);
  });
});

describe("公网写守卫（edge 层）", () => {
  it("同源 Origin + 会话 Cookie 通过；缺 Origin/伪造 sid 拒绝", () => {
    expect(assertVisitorApiMutation(visitorReq())).toEqual({ sid });
    const noOrigin = new Request("https://site.test/api/x", { headers: { host: "site.test", cookie: cookieHeader } });
    expect(() => assertVisitorApiMutation(noOrigin)).toThrow(/只允许来自本站页面/);
    const forged = new Request("https://site.test/api/x", { headers: { origin: "https://site.test", host: "site.test", cookie: "afterlight_sid=forged" } });
    expect(() => assertVisitorApiMutation(forged)).toThrow(/刷新页面/);
  });
  it("转发头还原站点地址（HTTPS 终止在前）仍同源可过", () => {
    const req = new Request("http://origin.internal/api/x", {
      headers: {
        origin: "https://site.test",
        host: "origin.internal",
        "x-forwarded-host": "site.test",
        "x-forwarded-proto": "https",
        cookie: cookieHeader,
      },
    });
    expect(assertVisitorApiMutation(req)).toEqual({ sid });
  });
  it("本机模式（env 未设）访客守卫直接拒绝（保持本地专用）", () => {
    vi.stubEnv("AFTERLIGHT_PUBLIC", "");
    expect(() => assertVisitorApiMutation(visitorReq())).toThrow(/本地作者/);
  });
});

describe("AI 体验三层额度", () => {
  // 额度测试统一用非高峰时刻（周一北京 12:30 午间空档 = UTC 04:30）
  const OFF_PEAK = () => aiWindowNow(new Date("2026-11-23T04:30:00Z"));
  function setupAiExhibition(photoCount: number): { db: DatabaseSync; id: string } {
    const db = freshDb();
    getOrCreateVisitorSession(db, sid);
    const exh = createExhibition(db, { allow_external_ai: true } as never, "ai", { sessionId: sid });
    for (let i = 0; i < photoCount; i++) insertPhoto(db, exh.id);
    return { db, id: exh.id };
  }

  it("首次启动：锁定会话次数；未建 job 的重试被次数拦下", () => {
    const { db, id } = setupAiExhibition(3);
    const gate = assertVisitorAiExperienceStart(db, visitorReq(), id, OFF_PEAK);
    expect(gate.shouldMark).toBe(true);
    markVisitorAiExperience(db, visitorReq(), id);
    expect(hasAiExperience(db, sid)).toBe(true);
    expect(() => assertVisitorAiExperienceStart(db, visitorReq(), id, OFF_PEAK)).toThrow(/体验次数已用完/);
  });

  it("已开始体验的影展（有 job）重试放行且不重复标记", () => {
    const { db, id } = setupAiExhibition(3);
    markVisitorAiExperience(db, visitorReq(), id);
    db.prepare("INSERT INTO curation_jobs (id, exhibition_id, max_calls, created_at) VALUES ('job_v', ?, 40, ?)")
      .run(id, new Date().toISOString());
    const gate = assertVisitorAiExperienceStart(db, visitorReq(), id, OFF_PEAK);
    expect(gate.shouldMark).toBe(false);
  });

  it("照片超上限拒绝；Demo 影展不受约束", () => {
    const { db, id } = setupAiExhibition(11);
    expect(() => assertVisitorAiExperienceStart(db, visitorReq(), id, OFF_PEAK)).toThrow(/最多分析 10 张/);
    const demoDb = freshDb();
    getOrCreateVisitorSession(demoDb, sid);
    const demo = createExhibition(demoDb, {} as never, "demo", { sessionId: sid });
    const gate = assertVisitorAiExperienceStart(demoDb, visitorReq(), demo.id, OFF_PEAK);
    expect(gate.shouldMark).toBe(false);
  });

  it("全局日限：达到上限后新体验拒绝", () => {
    vi.stubEnv("AFTERLIGHT_PUBLIC_DAILY_AI_EXPERIENCES", "2");
    const db = freshDb();
    for (let i = 0; i < 2; i++) {
      const s = "sess_" + "c".repeat(4) + i + "dddddddddddd";
      getOrCreateVisitorSession(db, s);
      const exh = createExhibition(db, { allow_external_ai: true } as never, "ai", { sessionId: s });
      insertPhoto(db, exh.id);
      markAiExperienceUsed(db, s);
      db.prepare("INSERT INTO curation_jobs (id, exhibition_id, max_calls, created_at) VALUES (?, ?, 40, ?)")
        .run("job_d" + i, exh.id, new Date().toISOString());
    }
    getOrCreateVisitorSession(db, sid);
    const exh3 = createExhibition(db, { allow_external_ai: true } as never, "ai", { sessionId: sid });
    insertPhoto(db, exh3.id);
    expect(() => assertVisitorAiExperienceStart(db, visitorReq(), exh3.id, OFF_PEAK)).toThrow(/名额已用完/);
  });

  it("上传磁盘防护：会话 60MB / 全站 400MB", () => {
    const db = freshDb();
    getOrCreateVisitorSession(db, sid);
    const exh = createExhibition(db, {} as never, "demo", { sessionId: sid });
    assertVisitorUploadDiskCap(db, visitorReq());
    for (let i = 0; i < 10; i++) insertPhoto(db, exh.id, 7 * 1024 * 1024);
    expect(() => assertVisitorUploadDiskCap(db, visitorReq())).toThrow(/上传总量已达上限/);
    const other = freshDb();
    const exh2 = createExhibition(other, {} as never, "demo", { sessionId: sid2 });
    for (let i = 0; i < 60; i++) insertPhoto(other, exh2.id, 7 * 1024 * 1024);
    expect(() => assertVisitorUploadDiskCap(other, visitorReq())).toThrow(/存储空间已满/);
  });
});

describe("DeepSeek 空闲时段调度", () => {
  // 2026-11-23 为周一。UTC+8 换算：02:00Z = 北京 10:00（高峰）。
  it("工作日高峰拒绝并给出恢复提示", () => {
    const w = aiWindowNow(new Date("2026-11-23T02:00:00Z"));
    expect(w.allowed).toBe(false);
    expect(w.message).toContain("高峰时段");
    expect(w.resumeHint).toContain("12:00");
  });
  it("午间空档与工作日夜间可用", () => {
    expect(aiWindowNow(new Date("2026-11-23T04:30:00Z")).allowed).toBe(true); // 北京 12:30
    expect(aiWindowNow(new Date("2026-11-23T12:30:00Z")).allowed).toBe(true); // 北京 20:30
  });
  it("周末全天空闲", () => {
    expect(aiWindowNow(new Date("2026-11-22T02:00:00Z")).allowed).toBe(true); // 周日 10:00
  });
  it("节假日表生效；未配置时按普通工作日保守拒绝", () => {
    vi.stubEnv("AI_PEAK_HOLIDAYS", "2026-11-23");
    expect(aiWindowNow(new Date("2026-11-23T02:00:00Z")).allowed).toBe(true);
    vi.stubEnv("AI_PEAK_HOLIDAYS", "");
    expect(aiWindowNow(new Date("2026-11-23T02:00:00Z")).allowed).toBe(false);
  });
});

describe("公网路由行为（handler 级）", () => {
  it("创建绑定会话并下发 Cookie；列表只返回本会话影展", async () => {
    const { POST: createExh, GET: listExh } = await import("@/app/api/exhibitions/route");
    const db = freshDb();
    vi.spyOn(await import("@/lib/db/client"), "getDb").mockReturnValue(db);
    const purge = vi.spyOn(await import("@/lib/db/visitorSessions"), "purgeExpiredVisitorData").mockReturnValue({ exhibitions: 0, sessions: 0 });
    // 无 Cookie 的新访客：创建即签发会话 Cookie
    const req = new Request("https://site.test/api/exhibitions", {
      method: "POST",
      headers: { origin: "https://site.test", host: "site.test", "content-type": "application/json" },
      body: JSON.stringify({ title: "访客影展", mode: "demo" }),
    });
    const res = await createExh(req);
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("afterlight_sid=sess_");
    const body = await res.json();
    const { id } = body;
    expect(db.prepare("SELECT session_id FROM exhibitions WHERE id=?").get(id)!.session_id).toMatch(/^sess_/);
    // 带下发的会话 Cookie 列表：返回本会话影展；无 Cookie 返回空
    const issued = /afterlight_sid=([^;]+)/.exec(setCookie)![1];
    const withCookie = new Request("https://site.test/api/exhibitions", { headers: { origin: "https://site.test", host: "site.test", cookie: `afterlight_sid=${issued}` } });
    const listed = await listExh(withCookie);
    const listedBody = await listed.json();
    expect(listedBody.exhibitions.map((e: { id: string }) => e.id)).toContain(id);
    const anonList = await listExh(new Request("https://site.test/api/exhibitions"));
    expect((await anonList.json()).exhibitions).toEqual([]);
    expect(purge).toHaveBeenCalled();
  });
});
