import Link from "next/link";
import { redirect } from "next/navigation";
import { currentShopId } from "@/src/server/db";
import { currentStaff, shopHasOwner } from "@/src/server/staff";
import { claimShop } from "@/src/server/staff-actions";
import ActionButton from "@/app/_components/ActionButton";

import NotConfigured from "@/app/_components/NotConfigured";
import { clerkConfigured } from "@/src/server/clerk-config";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!clerkConfigured) return <NotConfigured />;

  const shopId = await currentShopId();
  const staff = await currentStaff();
  if (staff) redirect(staff.role === "owner" ? "/admin" : "/barber");

  const claimed = await shopHasOwner(shopId);

  return (
    <main className="wrap" style={{ maxWidth: 520 }}>
      <h1>{claimed ? "Waiting on the owner" : "Claim this shop"}</h1>

      {claimed ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            This shop already has an owner. Ask them to link your account to your chair
            and it will show up here.
          </p>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <Link href="/" className="btn">
              Back to the shop
            </Link>
          </div>
        </div>
      ) : (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Nobody owns this shop yet. Claiming it makes you the owner: you&apos;ll see
            shop-wide numbers and be able to link each barber&apos;s account to their chair.
          </p>
          <p className="notice">
            This can only happen once. After you claim it, everyone else has to be linked
            by you.
          </p>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <ActionButton action={claimShop} className="btn-primary btn-block">
              Claim this shop
            </ActionButton>
          </div>
        </div>
      )}
    </main>
  );
}
