import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";

function oldDb() {
  const db = new DatabaseSync(":memory:");
  for (let i = 0; i < 8; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version=8;
    INSERT INTO exhibitions (id, title, created_at, updated_at) VALUES ('old', '旧影展', 'then', 'then');
    INSERT INTO narrative_plans (exhibition_id, title, curatorial_statement, chapters, tone, source, input_version, updated_at)
      VALUES ('old', '旧标题', '旧文案', '[]', 'restrained', 'heuristic', 7, 'then');
    INSERT INTO user_edits (id, exhibition_id, target_path, value_json, locked, created_at, updated_at)
      VALUES ('edit', 'old', 'narrative.title', '"作者文案"', 1, 'then', 'then');
    INSERT INTO narrative_regenerations (run_id, exhibition_id, workflow_id, scope, tone, expected_input_revision, state, created_at, applied_at)
      VALUES ('run', 'old', 'workflow', 'all', 'poetic', 3, 'applied', 'then', 'later');`);
  return db;
}

describe("narrative revision / preserve 兼容迁移", () => {
  it("合成 v8 数据升级保留叙事、编辑与历史意图，支持 preserve", () => {
    const db = oldDb();
    try {
      migrate(db);
      const n = db.prepare("SELECT * FROM narrative_plans").get();
      expect(n).toMatchObject({ title: "旧标题", edit_revision: 0, input_version: 7 });
      expect(db.prepare("SELECT * FROM user_edits").get()).toMatchObject({ locked: 1, value_json: '"作者文案"' });
      expect(db.prepare("SELECT * FROM narrative_regenerations").get()).toMatchObject({ scope: "all", state: "applied", applied_at: "later" });
      db.exec("INSERT INTO narrative_regenerations (run_id, exhibition_id, workflow_id, scope, expected_input_revision, created_at) VALUES ('new', 'old', 'wf2', 'preserve', 3, 'now')");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM narrative_regenerations").get()).toMatchObject({ n: 2 });
    } finally { db.close(); }
  });

  it("迁移中途失败完整回滚并恢复外键开关，旧库可重试", () => {
    const db = oldDb();
    try {
      // 与本次表重建临时名冲突，模拟 ALTER 已完成后的失败。
      db.exec("CREATE TABLE narrative_regenerations_new (blocker TEXT)");
      expect(() => migrate(db)).toThrow();
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 8 });
      expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA table_info(narrative_plans)").all().some((c) => c.name === "edit_revision")).toBe(false);
      expect(db.prepare("SELECT title FROM narrative_plans").get()).toMatchObject({ title: "旧标题" });
      expect(db.prepare("SELECT scope FROM narrative_regenerations").get()).toMatchObject({ scope: "all" });
      db.exec("DROP TABLE narrative_regenerations_new");
      migrate(db);
      expect(db.prepare("SELECT edit_revision FROM narrative_plans").get()).toMatchObject({ edit_revision: 0 });
    } finally { db.close(); }
  });
});
