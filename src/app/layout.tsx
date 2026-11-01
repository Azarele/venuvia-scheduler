import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Studio Nova · Booking Assistant",
  description: "Chat with an AI assistant that manages bookings — every change needs your approval.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
