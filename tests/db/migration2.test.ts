import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import {
  createExhibition,
  getExhibition,
  updateExhibition,
  bumpInputRevision,
} from "@/lib/db/repos";
import { markStale } from "@/lib/orchestrator/rerunMatrix";
import { createRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";

describe("migration 2 — UX 地基（增量，不清数据）", () => {
  it("新库：新状态 awaiting_selection_confirm 可写，selection/input_revision 列有默认值", () => {
    const db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    expect(e.input_revision).toBe(0);
    expect(e.selection_confirmed_revision).toBeNull();
    expect(e.selection_confirmed_photo_ids).toBeNull();
    expect(e.selection_hold_policy).toBeNull();

    updateExhibition(db, e.id, { status: "awaiting_selection_confirm" });
    expect(getExhibition(db, e.id)!.status).toBe("awaiting_selection_confirm");
    db.close();
  });

  it("新库：agent_runs 支持 workflow_id / input_revision；curation_operations 表存在", () => {
    const db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    const run = createRun(db, {
      exhibitionId: e.id,
      agentType: "material_steward",
      inputVersion: 0,
      workflowId: "wf_test1",
      inputRevision: 3,
    });
    expect(run.workflow_id).toBe("wf_test1");
    expect(run.input_revision).toBe(3);

    db.prepare(
      `INSERT INTO curation_operations
        (id, exhibition_id, action, decision, photo_ids, before_json, after_json, revision, request_id, created_at)
       VALUES ('op_1', ?, 'set_decision', 'keep', '[]', '{}', '{}', 1, 'req_1', '2026-01-01T00:00:00Z')`,
    ).run(e.id);
    const op = db.prepare("SELECT * FROM curation_operations WHERE id='op_1'").get() as {
      request_id: string;
      undone: number;
    };
    expect(op.request_id).toBe("req_1");
    expect(op.undone).toBe(0);
    db.close();
  });

  it("v1 旧库升级：既有影展/照片/决定/运行记录全部保留，外键仍有效", () => {
    const db = new DatabaseSync(":memory:");
    // 手工停在 v1：只跑 migration 1
    db.exec(MIGRATIONS[0]);
    db.exec("PRAGMA user_version=1");
    db.prepare(
      `INSERT INTO exhibitions (id, title, status, created_at, updated_at)
       VALUES ('exh_old', '旧影展', 'awaiting_user_review', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO photo_assets (id, exhibition_id, original_name, storage_path, mime_type, file_size, sha256, created_at)
       VALUES ('photo_old', 'exh_old', 'a.jpg', 'uploads/exh_old/photo_old.jpg', 'image/jpeg', 10, 'hash', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO curation_decisions (photo_id, exhibition_id, ai_decision, score, confidence, reasons, updated_at)
       VALUES ('photo_old', 'exh_old', 'keep', 0.8, 0.9, '["理由"]', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_runs (id, exhibition_id, agent_type, status, input_version, created_at)
       VALUES ('run_old', 'exh_old', 'material_steward', 'completed', 0, '2026-01-01T00:00:00Z')`,
    ).run();

    migrate(db);

    const e = getExhibition(db, "exh_old")!;
    expect(e.title).toBe("旧影展");
    expect(e.status).toBe("awaiting_user_review");
    expect(e.input_revision).toBe(0);
    expect(e.selection_confirmed_revision).toBeNull();
    const photos = db.prepare("SELECT COUNT(*) AS n FROM photo_assets").get() as { n: number };
    expect(photos.n).toBe(1);
    const decisions = db.prepare("SELECT COUNT(*) AS n FROM curation_decisions").get() as { n: number };
    expect(decisions.n).toBe(1);
    const oldRun = db.prepare("SELECT workflow_id, input_revision FROM agent_runs WHERE id='run_old'").get() as {
      workflow_id: string | null;
      input_revision: number | null;
    };
    expect(oldRun.workflow_id).toBeNull();
    // 升级后外键仍生效：删影展应级联删照片
    db.prepare("DELETE FROM exhibitions WHERE id='exh_old'").run();
    const after = db.prepare("SELECT COUNT(*) AS n FROM photo_assets").get() as { n: number };
    expect(after.n).toBe(0);
    db.close();
  });
});

describe("input_revision 与统一 markStale", () => {
  let db: DatabaseSync;
  let id: string;

  function fresh(status = "awaiting_user_review") {
    db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    id = e.id;
    updateExhibition(db, id, { status });
    return e;
  }

  it("bumpInputRevision 单调递增并返回新值", () => {
    fresh();
    expect(bumpInputRevision(db, id)).toBe(1);
    expect(bumpInputRevision(db, id)).toBe(2);
    expect(getExhibition(db, id)!.input_revision).toBe(2);
    db.close();
  });

  it("markStale 取更早阶段：已有 narrative 过期时标 layout 不覆盖", () => {
    fresh();
    markStale(db, id, "narrative");
    markStale(db, id, "layout");
    expect(getExhibition(db, id)!.stale_from).toBe("narrative");
    db.close();
  });

  it("markStale 取更早阶段：已有 layout 过期时标 motifs 会前移", () => {
    fresh();
    markStale(db, id, "layout");
    markStale(db, id, "motifs");
    expect(getExhibition(db, id)!.stale_from).toBe("motifs");
    db.close();
  });

  it("draft/uploading 阶段不标过期（还没有任何生成结果）", () => {
    fresh("draft");
    markStale(db, id, "motifs");
    expect(getExhibition(db, id)!.stale_from).toBeNull();
    db.close();
  });
});