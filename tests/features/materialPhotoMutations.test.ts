import { describe, expect, it } from "vitest";
import { clearPhotosWithReport, deletePhotoRequest } from "@/features/material/MaterialBoard";

/** 阶段 D 修复回归（旧质检遗留：素材删除/清空网络错误反馈）。
 *  真实复现路径：服务不可达时点"清空"曾永久卡在加载态且无任何提示。
 *  本回归锁定提取后的请求层行为：不抛出、结构化统计、服务端中文消息透出。 */

const okResponse = () => new Response(null, { status: 200 });
const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: "x", message } }), { status });
const networkError = () => {
  throw new TypeError("Failed to fetch");
};

describe("素材删除/清空的网络失败反馈", () => {
  it("服务完全不可达：逐张尝试不中断，全部计为失败且不透出英文错误", async () => {
    const report = await clearPhotosWithReport("exh", [{ id: "p1" }, { id: "p2" }, { id: "p3" }], networkError as unknown as typeof fetch);
    expect(report).toEqual({ removed: 0, failed: 3, serverMessage: null });
  });

  it("部分失败：成功张数与失败张数分别统计", async () => {
    const impl = (async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith("/p2") || path.endsWith("/p3")) return networkError();
      return okResponse();
    }) as unknown as typeof fetch;
    const report = await clearPhotosWithReport("exh", [{ id: "p1" }, { id: "p2" }, { id: "p3" }], impl);
    expect(report.removed).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.serverMessage).toBeNull();
  });

  it("服务端业务拒绝（如运行中 409）的中文消息透出，供界面显示", async () => {
    const impl = (async () => jsonError(409, "影展正在生成中，请稍后再试。")) as unknown as typeof fetch;
    const outcome = await deletePhotoRequest("exh", "p1", impl);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("影展正在生成中，请稍后再试。");
  });

  it("非 JSON 错误体也安全返回 null 消息，不抛出", async () => {
    const impl = (async () => new Response("<html>boom</html>", { status: 500 })) as unknown as typeof fetch;
    const outcome = await deletePhotoRequest("exh", "p1", impl);
    expect(outcome).toEqual({ ok: false, message: null });
  });

  it("全部成功：removed 等于总数且无消息", async () => {
    const impl = (async () => okResponse()) as unknown as typeof fetch;
    const report = await clearPhotosWithReport("exh", [{ id: "p1" }, { id: "p2" }], impl);
    expect(report).toEqual({ removed: 2, failed: 0, serverMessage: null });
  });
});
