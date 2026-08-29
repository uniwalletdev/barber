import Link from "next/link";
import { notFound } from "next/navigation";
import { currentShopId } from "@/src/server/db";
import { shopOverview } from "@/src/server/queries";
import { formatWait } from "@/src/domain/estimate";
import { statusLabel } from "@/app/_components/format";
import JoinForm from "./JoinForm";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ barberId: string }>;
  searchParams: Promise<{ kiosk?: string }>;
}) {
  const { barberId } = await params;
  const { kiosk } = await searchParams;
  const shopId = await currentShopId();
  const { barbers, services } = await shopOverview(shopId);
  const barber = barbers.find((b) => b.id === barberId);
  if (!barber) notFound();

  const atShop = kiosk !== undefined;
  const remoteFull = barber.remoteSlotsLeft === 0 || !barber.acceptingRemoteJoins;

  return (
    <main className="wrap" style={{ maxWidth: 560 }}>
      <Link href="/" className="btn-quiet" style={{ paddingLeft: 0 }}>
        ← All barbers
      </Link>
      <h1 style={{ marginTop: 12 }}>{barber.name}</h1>
      <p className="lede">
        <strong>{formatWait(barber.waitSeconds ?? 0)}</strong> ·{" "}
        {statusLabel(barber.status, barber.breakUntil)}
        {barber.peopleWaiting > 0 ? ` · ${barber.peopleWaiting} waiting` : ""}
      </p>

      {barber.status === "off" ? (
        <p className="notice">{barber.name} is not taking customers right now.</p>
      ) : (
        <JoinForm
          barberId={barber.id}
          services={services}
          atShop={atShop}
          remoteFull={remoteFull}
          remoteSlotsLeft={barber.remoteSlotsLeft}
        />
      )}
    </main>
  );
}
