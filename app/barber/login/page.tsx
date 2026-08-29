"use client";

import { useActionState } from "react";
import { barberLogin, type ActionState } from "@/src/server/actions";

export default function BarberLogin() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(barberLogin, {});

  return (
    <main className="wrap" style={{ maxWidth: 420 }}>
      <h1>Barber sign in</h1>
      <p className="lede">Your queue, your customers.</p>

      <form action={formAction} className="card">
        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" name="phone" type="tel" autoComplete="username" inputMode="tel" required />
        </div>

        <div className="field">
          <label htmlFor="pin">PIN</label>
          <input
            id="pin"
            name="pin"
            type="password"
            autoComplete="current-password"
            inputMode="numeric"
            required
          />
        </div>

        <button type="submit" className="btn-primary btn-block" disabled={pending}>
          {pending ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
