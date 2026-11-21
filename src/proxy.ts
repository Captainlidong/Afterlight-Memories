import { NextResponse, type NextRequest } from "next/server";
import { assertLocalMutation } from "@/lib/api/localRequest";
import { errorResponse } from "@/lib/api/errors";

export function proxy(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD") return NextResponse.next();
  try {
    assertLocalMutation(req);
    return NextResponse.next();
  } catch (err) {
    return errorResponse(err);
  }
}

export const config = { matcher: "/api/:path*" };
