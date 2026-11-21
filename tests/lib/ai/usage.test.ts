import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb } from "@/lib/db/client";
import { createExhibition } from "@/lib/db/repos";
import { createRun, updateRun } from "@/lib/db/runs";
import { CreateExhibitionInput } from "@/lib/agents/schemas";
import { loadAiConfig } from "@/lib/ai/config";
import { reserveAiCall, markAiCallSent, releaseAiReservation } from "@/lib/ai/budget";
import { updateAiCall } from "@/lib/ai/records";
import { getExhibitionAiUsage } from "@/lib/ai/usage";

const config = loadAiConfig({ NODE_ENV: "test", AI_API_KEY: "fake-usage-secret", AI_BASE_URL: "https://example.invalid/v1", AI_VISION_MODEL: "vision-test", AI_MAX_CALLS_PER_JOB: "40", AI_MAX_CALLS_PER_DAY: "100" });
let db: DatabaseSync;
let id: string;
const date = new Date("2026-11-20T04:00:00Z");
beforeEach(() => { db = createDb(":memory:"); id = createExhibition(db, CreateExhibitionInput.parse({ allow_external_ai: true }), "ai").id; });
afterEach(() => db.close());
function call(workflow: string, purpose: "vision" | "connection_test" = "vision") {
  return reserveAiCall(db, { exhibitionId: purpose === "vision" ? id : null, scopeType: purpose === "vision" ? "workflow" : "connection_test", scopeId: workflow, workflowId: workflow, provider: config.provider, model: "vision-test", purpose }, config, date);
}

describe("read-only usage and persisted progress", () => {
  it("selects the latest probe when timestamps tie", () => {
    const first = call("probe-old", "connection_test"); markAiCallSent(db, first.id);
    const second = call("probe-current", "connection_test"); markAiCallSent(db, second.id);
    const third = call("probe-current", "connection_test"); markAiCallSent(db, third.id);
    expect(getExhibitionAiUsage(db, id, "current", config, date).probes.latest_attempts).toBe(2);
  });
  it("separates current attempts, lifetime business quota, daily and probes without changing counters", () => {
    const old = call("old"); markAiCallSent(db, old.id); updateAiCall(db, old.id, { status: "failed" });
    const fresh = call("current"); markAiCallSent(db, fresh.id); updateAiCall(db, fresh.id, { status: "succeeded", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const unsent = call("current"); releaseAiReservation(db, unsent.id);
    const probe = call("probe", "connection_test"); markAiCallSent(db, probe.id); updateAiCall(db, probe.id, { status: "succeeded" });
    const before = db.prepare("SELECT * FROM ai_budget_counters").all();
    const usage = getExhibitionAiUsage(db, id, "current", config, date);
    expect(usage.run).toMatchObject({ attempts: 1, succeeded: 1, failed: 0, known_total_tokens: 15, unknown_usage: 0 });
    expect(usage.business).toEqual({ used: 2, limit: 40, remaining: 38 });
    expect(usage.daily).toMatchObject({ used: 3, limit: 100, remaining: 97 });
    expect(usage.probes).toMatchObject({ hourly_used: 1, latest_attempts: 1 });
    expect(usage.cost).toBe("unpriced");
    expect(JSON.stringify(usage)).not.toContain("fake-usage-secret");
    expect(JSON.stringify(usage)).not.toContain("example.invalid");
    expect(db.prepare("SELECT * FROM ai_budget_counters").all()).toEqual(before);
  });
  it("keeps unknown sent results and missing usage distinct from zero or successful completion", () => {
    const sent = call("current"); markAiCallSent(db, sent.id);
    const usage = getExhibitionAiUsage(db, id, "current", config, date);
    expect(usage.run).toMatchObject({ attempts: 1, succeeded: 0, uncertain: 1, unknown_usage: 1, known_total_tokens: null });
    expect(usage.material).toBeNull();
  });
  it("loads material counts only from persisted run progress and identifies outdated input", () => {
    const run = createRun(db, { exhibitionId: id, agentType: "material_steward", inputVersion: 0, inputRevision: 0, workflowId: "current" });
    updateRun(db, run.id, { output: { total: 30, processed: 29, reused: 29, newly_completed: 0, failed: 1, pending: 0, photo_results: [] } });
    const material = getExhibitionAiUsage(db, id, "current", config, date).material;
    expect(material).toMatchObject({ total: 30, processed: 29, reused: 29, failed: 1, current_input: true });
    db.prepare("UPDATE exhibitions SET input_revision=1 WHERE id=?").run(id);
    expect(getExhibitionAiUsage(db, id, "current", config, date).material).toMatchObject({ current_input: false });
  });
  it("does not display a previous workflow's completed material as this workflow's progress", () => {
    const old = createRun(db, { exhibitionId: id, agentType: "material_steward", inputVersion: 0, inputRevision: 0, workflowId: "old" });
    updateRun(db, old.id, { output: { total: 30, processed: 30, reused: 0, newly_completed: 30, failed: 0, pending: 0, photo_results: [] } });
    expect(getExhibitionAiUsage(db, id, "new", config, date).material).toBeNull();
    expect(getExhibitionAiUsage(db, id, "old", config, date).material).toMatchObject({ processed: 30 });
  });
});
