import Link from "next/link";
import { getPool } from "@/src/server/db";
import { pendingAccounts, requireOwner } from "@/src/server/staff";
import LinkAccount from "./LinkAccount";
import UnlinkButton from "./UnlinkButton";

import NotConfigured from "@/app/_components/NotConfigured";
import { clerkConfigured } from "@/src/server/clerk-config";

export const dynamic = "force-dynamic";

interface ChairRow {
  barber_id: string;
  barber_name: string;
  clerk_user_id: string | null;
  email: string | null;
  display_name: string | null;
}

export default async function StaffPage() {
  if (!clerkConfigured) return <NotConfigured />;

  const owner = await requireOwner();

  const { rows: chairs } = await getPool().query<ChairRow>(
    `select b.id as barber_id, b.name as barber_name,
            s.clerk_user_id, s.email, s.display_name
       from barbers b
       left join staff s on s.barber_id = b.id
      where b.shop_id = $1 and b.active
      order by b.sort_order, b.name`,
    [owner.shopId],
  );
  const pending = await pendingAccounts();
  const unlinkedChairs = chairs.filter((c) => !c.clerk_user_id);

  return (
    <main className="wrap wrap-wide">
      <div className="masthead">
        <h1>Staff access</h1>
        <Link href="/admin" className="btn-quiet">
          ← Shop numbers
        </Link>
      </div>
      <p className="lede">
        Each barber signs up themselves, then you link their account to their chair. A
        linked barber sees only their own queue.
      </p>

      <h2>Chairs</h2>
      <div className="card">
        <table className="staff-table">
          <thead>
            <tr>
              <th>Barber</th>
              <th>Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {chairs.map((chair) => (
              <tr key={chair.barber_id}>
                <td style={{ fontWeight: 600 }}>{chair.barber_name}</td>
                <td>
                  {chair.clerk_user_id ? (
                    <>
                      <span className="pill pill-linked">linked</span>{" "}
                      {chair.email ?? chair.display_name ?? chair.clerk_user_id}
                    </>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>Not linked — cannot sign in</span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>
                  {chair.clerk_user_id ? (
                    <UnlinkButton
                      clerkUserId={chair.clerk_user_id}
                      label={chair.barber_name}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Waiting to be linked ({pending.length})</h2>
      <div className="card">
        {pending.length === 0 ? (
          <p className="empty" style={{ padding: "8px 0" }}>
            Nobody waiting. Accounts appear here once someone signs up.
          </p>
        ) : unlinkedChairs.length === 0 ? (
          <p className="notice">
            Every chair already has an account linked. Add a barber first, or unlink an
            existing account.
          </p>
        ) : (
          <table className="staff-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Chair</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((account) => (
                <tr key={account.clerkUserId}>
                  <td>
                    <span className="pill pill-pending">pending</span>{" "}
                    {account.email ?? account.name ?? account.clerkUserId}
                  </td>
                  <td>
                    <LinkAccount
                      clerkUserId={account.clerkUserId}
                      chairs={unlinkedChairs.map((c) => ({
                        id: c.barber_id,
                        name: c.barber_name,
                      }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
