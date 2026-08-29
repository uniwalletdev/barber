import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getPool } from "./db";

export type StaffRole = "barber" | "owner";

export interface Staff {
  clerkUserId: string;
  shopId: string;
  barberId: string | null;
  role: StaffRole;
  email: string | null;
  displayName: string | null;
}

/** The signed-in staff member, or null if they have no linked account yet. */
export async function currentStaff(): Promise<Staff | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const { rows } = await getPool().query(
    `select clerk_user_id, shop_id, barber_id, role, email, display_name
       from staff where clerk_user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clerkUserId: row.clerk_user_id,
    shopId: row.shop_id,
    barberId: row.barber_id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
  };
}

/**
 * The barber whose queue the caller owns. A barber may only ever act on their
 * own chair, so every mutation re-derives this rather than trusting an id from
 * the client.
 */
export async function requireBarberId(): Promise<string | null> {
  const staff = await currentStaff();
  return staff?.role === "barber" ? staff.barberId : null;
}

export async function requireOwner(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect("/setup");
  if (staff.role !== "owner") redirect("/barber");
  return staff;
}

/** True while nobody has claimed this shop — gates the one-time setup page. */
export async function shopHasOwner(shopId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `select 1 from staff where shop_id = $1 and role = 'owner' limit 1`,
    [shopId],
  );
  return (rowCount ?? 0) > 0;
}

export interface PendingAccount {
  clerkUserId: string;
  email: string | null;
  name: string | null;
}

/**
 * Clerk accounts that exist but are not yet linked to a chair. Owner-only, and
 * deliberately not a server action — it reads the shop's whole Clerk user list,
 * which nothing should be able to call directly.
 */
export async function pendingAccounts(): Promise<PendingAccount[]> {
  const staff = await currentStaff();
  if (staff?.role !== "owner") return [];

  const client = await clerkClient();
  const { data } = await client.users.getUserList({ limit: 100 });
  const { rows } = await getPool().query<{ clerk_user_id: string }>(
    `select clerk_user_id from staff`,
  );
  const linked = new Set(rows.map((r) => r.clerk_user_id));

  return data
    .filter((user) => !linked.has(user.id))
    .map((user) => ({
      clerkUserId: user.id,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    }));
}
