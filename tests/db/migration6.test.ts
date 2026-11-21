import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { MIGRATIONS, migrate } from "@/lib/db/migrations";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";

describe("migration 6 — ai_calls / ai_cache / ai_budget_counters（v3 阶段 C，§7）", () => {
  it("新库：全部迁移已应用，三张 AI 表存在且可写", () => {
    const db = createDb(":memory:");
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);

    db.prepare(
      `INSERT INTO ai_calls (id, exhibition_id, scope_type, scope_id, agent_type, provider, model, purpose,
         prompt_version, schema_version, attempt, status, budget_period_keys, created_at)
       VALUES ('ac_1', NULL, 'connection_test', 'ct', NULL, 'openai-compatible', 'vision-x', 'connection_test',
         'conn-v1', 'conn-v1', 1, 'reserved', '["global|*|2026-11-20"]', '2026-11-20T03:00:00.000Z')`,
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get() as { n: number }).n).toBe(1);

    db.prepare(
      `INSERT INTO ai_cache (id, scope_type, scope_id, exhibition_id, purpose, cache_key, provider, model,
         prompt_version, schema_version, preprocess_version, result_json, input_digest, created_at)
       VALUES ('c_1', 'workflow', 'wf_1', NULL, 'vision', 'k1', 'openai-compatible', 'vision-x',
         'vision-v1', 'visual-facts-v1', 'none', '{}', 'd1', '2026-11-20T03:00:00.000Z')`,
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get() as { n: number }).n).toBe(1);

    db.prepare(
      `INSERT INTO ai_budget_counters (scope_type, scope_id, period_key, used)
       VALUES ('global', '*', '2026-11-20', 3)`,
    ).run();
    expect(
      (db.prepare("SELECT used FROM ai_budget_counters WHERE scope_type='global'").get() as { used: number }).used,
    ).toBe(3);
    db.close();
  });

  it("影展删除：ai_cache 级联清理，ai_calls 保留脱敏审计", () => {
    const db = createDb(":memory:");
    const e = createExhibition(db, CreateExhibitionInput.parse({}), "demo");
    db.prepare(
      `INSERT INTO ai_calls (id, exhibition_id, scope_type, scope_id, agent_type, provider, model, purpose,
         prompt_version, schema_version, attempt, status, created_at)
       VALUES ('ac_1', ?, 'workflow', 'wf_1', NULL, 'openai-compatible', 'vision-x', 'vision',
         'vision-v1', 'visual-facts-v1', 1, 'failed', '2026-11-20T03:00:00.000Z')`,
    ).run(e.id);
    db.prepare(
      `INSERT INTO ai_cache (id, scope_type, scope_id, exhibition_id, purpose, cache_key, provider, model,
         prompt_version, schema_version, preprocess_version, result_json, input_digest, created_at)
       VALUES ('c_1', 'workflow', 'wf_1', ?, 'vision', 'k1', 'openai-compatible', 'vision-x',
         'vision-v1', 'visual-facts-v1', 'none', '{}', 'd1', '2026-11-20T03:00:00.000Z')`,
    ).run(e.id);

    db.prepare("DELETE FROM exhibitions WHERE id=?").run(e.id);

    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT exhibition_id FROM ai_calls").get() as { exhibition_id: string }).exhibition_id).toBe(
      e.id,
    );
    db.close();
  });

  it("预算计数器主键（scope_type, scope_id, period_key）唯一", () => {
    const db = createDb(":memory:");
    const ins = db.prepare(
      `INSERT INTO ai_budget_counters (scope_type, scope_id, period_key, used) VALUES (?, ?, ?, ?)`,
    );
    ins.run("job", "j1", "total", 1);
    expect(() => ins.run("job", "j1", "total", 2)).toThrow();
    db.close();
  });

  it("v5 旧库升级：数据保留且 user_version 前进", () => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 5; i++) db.exec(MIGRATIONS[i]);
    db.exec("PRAGMA user_version=5");
    db.prepare(
      `INSERT INTO exhibitions (id, title, status, created_at, updated_at)
       VALUES ('exh_old', '旧影展', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    migrate(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect((db.prepare("SELECT COUNT(*) AS n FROM exhibitions").get() as { n: number }).n).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["ai_budget_counters", "ai_cache", "ai_calls"]);
    db.close();
  });
});
