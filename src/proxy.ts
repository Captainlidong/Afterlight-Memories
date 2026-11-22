import { NextResponse, type NextRequest } from "next/server";
import { assertLocalMutation, assertVisitorApiMutation } from "@/lib/api/localRequest";
import { errorResponse } from "@/lib/api/errors";
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

export const config = { matcher: ["/((?!_next/static|_next/image|demo/|favicon.ico).*)"] };
