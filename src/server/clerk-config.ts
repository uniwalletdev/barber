/**
 * Whether Clerk is configured for this deployment.
 *
 * Staff auth must never be able to take the customer kiosk down. The queue is
 * the revenue-critical path and customers have no accounts, so a missing staff
 * key degrades the staff pages and leaves the shop running.
 *
 * NEXT_PUBLIC_* is inlined at build time, so adding the keys requires a
 * redeploy — which is what Vercel does when environment variables change.
 */
export const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);
