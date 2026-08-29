import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfigured } from "@/src/server/clerk-config";
import StaffBar from "./_components/StaffBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Barbershop queue",
  description: "See the wait, hold your spot, and check in when you arrive.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The kiosk lives on a wall tablet; stop a stray pinch from wrecking it.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Clerk wraps the whole app so the staff bar works on every page, but only
  // when it is actually configured — see src/server/clerk-config.ts.
  return (
    <html lang="en">
      <body>
        {clerkConfigured ? (
          <ClerkProvider>
            <StaffBar />
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
