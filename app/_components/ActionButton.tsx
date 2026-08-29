"use client";

import { useState, useTransition } from "react";
import type { ActionState } from "@/src/server/actions";

/**
 * A button that runs a server action and shows what came back if it failed.
 * Rejections from the state machine are user-facing sentences, so they are
 * surfaced verbatim rather than replaced with a generic message.
 */
export default function ActionButton({
  action,
  children,
  className = "",
  confirm,
  disabled,
}: {
  action: () => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={pending || disabled}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          startTransition(async () => {
            const result = await action();
            if (result?.error) setError(result.error);
          });
        }}
      >
        {pending ? "Working…" : children}
      </button>
      {error ? (
        <p className="error" role="alert" style={{ marginTop: 10, width: "100%" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
