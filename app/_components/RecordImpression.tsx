"use client";

import { useEffect, useRef } from "react";

/**
 * Fires once per real page view. `router.refresh()` re-renders the server
 * component but does not remount this, so a kiosk left open all day logs one
 * look rather than a few thousand.
 */
export default function RecordImpression({
  quotedWaitSeconds,
  source,
}: {
  quotedWaitSeconds: number;
  source: "kiosk" | "web";
}) {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void fetch("/api/impression", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quotedWaitSeconds, source }),
      keepalive: true,
    }).catch(() => {});
  }, [quotedWaitSeconds, source]);

  return null;
}
