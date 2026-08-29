import { NextResponse } from "next/server";
import { currentShopId } from "@/src/server/db";
import { recordImpression } from "@/src/server/metrics";
import { deviceToken, tokenHash } from "@/src/server/session";

export const dynamic = "force-dynamic";

/**
 * Records that somebody looked at the queue.
 *
 * Driven from the client rather than from the page render for two reasons: a
 * route handler can issue the device cookie (a render cannot), and a live page
 * refreshing itself every twenty seconds must not log a fresh walk-out each
 * time. Without both, the walk-out number is noise.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      quotedWaitSeconds?: number;
      source?: "kiosk" | "web";
      barberId?: string | null;
    };
    const token = await deviceToken();
    await recordImpression({
      shopId: await currentShopId(),
      barberId: body.barberId ?? null,
      source: body.source === "kiosk" ? "kiosk" : "web",
      quotedWaitSeconds: Math.max(0, Math.round(body.quotedWaitSeconds ?? 0)),
      deviceTokenHash: tokenHash(token),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    // Never let analytics break the page a customer is trying to use.
    console.error("impression failed", error);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
