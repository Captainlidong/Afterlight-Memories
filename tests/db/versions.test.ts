import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { insertVersion, listVersions, getVersion, pruneVersions } from "@/lib/db/versions";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let tmp: string;
let exh: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterlight-versions-"));
  process.env.AFTERLIGHT_DATA_DIR = tmp;
  db = createDb(":memory:");
  exh = createExhibition(db, CreateExhibitionInput.parse({}), "demo").id;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AFTERLIGHT_DATA_DIR;
});

describe("exhibition_versions repo（快照 CRUD）", () => {
  it("insertVersion + getVersion 返回解析后的 snapshot", () => {
    const snap = { narrative: { title: "v1" }, user_edits: [], template: "cinema_scroll" };
    const v = insertVersion(db, exh, 1, snap, "初始叙事");
    expect(v.version).toBe(1);
    expect(v.label).toBe("初始叙事");
    const got = getVersion(db, exh, 1)!;
    expect(got.snapshot).toEqual(snap);
  });

  it("listVersions 按 version 倒序，仅摘要（不含 snapshot）", () => {
    insertVersion(db, exh, 2, { narrative: { title: "v2" } });
    insertVersion(db, exh, 3, { narrative: { title: "v3" } });
    const list = listVersions(db, exh);
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((list[0] as unknown as { snapshot?: unknown }).snapshot).toBeUndefined();
    expect(list[0].label).toBeNull();
  });

  it("getVersion 不存在 → null", () => {
    expect(getVersion(db, exh, 99)).toBeNull();
  });

  it("pruneVersions 仅保留最近 N 个", () => {
    for (let v = 4; v <= 14; v++) insertVersion(db, exh, v, { v });
    pruneVersions(db, exh, 10);
    const list = listVersions(db, exh);
    expect(list.length).toBe(10);
    expect(list.map((v) => v.version)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
    expect(getVersion(db, exh, 4)).toBeNull();
  });
});