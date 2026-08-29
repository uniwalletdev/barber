import type { Metadata, Viewport } from "next";
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
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
