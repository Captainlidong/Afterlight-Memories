import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";

describe("migration 3 — workflow_requests（run 触发幂等，§19.2.9）", () => {
  it("新库：全部迁移已应用，workflow_requests 表存在且可写", () => {
    const db = createDb(":memory:");
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    db.prepare(
      `INSERT INTO workflow_requests (exhibition_id, request_id, workflow_id, run_id, created_at)
       VALUES (?, 'req_1', 'wf_1', 'run_1', '2026-01-01T00:00:00Z')`,
    ).run(e.id);
    const row = db.prepare("SELECT * FROM workflow_requests WHERE request_id='req_1'").get() as {
      workflow_id: string;
    };
    expect(row.workflow_id).toBe("wf_1");
    db.close();
  });

  it("同一影展同一 request_id 唯一（幂等键）", () => {
    const db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    const ins = db.prepare(
      `INSERT INTO workflow_requests (exhibition_id, request_id, workflow_id, run_id, created_at)
       VALUES (?, 'req_1', 'wf_1', 'run_1', '2026-01-01T00:00:00Z')`,
    );
    ins.run(e.id);
    expect(() => ins.run(e.id)).toThrow();
    db.close();
  });

  it("v2 旧库升级保留数据，删影展级联删请求记录", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.exec("PRAGMA user_version=2");
    db.prepare(
      `INSERT INTO exhibitions (id, title, status, created_at, updated_at)
       VALUES ('exh_old', '旧影展', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    migrate(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM exhibitions").get() as { n: number }).n).toBe(1);
    db.prepare(
      `INSERT INTO workflow_requests (exhibition_id, request_id, workflow_id, run_id, created_at)
       VALUES ('exh_old', 'req_1', 'wf_1', 'run_1', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare("DELETE FROM exhibitions WHERE id='exh_old'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM workflow_requests").get() as { n: number }).n).toBe(0);
    db.close();
  });
});