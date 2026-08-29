/**
 * Barber PIN hashing. Deliberately free of any Next.js or request context so
 * that setup scripts can use it too.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (p: string, s: string, k: number) => Promise<Buffer>;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(pin, salt, 32);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const key = await scrypt(pin, salt, 32);
  const given = Buffer.from(expected, "hex");
  return key.length === given.length && timingSafeEqual(key, given);
}
