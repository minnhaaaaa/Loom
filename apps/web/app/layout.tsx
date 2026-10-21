import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Loom · Data requests",
  description:
    "A shared desk for data requests, clarification, and reviewed decisions.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
