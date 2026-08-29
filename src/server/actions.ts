"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool, getRepo, currentShopId } from "./db";
import { deviceRowId, deviceToken, tokenHash } from "./session";
import { currentStaff, requireBarberId, shopHasOwner } from "./staff";
import type { QueueEvent } from "../domain/machine";

export interface ActionState {
  error?: string;
}

/**
 * Digits only, defaulting to +1 for 10-digit input. A real deployment should
 * parse against the shop's country properly; this is enough for one US shop.
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// ------------------------------------------------------------- customers ---

export async function joinQueue(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const barberId = String(form.get("barberId") ?? "");
  const serviceId = String(form.get("serviceId") ?? "");
  const joinMethod = form.get("joinMethod") === "remote" ? "remote" : "walk_in";
  const firstName = String(form.get("firstName") ?? "").trim();
  const lastName = String(form.get("lastName") ?? "").trim();
  const phone = normalizePhone(String(form.get("phone") ?? ""));

  if (!firstName) return { error: "Enter your first name." };
  if (!phone) return { error: "Enter a valid phone number." };
  if (!serviceId) return { error: "Pick a service." };

  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `insert into customers (phone_number, first_name, last_name)
     values ($1,$2,$3)
     on conflict (phone_number) do update
       set first_name = excluded.first_name,
           last_name = coalesce(excluded.last_name, customers.last_name),
           last_seen_at = now()
     returning id`,
    [phone, firstName, lastName || null],
  );
  const customerId = rows[0]!.id;

  const token = await deviceToken();
  const deviceId = await deviceRowId(customerId, token);

  // Close the loop on the walk-out metric: this device looked at the wait and
  // then joined, so that look was not a walk-out.
  const { rows: seen } = await pool.query<{ id: string }>(
    `select qi.id
       from queue_impressions qi
       join barbers b on b.shop_id = qi.shop_id
      where b.id = $1
        and qi.device_token_hash = $2
        and qi.converted_visit_id is null
        and qi.shown_at > now() - interval '1 hour'
      order by qi.shown_at desc limit 1`,
    [barberId, tokenHash(token)],
  );
  const impressionId = seen[0]?.id ?? null;

  const result = await getRepo().join({
    barberId,
    customerId,
    serviceId,
    joinMethod,
    deviceId,
    impressionId,
  });

  if (!result.ok) return { error: result.message };
  redirect(`/visit/${result.visitId}`);
}

export async function checkIn(visitId: string): Promise<ActionState> {
  const result = await getRepo().apply(visitId, { type: "check_in" }, { type: "customer" });
  revalidatePath(`/visit/${visitId}`);
  return result.ok ? {} : { error: result.message };
}

export async function leaveQueue(visitId: string): Promise<ActionState> {
  const result = await getRepo().apply(
    visitId,
    { type: "leave", by: "customer" },
    { type: "customer" },
  );
  revalidatePath(`/visit/${visitId}`);
  return result.ok ? {} : { error: result.message };
}

// --------------------------------------------------------------- barbers ---

/** Every barber action re-derives the barber from the Clerk session. */
async function actAsBarber(
  run: (barberId: string) => Promise<{ ok: boolean; message?: string }>,
): Promise<ActionState> {
  const barberId = await requireBarberId();
  if (!barberId) {
    return { error: "Your account is not linked to a chair. Ask the shop owner." };
  }
  const result = await run(barberId);
  revalidatePath("/barber");
  return result.ok ? {} : { error: result.message ?? "That did not work." };
}

export async function callNext(): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    const result = await getRepo().callNext(barberId, { type: "barber", id: barberId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  });
}

/** Guards that the visit belongs to the signed-in barber before touching it. */
async function applyOwn(visitId: string, event: QueueEvent): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    const { rows } = await getPool().query<{ barber_id: string }>(
      `select barber_id from visits where id = $1`,
      [visitId],
    );
    if (rows[0]?.barber_id !== barberId) {
      return { ok: false, message: "That customer is not in your queue." };
    }
    const result = await getRepo().apply(visitId, event, { type: "barber", id: barberId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  });
}

export async function startVisit(visitId: string): Promise<ActionState> {
  return applyOwn(visitId, { type: "start" });
}

export async function completeVisit(visitId: string): Promise<ActionState> {
  return applyOwn(visitId, { type: "complete" });
}

export async function markNoShow(visitId: string): Promise<ActionState> {
  return applyOwn(visitId, { type: "no_show", reason: "barber_marked" });
}

export async function removeFromQueue(visitId: string): Promise<ActionState> {
  return applyOwn(visitId, { type: "leave", by: "barber" });
}

export async function startBreak(minutes: number): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    await getPool().query(
      `update barbers
          set presence = 'on_break', break_until = now() + make_interval(mins => $2)
        where id = $1`,
      [barberId, Math.max(1, Math.min(240, Math.round(minutes)))],
    );
    return { ok: true };
  });
}

export async function endBreak(): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    await getPool().query(
      `update barbers set presence = 'available', break_until = null where id = $1`,
      [barberId],
    );
    return { ok: true };
  });
}

export async function setAvailability(presence: "available" | "off"): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    await getPool().query(
      `update barbers set presence = $2::barber_presence, break_until = null where id = $1`,
      [barberId, presence],
    );
    return { ok: true };
  });
}

export async function setRemoteJoins(open: boolean): Promise<ActionState> {
  return actAsBarber(async (barberId) => {
    await getPool().query(`update barbers set accepting_remote_joins = $2 where id = $1`, [
      barberId,
      open,
    ]);
    return { ok: true };
  });
}

/** Time-driven transitions. Called by the client poll and by the cron backstop. */
export async function runSweep(): Promise<void> {
  await getRepo().sweep(await currentShopId());
}
