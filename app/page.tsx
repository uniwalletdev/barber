import Link from "next/link";
import { currentShopId } from "@/src/server/db";
import { shopOverview } from "@/src/server/queries";
import { formatWait } from "@/src/domain/estimate";
import AutoRefresh from "./_components/AutoRefresh";
import RecordImpression from "./_components/RecordImpression";
import { initials, statusLabel } from "./_components/format";

export const dynamic = "force-dynamic";

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ kiosk?: string }>;
}) {
  const { kiosk } = await searchParams;
  const shopId = await currentShopId();
  const { shop, barbers } = await shopOverview(shopId);

  // The shortest wait on offer is what a customer actually weighs before
  // deciding whether to stay. If they leave now, the impression this page
  // records is the only trace the shop will ever have of that walk-out.
  const shortest = barbers
    .filter((b) => b.waitSeconds !== null)
    .reduce<number | null>((min, b) => (min === null ? b.waitSeconds! : Math.min(min, b.waitSeconds!)), null);
  return (
    <main className="wrap">
      <AutoRefresh intervalMs={20_000} />
      <RecordImpression
        quotedWaitSeconds={shortest ?? 0}
        source={kiosk === undefined ? "web" : "kiosk"}
      />
      <div className="masthead">
        <h1>{shop.name}</h1>
        <Link href="/barber" className="btn-quiet">
          Barber sign in
        </Link>
      </div>
      <p className="lede">Pick your barber to see the wait and hold a spot.</p>

      <div className="barbers">
        {barbers.map((barber) => {
          const closed = barber.status === "off";
          return (
            <Link
              key={barber.id}
              href={`/join/${barber.id}${kiosk === undefined ? "" : "?kiosk"}`}
              className="barber-card"
              aria-disabled={closed}
              tabIndex={closed ? -1 : undefined}
            >
              <span className="avatar" aria-hidden="true">
                {barber.profileImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={barber.profileImageUrl} alt="" />
                ) : (
                  initials(barber.name)
                )}
              </span>
              <span className="barber-body">
                <span className="barber-name">{barber.name}</span>
                <span className="barber-wait">
                  {closed ? (
                    "Not taking customers"
                  ) : (
                    <>
                      <strong>{formatWait(barber.waitSeconds ?? 0)}</strong>
                      {barber.peopleWaiting > 0
                        ? ` · ${barber.peopleWaiting} waiting`
                        : " · no one waiting"}
                    </>
                  )}
                </span>
                <span className={`badge badge-${barber.status}`}>
                  {statusLabel(barber.status, barber.breakUntil)}
                </span>
              </span>
            </Link>
          );
        })}
      </div>

      {barbers.length === 0 ? (
        <p className="empty">No barbers are set up yet.</p>
      ) : null}
    </main>
  );
}
