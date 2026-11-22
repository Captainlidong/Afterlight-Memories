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
  // 可选加固（AFTERLIGHT_PROXY_TOKEN）：设置后源站只接受边缘函数附带同值令牌的请求，
  // 直连源站的裸请求一律 403——配合网关隐藏 IP，源站不再提供绕过站点的直达入口。
  // 例外：服务器本机回环诊断（无转发头且 Host 为回环地址）不受影响，作者仍可 curl 自检。
  const expectedToken = process.env.AFTERLIGHT_PROXY_TOKEN?.trim();
  if (expectedToken && req.headers.get("x-afterlight-proxy") !== expectedToken) {
    const host = req.headers.get("host") ?? "";
    const loopbackLocal = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(host) && !req.headers.has("x-forwarded-host");
    if (!loopbackLocal) {
      return errorResponse(new ApiError(403, "proxy_required", "请通过站点页面访问。"));
    }
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
