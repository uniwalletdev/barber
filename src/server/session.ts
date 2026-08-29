import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getPool } from "./db";

const DEVICE_COOKIE = "device_token";
const YEAR = 60 * 60 * 24 * 365;

/**
 * Customer-side identity only. Staff authentication is Clerk's job; customers
 * deliberately have no account, so the device is what identity they have.
 */
function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production.");
  }
  return "dev-only-insecure-secret";
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const index = signed.lastIndexOf(".");
  if (index < 1) return null;
  const value = signed.slice(0, index);
  const expected = createHmac("sha256", secret()).update(value).digest("base64url");
  const given = signed.slice(index + 1);
  if (given.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? value : null;
}

/**
 * With no password and no SMS verification, the device is the credential. The
 * token is what stops one phone holding every remote spot in the shop.
 */
export async function deviceToken(): Promise<string> {
  const jar = await cookies();
  const existing = unsign(jar.get(DEVICE_COOKIE)?.value);
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  jar.set(DEVICE_COOKIE, sign(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: YEAR,
  });
  return token;
}

/** Reads the device token without issuing one (safe during a render). */
export async function peekDeviceToken(): Promise<string | null> {
  const jar = await cookies();
  return unsign(jar.get(DEVICE_COOKIE)?.value);
}

export function tokenHash(token: string): string {
  return createHmac("sha256", secret()).update(token).digest("hex");
}

/** Finds or creates the customer_devices row for this browser. */
export async function deviceRowId(customerId: string, token: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into customer_devices (customer_id, token_hash)
     values ($1, $2)
     on conflict (token_hash) do update set last_used_at = now()
     returning id`,
    [customerId, tokenHash(token)],
  );
  return rows[0]!.id;
}
