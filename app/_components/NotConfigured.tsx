import Link from "next/link";

/** Shown on staff pages when Clerk keys are absent. */
export default function NotConfigured() {
  return (
    <main className="wrap" style={{ maxWidth: 560 }}>
      <h1>Staff sign-in isn&apos;t set up</h1>
      <p className="lede">
        The queue is running normally for customers. Only the staff pages need this.
      </p>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Add these to the deployment&apos;s environment variables and redeploy:
        </p>
        <pre
          style={{
            background: "var(--sunk)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
            padding: "12px 14px",
            overflowX: "auto",
            fontSize: 13,
            margin: 0,
          }}
        >
          <code>
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...{"\n"}CLERK_SECRET_KEY=sk_...
          </code>
        </pre>
        <p style={{ marginBottom: 0, color: "var(--muted)", fontSize: 15 }}>
          Both come from the Clerk dashboard under API keys.
        </p>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <Link href="/" className="btn">
            Back to the shop
          </Link>
        </div>
      </div>
    </main>
  );
}
