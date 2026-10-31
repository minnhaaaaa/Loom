import type { Metadata } from "next";
import localFont from "next/font/local";
import { LocalOrigin } from "@/components/local-origin";
import "@cloudflare/kumo/styles/standalone";
import "./globals.css";
import "./civitas.css";
import "./branding.css";
import "./setup.css";
import "./prompt.css";
import "./landing.css";
import "./company-entry.css";
import "./insights.css";
import "./provider.css";
import "./dashboard.css";
import "./tool-customization.css";
import "./select.css";
import "./knowledge.css";

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
const editorial = localFont({
  src: "./fonts/inter-variable.woff2",
  variable: "--font-editorial",
  display: "swap",
  weight: "100 900",
});
export const metadata: Metadata = {
  title: "Loom · Data requests, one workspace",
  description:
    "A shared request desk for small analytics teams. Clear requirements, accountable owners, and Exasol-backed insight into where work gets stuck.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${mono.variable} ${editorial.variable}`}
    >
      <body>
        <LocalOrigin
          canonicalLoopback={/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(
            process.env.APP_ORIGIN || "",
          )}
        />
        {children}
      </body>
    </html>
  );
}
