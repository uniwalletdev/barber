import Link from "next/link";
import { notFound } from "next/navigation";
import { visitView } from "@/src/server/queries";
import { formatWait } from "@/src/domain/estimate";
import AutoRefresh from "@/app/_components/AutoRefresh";
import ActionButton from "@/app/_components/ActionButton";
import { checkIn, leaveQueue } from "@/src/server/actions";

export const dynamic = "force-dynamic";

export default async function VisitPage({ params }: { params: Promise<{ visitId: string }> }) {
  const { visitId } = await params;
  const visit = await visitView(visitId);
  if (!visit) notFound();

  const finished = ["completed", "left", "no_show", "closed_out"].includes(visit.status);

  return (
    <main className="wrap" style={{ maxWidth: 560 }}>
      {!finished ? <AutoRefresh intervalMs={15_000} sweep /> : null}

      <p className="eyebrow">{visit.barberName}</p>
      <h1>
        {visit.status === "in_progress"
          ? "You're in the chair"
          : visit.status === "called"
            ? "You're up — head to the chair"
            : finished
              ? "That's you done"
              : `Hi ${visit.customerFirstName}`}
      </h1>

      {finished ? (
        <div className="card" style={{ marginTop: 20 }}>
          <p style={{ margin: 0 }}>
            {visit.status === "completed"
              ? `Thanks for coming in. See you next time.`
              : visit.status === "no_show"
                ? "You were called twice and missed both, so your spot was released. Join again any time."
                : visit.status === "closed_out"
                  ? "The shop closed before your turn came round."
                  : "You've left the queue."}
          </p>
          <div className="btn-row" style={{ marginTop: 18 }}>
            <Link href="/" className="btn btn-primary">
              Back to the shop
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="card card-accent" style={{ marginTop: 18, textAlign: "center" }}>
            {visit.status === "in_progress" || visit.status === "called" ? (
              <p className="big-wait" style={{ fontSize: 34 }}>
                {visit.status === "called" ? "Go on up" : "In progress"}
              </p>
            ) : (
              <>
                <p className="big-wait">{formatWait(visit.waitSeconds ?? 0)}</p>
                <p className="big-pos">
                  Position {visit.position} in {visit.barberName}&apos;s queue
                  {visit.wrappingUp ? " · the current cut is wrapping up" : ""}
                </p>
              </>
            )}
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{visit.serviceName}</p>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 15 }}>
              {visit.joinMethod === "remote"
                ? visit.canCheckIn
                  ? "Your spot is held. Check in when you get here — you keep your place in line."
                  : "Checked in."
                : "Checked in."}
            </p>
          </div>

          {visit.canCheckIn ? (
            <div className="btn-row" style={{ marginTop: 18 }}>
              <ActionButton
                action={checkIn.bind(null, visit.id)}
                className="btn-primary btn-block"
              >
                I&apos;m here — check me in
              </ActionButton>
            </div>
          ) : null}

          <div className="btn-row" style={{ marginTop: 10 }}>
            <ActionButton
              action={leaveQueue.bind(null, visit.id)}
              className="btn-quiet"
              confirm="Leave the queue? You'll lose your place."
            >
              Leave the queue
            </ActionButton>
          </div>
        </>
      )}
    </main>
  );
}
