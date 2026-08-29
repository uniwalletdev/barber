import { NextResponse } from "next/server";
import { currentShopId } from "@/src/server/db";
import { tick } from "@/src/server/queries";

export const dynamic = "force-dynamic";

/**
 * Backstop sweep for when nobody has a page open. Vercel Cron calls this with
 * the project's CRON_SECRET as a bearer token; on the Hobby plan it can only
 * fire daily, so the client-driven /api/tick is what keeps the queue moving
 * during a shift.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const counts = await tick(await currentShopId());
  return NextResponse.json({ ok: true, ...counts });
}
