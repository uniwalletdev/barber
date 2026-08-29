import { currentShopId } from "@/src/server/db";
import { ownerMetrics } from "@/src/server/metrics";
import { money } from "@/app/_components/format";
import AutoRefresh from "@/app/_components/AutoRefresh";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const shopId = await currentShopId();
  const m = await ownerMetrics(shopId);
  const conversionRate =
    m.impressionsToday > 0 ? Math.round((m.conversionsToday / m.impressionsToday) * 100) : null;

  return (
    <main className="wrap wrap-wide">
      <AutoRefresh intervalMs={60_000} />
      <h1>Shop today</h1>
      <p className="lede">
        Shop-wide totals only. Per-barber and per-customer detail belongs to the barber.
      </p>

      <h2>Service</h2>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Served today</div>
          <div className="stat-value">{m.servedToday}</div>
          <div className="stat-note">{m.servedAllTime} all time</div>
        </div>
        <div className="stat">
          <div className="stat-label">Waiting now</div>
          <div className="stat-value">{m.waitingNow}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Average cut</div>
          <div className="stat-value">{m.averageServiceMinutes ?? "—"}</div>
          <div className="stat-note">minutes, measured</div>
        </div>
      </div>

      <h2>Walk-outs</h2>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Looked at the wait</div>
          <div className="stat-value">{m.impressionsToday}</div>
          <div className="stat-note">kiosk and web views today</div>
        </div>
        <div className="stat">
          <div className="stat-label">Joined</div>
          <div className="stat-value">{m.conversionsToday}</div>
          <div className="stat-note">
            {conversionRate === null ? "no views yet" : `${conversionRate}% of views`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Walked out</div>
          <div className="stat-value">{m.walkOutsToday}</div>
          <div className="stat-note">saw the wait, did not join</div>
        </div>
      </div>

      <div className="stat-row" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="stat-label">Recovered today</div>
          <div className="stat-value">{money(m.recoveredCents)}</div>
          <div className="stat-note">remote holds that were served</div>
        </div>
        <div className="stat">
          <div className="stat-label">Estimated lost</div>
          <div className="stat-value">{money(m.lostCents)}</div>
          <div className="stat-note">walk-outs × {money(m.averageTicketCents)} average ticket</div>
        </div>
        <div className="stat">
          <div className="stat-label">Quote accuracy</div>
          <div className="stat-value">
            {m.quoteAccuracy.medianErrorMinutes === null
              ? "—"
              : `±${m.quoteAccuracy.medianErrorMinutes}`}
          </div>
          <div className="stat-note">
            median minutes off, {m.quoteAccuracy.samples} samples
          </div>
        </div>
      </div>

      <p className="notice" style={{ marginTop: 26 }}>
        <strong>How to read &ldquo;recovered&rdquo;.</strong> It counts customers who saw the wait
        and held a spot from their phone rather than walking away, and who were then served. That
        is the conservative reading — the definition is still yours to set, and the underlying
        views and conversions above are recorded either way.
      </p>
    </main>
  );
}
