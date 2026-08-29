"use client";

import { useActionState, useState } from "react";
import { joinQueue, type ActionState } from "@/src/server/actions";
import type { ServiceOption } from "@/src/server/queries";

export default function JoinForm({
  barberId,
  services,
  atShop,
  remoteFull,
  remoteSlotsLeft,
}: {
  barberId: string;
  services: ServiceOption[];
  atShop: boolean;
  remoteFull: boolean;
  remoteSlotsLeft: number;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(joinQueue, {});
  const [joinMethod, setJoinMethod] = useState<"remote" | "walk_in">(
    atShop || remoteFull ? "walk_in" : "remote",
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="barberId" value={barberId} />
      <input type="hidden" name="joinMethod" value={joinMethod} />

      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="firstName">First name</label>
        <input id="firstName" name="firstName" type="text" autoComplete="given-name" required />
      </div>

      <div className="field">
        <label htmlFor="lastName">Last name (optional)</label>
        <input id="lastName" name="lastName" type="text" autoComplete="family-name" />
      </div>

      <div className="field">
        <label htmlFor="phone">Mobile number</label>
        <input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" required />
      </div>

      <div className="field">
        <label htmlFor="serviceId">Service</label>
        <select id="serviceId" name="serviceId" defaultValue={services[0]?.id} required>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.displayName} · about {Math.round(service.defaultDurationSeconds / 60)} min
            </option>
          ))}
        </select>
      </div>

      <div className="btn-row" style={{ marginTop: 22 }}>
        <button
          type="submit"
          className="btn-primary btn-block"
          disabled={pending}
          onClick={() => setJoinMethod("walk_in")}
        >
          {pending ? "Joining…" : "I'm at the shop — join now"}
        </button>

        {!remoteFull ? (
          <button
            type="submit"
            className="btn-block"
            disabled={pending}
            onClick={() => setJoinMethod("remote")}
          >
            Hold my spot — I'm on my way
          </button>
        ) : null}
      </div>

      <p className="lede" style={{ marginTop: 16, fontSize: 14 }}>
        {remoteFull
          ? "All remote spots are taken right now. Come in to join the line."
          : `Holding a spot keeps your place while you travel — you'll need to check in when you arrive. ${remoteSlotsLeft} of these spots left.`}
      </p>
    </form>
  );
}
