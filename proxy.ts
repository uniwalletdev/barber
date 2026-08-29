import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkConfigured } from "./src/server/clerk-config";

/**
 * Staff-only routes. Everything else — the barber list, the join form, a
 * customer's own live position — stays open, because customers do not have
 * accounts and must not need one.
 */
const isStaffRoute = createRouteMatcher(["/barber(.*)", "/admin(.*)", "/setup(.*)"]);

const withClerk = clerkMiddleware(async (auth, request) => {
  if (isStaffRoute(request)) await auth.protect();
});

// Without keys, Clerk throws on every request it touches. Passing traffic
// through keeps the customer side alive; the staff pages render a setup
// notice instead of a stack trace.
export default clerkConfigured ? withClerk : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything except static files and Next internals.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
