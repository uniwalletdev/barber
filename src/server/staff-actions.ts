"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { getPool, currentShopId } from "./db";
import { currentStaff } from "./staff";
import type { ActionState } from "./actions";

/**
 * One-time claim: the first person to sign in takes ownership of the shop.
 * Guarded by the shop having no owner, so it closes permanently the moment it
 * is used.
 */
export async function claimShop(): Promise<ActionState> {
  const user = await currentUser();
  if (!user) return { error: "Sign in first." };

  const shopId = await currentShopId();
  const pool = getPool();

  // Race-safe: the insert only lands when no owner row exists yet.
  const { rowCount } = await pool.query(
    `insert into staff (clerk_user_id, shop_id, role, email, display_name)
     select $1, $2, 'owner', $3, $4
      where not exists (select 1 from staff where shop_id = $2 and role = 'owner')
     on conflict (clerk_user_id) do nothing`,
    [
      user.id,
      shopId,
      user.primaryEmailAddress?.emailAddress ?? null,
      [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    ],
  );
  if (!rowCount) return { error: "This shop already has an owner." };
  redirect("/admin/staff");
}

async function asOwner(
  run: (shopId: string) => Promise<ActionState>,
): Promise<ActionState> {
  const staff = await currentStaff();
  if (staff?.role !== "owner") return { error: "Only the shop owner can do that." };
  const result = await run(staff.shopId);
  revalidatePath("/admin/staff");
  return result;
}

export async function linkAccountToBarber(
  clerkUserId: string,
  barberId: string,
): Promise<ActionState> {
  return asOwner(async (shopId) => {
    const client = await clerkClient();
    let email: string | null = null;
    let name: string | null = null;
    try {
      const user = await client.users.getUser(clerkUserId);
      email = user.primaryEmailAddress?.emailAddress ?? null;
      name = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
    } catch {
      // The account may have been deleted in Clerk between page load and click.
      return { error: "That account no longer exists in Clerk." };
    }

    try {
      await getPool().query(
        `insert into staff (clerk_user_id, shop_id, barber_id, role, email, display_name)
         values ($1, $2, $3, 'barber', $4, $5)
         on conflict (clerk_user_id) do update
           set barber_id = excluded.barber_id, role = 'barber',
               email = excluded.email, display_name = excluded.display_name`,
        [clerkUserId, shopId, barberId, email, name],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "staff_one_account_per_barber") {
        return { error: "Another account is already linked to that chair." };
      }
      throw error;
    }
    return {};
  });
}

export async function unlinkAccount(clerkUserId: string): Promise<ActionState> {
  return asOwner(async () => {
    const { userId } = await auth();
    if (userId === clerkUserId) {
      return { error: "You cannot remove your own access." };
    }
    await getPool().query(`delete from staff where clerk_user_id = $1`, [clerkUserId]);
    return {};
  });
}
