import { NextResponse, type NextRequest } from "next/server";
import { assertLocalMutation, assertVisitorApiMutation } from "@/lib/api/localRequest";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { isPublicVisitorMode, isValidVisitorSid, mintVisitorSid, VISITOR_COOKIE } from "@/lib/visitor/cookie";

export function proxy(req: NextRequest) {
  // 公网完整版（AFTERLIGHT_PUBLIC=1）：访客会话签发 + 访客写守卫。
  // 影展归属与额度校验需要数据库，由具体路由调用 visitor/access 完成。
  if (isPublicVisitorMode()) return handleVisitor(req);
  // 本机版：原行为不变。
  if (req.method === "GET" || req.method === "HEAD") return NextResponse.next();
  try {
    assertLocalMutation(req);
    return NextResponse.next();
  } catch (err) {
    return errorResponse(err);
  }
}

function handleVisitor(req: NextRequest) {
  // 可选加固（AFTERLIGHT_PROXY_TOKEN）：设置后所有请求必须携带同值令牌（由边缘函数附加），
  // 直连源站的裸请求一律 403——包括伪装 Host 的伪造请求（不做任何基于请求头的豁免）。
  // 服务器本机诊断请附带令牌：
  //   curl -H "x-afterlight-proxy: $AFTERLIGHT_PROXY_TOKEN" http://127.0.0.1:3000/functions/v1/app/api/health
  const expectedToken = process.env.AFTERLIGHT_PROXY_TOKEN?.trim();
  if (expectedToken && req.headers.get("x-afterlight-proxy") !== expectedToken) {
    return errorResponse(new ApiError(403, "proxy_required", "请通过站点页面访问。"));
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const res = NextResponse.next();
    const sid = req.cookies.get(VISITOR_COOKIE)?.value;
    if (!isValidVisitorSid(sid)) {
      // 匿名临时工牌：无身份概念；HttpOnly + SameSite=Lax 防脚本读取与跨站携带。
      res.cookies.set({
        name: VISITOR_COOKIE,
        value: mintVisitorSid(),
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 120,
        secure: req.nextUrl.protocol === "https:",
      });
    }
    return res;
  }
  try {
    assertVisitorApiMutation(req);
    return NextResponse.next();
  } catch (err) {
    return errorResponse(err);
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|demo/|favicon.ico).*)",
    // basePath 形态（Qoder Sites 边缘代理）：上一条自动带前缀，覆盖不到基址根
    // （/functions/v1/app 精确路径）——访客落地根路径也要签发会话 Cookie，补一条精确匹配。
    "/",
  ],
};
