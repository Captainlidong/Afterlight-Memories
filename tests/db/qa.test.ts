import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput, type QaReportT, type QaIssueT } from "@/lib/agents/schemas";
import { replaceQa, getQa, setIgnoredKeys, issueKey } from "@/lib/db/qa";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;

const warnIssue: QaIssueT = {
  id: "qa_1",
  severity: "medium",
  type: "similar_run",
  message: "三张相似照片连续满屏。",
  photo_ids: ["photo_b", "photo_a"],
  auto_fix_available: true,
};

const report: QaReportT = {
  status: "needs_review",
  issues: [
    warnIssue,
    {
      id: "qa_2",
      severity: "low",
      type: "privacy_hint",
      message: "发布前请人工检查人脸/车牌/地址等隐私信息。",
      photo_ids: [],
      auto_fix_available: false,
    },
  ],
  passed_checks: ["跨 section 无重复"],
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-qa-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("qa_reports repo（每影展一条当前行 + 忽略键跨重跑保留）", () => {
  it("尚未质检 → getQa 返回 null", () => {
    expect(getQa(db, exh)).toBeNull();
  });

  it("replaceQa 落库：medium 问题 → needs_review，issues 全量返回", () => {
    const dto = replaceQa(db, exh, report, { runId: "run_1" });
    expect(dto.status).toBe("needs_review");
    expect(dto.issues.length).toBe(2);
    expect(dto.ignored_keys).toEqual([]);
    expect(dto.passed_checks).toEqual(["跨 section 无重复"]);
    expect(dto.run_id).toBe("run_1");
    const again = getQa(db, exh)!;
    expect(again.issues.map((i) => i.id)).toEqual(["qa_1", "qa_2"]);
  });

  it("仅 low 问题 → passed", () => {
    const lowOnly: QaReportT = { status: "passed", issues: [report.issues[1]], passed_checks: [] };
    const dto = replaceQa(db, exh, lowOnly, {});
    expect(dto.status).toBe("passed");
  });

  it("忽略键跨重跑保留：被忽略的问题不再出现在 issues，status 重算", () => {
    const key = issueKey(warnIssue);
    replaceQa(db, exh, report, { runId: "run_2" });
    setIgnoredKeys(db, exh, [key]);
    let dto = getQa(db, exh)!;
    expect(dto.ignored_keys).toEqual([key]);
    expect(dto.issues.map((i) => i.type)).toEqual(["privacy_hint"]);
    expect(dto.status).toBe("passed");

    replaceQa(db, exh, report, { runId: "run_3" });
    dto = getQa(db, exh)!;
    expect(dto.ignored_keys).toEqual([key]);
    expect(dto.issues.map((i) => i.type)).toEqual(["privacy_hint"]);
    expect(dto.status).toBe("passed");
  });

  it("issueKey 与 photo_ids 顺序无关、含 chapter_id", () => {
    const a = issueKey({ ...warnIssue, photo_ids: ["photo_a", "photo_b"] });
    const b = issueKey({ ...warnIssue, photo_ids: ["photo_b", "photo_a"] });
    expect(a).toBe(b);
    const c = issueKey({ ...warnIssue, chapter_id: "chapter_01" });
    expect(c).not.toBe(a);
  });

  it("再次 replaceQa 覆盖同一行（不新增）", () => {
    replaceQa(db, exh, report, { runId: "run_4" });
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM qa_reports WHERE exhibition_id=?")
      .get(exh) as { c: number };
    expect(rows.c).toBe(1);
  });
});