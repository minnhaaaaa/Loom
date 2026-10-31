import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./civitas.css";
import "./branding.css";
import "./setup.css";
import "./prompt.css";

const body = localFont({
  src: "./fonts/manrope-variable.ttf",
  variable: "--font-body",
  display: "swap",
  weight: "200 800",
});
const display = localFont({
  src: "./fonts/archivo-black.ttf",
  variable: "--font-display",
  display: "swap",
  weight: "400",
});
const mono = localFont({
  src: "./fonts/ibm-plex-mono.ttf",
  variable: "--font-mono",
  display: "swap",
  weight: "400",
});
export const metadata: Metadata = {
  title: "Loom · Your team’s workspace",
  description:
    "Describe a tool, make it yours, and work together with your team and an agent.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
