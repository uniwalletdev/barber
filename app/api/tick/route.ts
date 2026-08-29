import { NextResponse } from "next/server";
import { currentShopId } from "@/src/server/db";
import { tick } from "@/src/server/queries";

export const dynamic = "force-dynamic";

/**
 * Advances time-driven transitions: expired call grace, and remote customers
 * who never arrived. Driven by open dashboards and customer pages, because a
 * grace timer measured in minutes cannot wait on a daily cron.
 *
 * Idempotent — every decision is re-derived from state, so calling it twice in
 * the same second changes nothing.
 */
export async function POST() {
  try {
    const counts = await tick(await currentShopId());
    return NextResponse.json(counts);
  } catch (error) {
    console.error("tick failed", error);
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
