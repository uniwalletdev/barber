import { redirect } from "next/navigation";
import { currentBarberId } from "@/src/server/session";
import { dashboard } from "@/src/server/queries";
import { formatWait } from "@/src/domain/estimate";
import AutoRefresh from "@/app/_components/AutoRefresh";
import ActionButton from "@/app/_components/ActionButton";
import { statusLabel } from "@/app/_components/format";
import {
  barberLogout,
  callNext,
  completeVisit,
  endBreak,
  markNoShow,
  removeFromQueue,
  setAvailability,
  setRemoteJoins,
  startBreak,
  startVisit,
} from "@/src/server/actions";

export const dynamic = "force-dynamic";

function elapsed(since: Date | null): string {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60000));
  return `${minutes} min in the chair`;
}

export default async function BarberDashboard() {
  const barberId = await currentBarberId();
  if (!barberId) redirect("/barber/login");
  const data = await dashboard(barberId);
  if (!data) redirect("/barber/login");

  const { barber, inChair, called, nextUp, callableId, queue } = data;
  const onBreak = barber.presence === "on_break";
  const off = barber.presence === "off";

  return (
    <main className="wrap wrap-wide">
      <AutoRefresh intervalMs={12_000} sweep />

      <div className="masthead">
        <div>
          <h1>{barber.name}</h1>
          <p className="lede" style={{ margin: "4px 0 0" }}>
            {statusLabel(
              off ? "off" : onBreak ? "on_break" : inChair || called ? "with_client" : "available",
              barber.breakUntil,
            )}
          </p>
        </div>
        <form action={barberLogout}>
          <button type="submit" className="btn-quiet">
            Sign out
          </button>
        </form>
      </div>

      <div className="stat-row" style={{ marginTop: 18 }}>
        <div className="stat">
          <div className="stat-label">Checked in</div>
          <div className="stat-value">{data.checkedInCount}</div>
          <div className="stat-note">here and waiting</div>
        </div>
        <div className="stat">
          <div className="stat-label">Held remotely</div>
          <div className="stat-value">{data.heldRemotelyCount}</div>
          <div className="stat-note">spot held, not arrived</div>
        </div>
        <div className="stat">
          <div className="stat-label">Wait to join</div>
          <div className="stat-value" style={{ fontSize: 24 }}>
            {formatWait(data.waitToJoinSeconds)}
          </div>
          <div className="stat-note">what a new customer is quoted</div>
        </div>
      </div>

      {/* ---------------------------------------------------- in the chair -- */}
      {inChair ? (
        <>
          <h2>In the chair</h2>
          <div className="card card-accent">
            <p style={{ margin: 0, fontWeight: 650, fontSize: 19 }}>{inChair.displayName}</p>
            <p style={{ margin: "3px 0 0", color: "var(--muted)" }}>
              {inChair.serviceName} · {elapsed(inChair.startedAt)}
            </p>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <ActionButton action={completeVisit.bind(null, inChair.id)} className="btn-primary">
                Done — next
              </ActionButton>
            </div>
          </div>
        </>
      ) : null}

      {/* --------------------------------------------------------- called --- */}
      {called ? (
        <>
          <h2>Called</h2>
          <div className="card card-accent">
            <p style={{ margin: 0, fontWeight: 650, fontSize: 19 }}>{called.displayName}</p>
            <p style={{ margin: "3px 0 0", color: "var(--muted)" }}>
              {called.serviceName} · waiting for them to come up
            </p>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <ActionButton action={startVisit.bind(null, called.id)} className="btn-primary">
                They&apos;re here — start
              </ActionButton>
              <ActionButton action={markNoShow.bind(null, called.id)}>
                No-show — drop 2 places
              </ActionButton>
            </div>
          </div>
        </>
      ) : null}

      {/* -------------------------------------------------------- next up --- */}
      {!inChair && !called ? (
        <>
          <h2>Next up</h2>
          {nextUp ? (
            <div className="card card-accent">
              <p style={{ margin: 0, fontWeight: 650, fontSize: 19 }}>
                {nextUp.displayName}
                <span className={`tag tag-${nextUp.joinMethod}`}>
                  {nextUp.joinMethod === "remote" ? "remote" : "walk-in"}
                </span>
              </p>
              <p style={{ margin: "3px 0 0", color: "var(--muted)" }}>
                {nextUp.serviceName}
                {nextUp.visitCount > 0 ? ` · visit ${nextUp.visitCount + 1} with you` : " · first visit with you"}
              </p>

              {nextUp.status === "queued_remote" ? (
                <p className="notice" style={{ marginTop: 14 }}>
                  {nextUp.displayName} holds this spot but hasn&apos;t arrived.
                  {callableId
                    ? " Call next will take the first customer who is here."
                    : " Nobody in the queue has arrived yet."}
                </p>
              ) : null}

              <div className="btn-row" style={{ marginTop: 16 }}>
                <ActionButton
                  action={callNext}
                  className="btn-primary"
                  disabled={!callableId || onBreak || off}
                >
                  {callableId && callableId !== nextUp.id ? "Call next customer here" : "Call next"}
                </ActionButton>
              </div>
            </div>
          ) : (
            <div className="card">
              <p className="empty" style={{ padding: "8px 0" }}>
                Nobody waiting.
              </p>
            </div>
          )}
        </>
      ) : null}

      {/* ---------------------------------------------------------- queue --- */}
      <h2>Queue ({queue.length})</h2>
      <div className="card">
        {queue.length === 0 ? (
          <p className="empty" style={{ padding: "8px 0" }}>
            Nobody waiting.
          </p>
        ) : (
          <ul className="queue">
            {queue.map((customer) => (
              <li key={customer.id}>
                <span className="pos">{customer.position}</span>
                <span className="queue-body">
                  <span className="queue-name">
                    {customer.displayName}
                    <span className={`tag tag-${customer.joinMethod}`}>
                      {customer.joinMethod === "remote"
                        ? customer.status === "queued_remote"
                          ? "not arrived"
                          : "remote · here"
                        : "walk-in"}
                    </span>
                    {customer.noShowCount > 0 ? (
                      <span className="tag tag-called">missed {customer.noShowCount}</span>
                    ) : null}
                  </span>
                  <span className="queue-meta">
                    {customer.serviceName} · {formatWait(customer.waitSeconds ?? 0)}
                  </span>
                </span>
                <ActionButton
                  action={removeFromQueue.bind(null, customer.id)}
                  className="btn-quiet"
                  confirm={`Remove ${customer.displayName} from your queue?`}
                >
                  Remove
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* -------------------------------------------------------- presence -- */}
      <h2>Your status</h2>
      <div className="card">
        <div className="btn-row">
          {onBreak ? (
            <ActionButton action={endBreak} className="btn-primary">
              End break
            </ActionButton>
          ) : (
            <>
              <ActionButton action={startBreak.bind(null, 15)}>Break · 15 min</ActionButton>
              <ActionButton action={startBreak.bind(null, 30)}>Break · 30 min</ActionButton>
            </>
          )}

          {off ? (
            <ActionButton action={setAvailability.bind(null, "available")} className="btn-primary">
              Start my day
            </ActionButton>
          ) : (
            <ActionButton
              action={setAvailability.bind(null, "off")}
              confirm="Mark yourself off for the day? Nobody new can join your queue."
            >
              Off for the day
            </ActionButton>
          )}

          <ActionButton action={setRemoteJoins.bind(null, !barber.acceptingRemoteJoins)}>
            {barber.acceptingRemoteJoins ? "Pause remote joins" : "Allow remote joins"}
          </ActionButton>
        </div>
      </div>
    </main>
  );
}
