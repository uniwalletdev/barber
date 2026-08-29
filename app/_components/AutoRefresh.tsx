"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a live view current, and drives the time-based sweep.
 *
 * Vercel Cron on the Hobby plan only fires daily, which is far too slow for a
 * call-grace timer — so the open dashboard and the customer's own page are what
 * actually tick the queue. The cron route stays as a backstop for an empty shop.
 */
export default function AutoRefresh({
  intervalMs = 15_000,
  sweep = false,
}: {
  intervalMs?: number;
  sweep?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (document.hidden) return;
      try {
        if (sweep) await fetch("/api/tick", { method: "POST", cache: "no-store" });
      } catch {
        // Offline or asleep: try again on the next tick rather than surfacing it.
      }
      if (!cancelled) router.refresh();
    };

    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, sweep, router]);

  return null;
}
