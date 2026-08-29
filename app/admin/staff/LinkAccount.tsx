"use client";

import { useState, useTransition } from "react";
import { linkAccountToBarber } from "@/src/server/staff-actions";

export default function LinkAccount({
  clerkUserId,
  chairs,
}: {
  clerkUserId: string;
  chairs: { id: string; name: string }[];
}) {
  const [barberId, setBarberId] = useState(chairs[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="btn-row" style={{ alignItems: "center" }}>
      <select
        value={barberId}
        onChange={(event) => setBarberId(event.target.value)}
        aria-label="Chair to link this account to"
      >
        {chairs.map((chair) => (
          <option key={chair.id} value={chair.id}>
            {chair.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-primary"
        disabled={pending || !barberId}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await linkAccountToBarber(clerkUserId, barberId);
            if (result?.error) setError(result.error);
          });
        }}
      >
        {pending ? "Linking…" : "Link"}
      </button>
      {error ? (
        <p className="error" role="alert" style={{ width: "100%", marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
