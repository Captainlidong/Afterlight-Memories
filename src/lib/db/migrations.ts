import type { DatabaseSync } from "node:sqlite";

/**
 * 步进式迁移，用 PRAGMA user_version 记录版本。
 * 所有 JSON 列存 zod 校验过的 TEXT；时间戳为 ISO-8601 TEXT。
 * 映射设计文档 §10，并补充版本/编辑/锁定表（§5.2 / §7.3 / 提示词8）。
 */
export const MIGRATIONS: string[] = [
  // migration 1 — 初始 schema
  `
CREATE TABLE exhibitions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  subtitle          TEXT NOT NULL DEFAULT '',
  source_type       TEXT,
  user_intent       TEXT,
  tone              TEXT NOT NULL DEFAULT 'restrained',
  aesthetic_prefs   TEXT NOT NULL DEFAULT '{}',
  allow_exif        INTEGER NOT NULL DEFAULT 1,
  allow_external_ai INTEGER NOT NULL DEFAULT 0,
  privacy_mode      TEXT NOT NULL DEFAULT 'local_first',
  mode              TEXT NOT NULL DEFAULT 'demo',
  is_demo_set       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft',
  failed_stage      TEXT,
  stale_from        TEXT,
  selected_motif_id TEXT,
  template          TEXT NOT NULL DEFAULT 'cinema_scroll',
  current_version   INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (status IN ('draft','uploading','ingesting','selecting','motifs_ready',
    'awaiting_theme_choice','writing','designing','checking',
    'awaiting_user_review','published','stage_failed'))
);

CREATE TABLE photo_assets (
  id             TEXT PRIMARY KEY,
  exhibition_id  TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  original_name  TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  thumbnail_path TEXT,
  width          INTEGER,
  height         INTEGER,
  mime_type      TEXT NOT NULL,
  file_size      INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  phash          TEXT,
  exif_json      TEXT,
  has_exif       INTEGER NOT NULL DEFAULT 0,
  privacy_status TEXT NOT NULL DEFAULT 'not_checked',
  status         TEXT NOT NULL DEFAULT 'uploaded',
  error_message  TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_photos_exh ON photo_assets(exhibition_id);
CREATE INDEX idx_photos_sha ON photo_assets(exhibition_id, sha256);

CREATE TABLE photo_inspections (
  photo_id             TEXT PRIMARY KEY REFERENCES photo_assets(id) ON DELETE CASCADE,
  sharpness_score      REAL NOT NULL,
  laplacian_var        REAL NOT NULL,
  brightness_score     REAL NOT NULL,
  highlight_clip_ratio REAL NOT NULL,
  shadow_clip_ratio    REAL NOT NULL,
  dominant_colors      TEXT NOT NULL,
  color_temp           REAL,
  saturation           REAL,
  subjects             TEXT NOT NULL DEFAULT '[]',
  composition_tags     TEXT NOT NULL DEFAULT '[]',
  visual_embedding     TEXT,
  duplicate_group_id   TEXT,
  processing_mode      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE curation_decisions (
  photo_id          TEXT PRIMARY KEY REFERENCES photo_assets(id) ON DELETE CASCADE,
  exhibition_id     TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  ai_decision       TEXT NOT NULL CHECK (ai_decision IN ('keep','hold','remove')),
  score             REAL NOT NULL,
  confidence        REAL NOT NULL,
  reasons           TEXT NOT NULL,
  related_photo_ids TEXT NOT NULL DEFAULT '[]',
  user_override     TEXT CHECK (user_override IN ('keep','hold','remove','must_keep')),
  override_reason   TEXT,
  run_id            TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE motifs (
  id                   TEXT PRIMARY KEY,
  exhibition_id        TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  user_title           TEXT,
  description          TEXT NOT NULL,
  photo_ids            TEXT NOT NULL,
  evidence             TEXT NOT NULL,
  confidence           REAL NOT NULL,
  alternative_readings TEXT NOT NULL DEFAULT '[]',
  state                TEXT NOT NULL DEFAULT 'proposed',
  run_id               TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE narrative_plans (
  exhibition_id        TEXT PRIMARY KEY REFERENCES exhibitions(id) ON DELETE CASCADE,
  selected_motif_id    TEXT,
  title                TEXT NOT NULL,
  subtitle             TEXT NOT NULL DEFAULT '',
  curatorial_statement TEXT NOT NULL,
  chapters             TEXT NOT NULL,
  tone                 TEXT NOT NULL,
  source               TEXT NOT NULL,
  input_version        INTEGER NOT NULL,
  run_id               TEXT,
  updated_at           TEXT NOT NULL
);

CREATE TABLE exhibition_layouts (
  exhibition_id TEXT PRIMARY KEY REFERENCES exhibitions(id) ON DELETE CASCADE,
  template      TEXT NOT NULL CHECK (template IN ('cinema_scroll','archive_collage')),
  background    TEXT NOT NULL,
  text_color    TEXT NOT NULL,
  sections      TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  run_id        TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE qa_reports (
  exhibition_id  TEXT PRIMARY KEY REFERENCES exhibitions(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('passed','needs_review')),
  issues         TEXT NOT NULL,
  passed_checks  TEXT NOT NULL,
  ignored_issues TEXT NOT NULL DEFAULT '[]',
  run_id         TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE agent_runs (
  id            TEXT PRIMARY KEY,
  exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  agent_type    TEXT NOT NULL CHECK (agent_type IN
    ('material_steward','aesthetic_selector','motif_finder',
     'narrative_editor','exhibition_designer','curatorial_qa')),
  status        TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
  input_version INTEGER NOT NULL,
  input_json    TEXT,
  output_json   TEXT,
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_runs_exh ON agent_runs(exhibition_id, agent_type, created_at);

CREATE TABLE user_edits (
  id            TEXT PRIMARY KEY,
  exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  target_path   TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  locked        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (exhibition_id, target_path)
);

CREATE TABLE exhibition_versions (
  id            TEXT PRIMARY KEY,
  exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  label         TEXT,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (exhibition_id, version)
);
`,
  // migration 2 — UX 专项（任务书 v2.1 §19.11）：确认门状态 + input_revision + 批量操作历史。
  // exhibitions 的 status CHECK 无法 ALTER，只能重建表；重建期间关闭外键避免隐式级联删除。
  `
CREATE TABLE exhibitions_new (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  subtitle          TEXT NOT NULL DEFAULT '',
  source_type       TEXT,
  user_intent       TEXT,
  tone              TEXT NOT NULL DEFAULT 'restrained',
  aesthetic_prefs   TEXT NOT NULL DEFAULT '{}',
  allow_exif        INTEGER NOT NULL DEFAULT 1,
  allow_external_ai INTEGER NOT NULL DEFAULT 0,
  privacy_mode      TEXT NOT NULL DEFAULT 'local_first',
  mode              TEXT NOT NULL DEFAULT 'demo',
  is_demo_set       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft',
  failed_stage      TEXT,
  stale_from        TEXT,
  selected_motif_id TEXT,
  template          TEXT NOT NULL DEFAULT 'cinema_scroll',
  current_version   INTEGER NOT NULL DEFAULT 0,
  input_revision    INTEGER NOT NULL DEFAULT 0,
  selection_confirmed_revision  INTEGER,
  selection_confirmed_photo_ids TEXT,
  selection_hold_policy         TEXT CHECK (selection_hold_policy IN ('exclude','include')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (status IN ('draft','uploading','ingesting','selecting','awaiting_selection_confirm',
    'motifs_ready','awaiting_theme_choice','writing','designing','checking',
    'awaiting_user_review','published','stage_failed'))
);
INSERT INTO exhibitions_new
  (id, title, subtitle, source_type, user_intent, tone, aesthetic_prefs,
   allow_exif, allow_external_ai, privacy_mode, mode, is_demo_set, status,
   failed_stage, stale_from, selected_motif_id, template, current_version,
   created_at, updated_at)
SELECT id, title, subtitle, source_type, user_intent, tone, aesthetic_prefs,
   allow_exif, allow_external_ai, privacy_mode, mode, is_demo_set, status,
   failed_stage, stale_from, selected_motif_id, template, current_version,
   created_at, updated_at
FROM exhibitions;
DROP TABLE exhibitions;
ALTER TABLE exhibitions_new RENAME TO exhibitions;

ALTER TABLE agent_runs ADD COLUMN workflow_id TEXT;
ALTER TABLE agent_runs ADD COLUMN input_revision INTEGER;
CREATE INDEX idx_runs_workflow ON agent_runs(exhibition_id, workflow_id);

CREATE TABLE curation_operations (
  id            TEXT PRIMARY KEY,
  exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN
    ('set_decision','restore_ai_suggestion','confirm_selection')),
  decision      TEXT,
  photo_ids     TEXT NOT NULL,
  before_json   TEXT NOT NULL,
  after_json    TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  request_id    TEXT,
  undone        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (exhibition_id, request_id)
);
CREATE INDEX idx_ops_exh ON curation_operations(exhibition_id, created_at);
`,
  // migration 3 — run 触发幂等（任务书 v2.1 §19.2.9）：request_id → workflow 映射。
  // 每次显式触发用新键，网络重试复用原键 → 返回同一 workflow，不重复启动/扣费。
  `
CREATE TABLE workflow_requests (
  exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  request_id    TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (exhibition_id, request_id)
);
`,
  // migration 4 — 叙事重跑意图（v3 R01）：与 run 同事务预留，成功发布时才应用；
  // 运行中/门禁/预算拒绝时旧编辑与语气保持原样。
  `
CREATE TABLE narrative_regenerations (
  run_id                   TEXT PRIMARY KEY,
  exhibition_id            TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  workflow_id              TEXT NOT NULL,
  scope                    TEXT NOT NULL CHECK (scope IN ('unlocked','all')),
  tone                     TEXT,
  expected_input_revision  INTEGER NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','superseded')),
  created_at               TEXT NOT NULL,
  applied_at               TEXT
);
CREATE INDEX idx_regen_exh ON narrative_regenerations(exhibition_id, created_at);
`,
  // migration 5 — 执行租约（v3 R03）：进程归属 + 心跳 + 启动恢复。
  // 崩溃后旧 running 行不再永久卡死：租约失活即标记中断，可从失败阶段重试。
  `
ALTER TABLE agent_runs ADD COLUMN owner_id TEXT;

CREATE TABLE task_leases (
  exhibition_id TEXT PRIMARY KEY REFERENCES exhibitions(id) ON DELETE CASCADE,
  owner_id      TEXT NOT NULL,
  owner_pid     INTEGER NOT NULL,
  run_id        TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_leases_owner ON task_leases(owner_id);
`,
  // migration 6 — 真实 AI 接入基础（v3 阶段 C，任务书 §7）：调用记录 / 校验结果缓存 / 预算计数。
  // ai_calls 不设影展外键：影展删除后保留脱敏审计记录；ai_cache 随影展级联清理（§7.2）。
  // ai_calls.budget_period_keys 冗余保存本次预留占用的全部计数键，供启动回收时精确归还。
  `
CREATE TABLE ai_calls (
  id                  TEXT PRIMARY KEY,
  exhibition_id       TEXT,
  scope_type          TEXT NOT NULL CHECK (scope_type IN ('workflow','job','connection_test')),
  scope_id            TEXT NOT NULL,
  agent_type          TEXT,
  workflow_id         TEXT,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  prompt_version      TEXT,
  schema_version      TEXT,
  preprocess_version  TEXT,
  attempt             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('reserved','sent','succeeded','failed','released')),
  duration_ms         INTEGER,
  usage_json          TEXT,
  provider_request_id TEXT,
  error_class         TEXT,
  error_message       TEXT,
  budget_period_keys  TEXT,
  created_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX idx_ai_calls_scope ON ai_calls(scope_type, scope_id, created_at);
CREATE INDEX idx_ai_calls_exh ON ai_calls(exhibition_id, created_at);
CREATE INDEX idx_ai_calls_reserved ON ai_calls(status, created_at);

CREATE TABLE ai_cache (
  id                  TEXT PRIMARY KEY,
  scope_type          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  exhibition_id       TEXT REFERENCES exhibitions(id) ON DELETE CASCADE,
  purpose             TEXT NOT NULL,
  cache_key           TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  preprocess_version  TEXT NOT NULL,
  result_json         TEXT NOT NULL,
  source_call_id      TEXT,
  input_digest        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (scope_type, scope_id, purpose, cache_key)
);
CREATE INDEX idx_ai_cache_scope ON ai_cache(scope_type, scope_id, purpose);

CREATE TABLE ai_budget_counters (
  scope_type TEXT NOT NULL,
  scope_id   TEXT NOT NULL,
  period_key TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_type, scope_id, period_key)
);
`,
  // migration 7 — 真实视觉事实（v3 阶段 D）：旧行保持 NULL，不冒充已完成 AI 分析。
  // 分析图只以哈希留痕，字节/Base64 不落库；副本仅在服务端内存中短暂存在。
  `
ALTER TABLE photo_inspections ADD COLUMN visual_facts_json TEXT;
ALTER TABLE photo_inspections ADD COLUMN visual_source TEXT
  CHECK (visual_source IN ('fresh','cache') OR visual_source IS NULL);
ALTER TABLE photo_inspections ADD COLUMN analysis_image_sha256 TEXT;
`,
  `
CREATE TABLE curation_jobs (
  id TEXT PRIMARY KEY,
  exhibition_id TEXT NOT NULL UNIQUE REFERENCES exhibitions(id) ON DELETE CASCADE,
  max_calls INTEGER NOT NULL CHECK (max_calls > 0),
  created_at TEXT NOT NULL
);
CREATE TABLE curation_job_workflows (
  workflow_id TEXT PRIMARY KEY,
  curation_job_id TEXT NOT NULL REFERENCES curation_jobs(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  photo_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_curation_workflows_job ON curation_job_workflows(curation_job_id);
`,
  // migration 9 — 叙事编辑 CAS + preserve 意图。高水位留在影展，回滚到无叙事再生成也不复位。
  `
ALTER TABLE narrative_plans ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0 CHECK (edit_revision >= 0);
ALTER TABLE exhibitions ADD COLUMN narrative_edit_revision INTEGER NOT NULL DEFAULT 0 CHECK (narrative_edit_revision >= 0);

CREATE TABLE narrative_regenerations_new (
  run_id                   TEXT PRIMARY KEY,
  exhibition_id            TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
  workflow_id              TEXT NOT NULL,
  scope                    TEXT NOT NULL CHECK (scope IN ('preserve','unlocked','all')),
  tone                     TEXT,
  expected_input_revision  INTEGER NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','superseded')),
  created_at               TEXT NOT NULL,
  applied_at               TEXT
);
INSERT INTO narrative_regenerations_new
  (run_id, exhibition_id, workflow_id, scope, tone, expected_input_revision, state, created_at, applied_at)
SELECT run_id, exhibition_id, workflow_id, scope, tone, expected_input_revision, state, created_at, applied_at
FROM narrative_regenerations;
DROP TABLE narrative_regenerations;
ALTER TABLE narrative_regenerations_new RENAME TO narrative_regenerations;
CREATE INDEX idx_regen_exh ON narrative_regenerations(exhibition_id, created_at);
`,
  // migration 10 — 公网匿名会话（AFTERLIGHT_PUBLIC=1 时启用）。会话无身份概念，数据滑动过期后成套清理；
  // 本机版 session_id 恒为 NULL，行为不变。
  `
ALTER TABLE exhibitions ADD COLUMN session_id TEXT;
CREATE TABLE visitor_sessions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  ai_experience_used INTEGER NOT NULL DEFAULT 0 CHECK (ai_experience_used IN (0, 1))
);
CREATE INDEX idx_exhibitions_session ON exhibitions(session_id);
CREATE INDEX idx_visitor_sessions_seen ON visitor_sessions(last_seen_at);
`,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row?.user_version ?? 0;
  if (current >= MIGRATIONS.length) {
    db.exec("PRAGMA foreign_keys=ON;");
    return;
  }
  // 表重建必须在事务外关闭外键（事务内 PRAGMA foreign_keys 无效）。
  db.exec("PRAGMA foreign_keys=OFF;");
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version=${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys=ON;");
      throw err;
    }
  }
  db.exec("PRAGMA foreign_keys=ON;");
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`迁移后外键校验失败：${JSON.stringify(violations)}`);
  }
}