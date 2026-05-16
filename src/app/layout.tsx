import type { Metadata, Viewport } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "leaflet/dist/leaflet.css";
import "./globals.css";

import { CpuProbeOverlay } from "@/components/diag/cpu-probe-overlay";
import { TurnstileGate } from "@/components/security/turnstile-gate";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Fraunces — editorial serif used for display headings (date, hero copy) on the
// MapLibre desktop panel. Loaded once at the root so any client component can
// reach it via `font-[var(--font-display)]` without re-registering the font.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mitch.tail63c42d.ts.net";
const title = "Mappy Hour";
const description =
  "Trouve les terrasses au soleil autour de Lausanne, Nyon et du Léman grâce aux cartes d'ombre et d'ensoleillement.";
const ogImage = {
  url: "/og/mappy-hour-v2.jpg",
  width: 1200,
  height: 630,
  alt: "Mappy Hour montre les zones ensoleillées autour du Léman au coucher du soleil.",
  type: "image/jpeg",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: title,
  title: {
    default: title,
    template: `%s - ${title}`,
  },
  description,
  openGraph: {
    title,
    description,
    url: "/",
    siteName: title,
    locale: "fr_CH",
    type: "website",
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage],
  },
  // PWA — manifest, app icons, and iOS home-screen hints.
  // The PNG fallback set is not shipped yet (placeholder SVGs only), so iOS
  // Safari may render a screenshot when a user runs "Add to Home Screen".
  // See docs/deployment/pwa-install.md for the icon replacement plan.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Mappy Hour",
  },
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
  },
};

// Next 16 routes `themeColor` and `viewport` through a dedicated export so the
// values can be tuned per-route. Keeping it minimal here: the amber accent
// (#f59e0b) matches the PWA manifest theme_color and tints the Android status
// bar / Chrome address bar when the app is launched standalone.
export const viewport: Viewport = {
  themeColor: "#f59e0b",
};

// Umami analytics — self-hosted on Mitch, proxied at /_analytics/script.js
// (see next.config.ts rewrites + docker-compose.yml). The script is only
// emitted when the website ID is configured at build time; absent in dev
// or pre-setup builds, so no tracking happens until the operator opts in.
const umamiWebsiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased`}
      >
        {children}
        {/* Invisible Cloudflare Turnstile gate. Mounts a hidden challenge widget
            and POSTs the resulting token to /api/turnstile/verify so an HttpOnly
            `mh-turnstile-ok` cookie can gate the expensive SSE / viewport
            endpoints on subsequent fetches. When NEXT_PUBLIC_TURNSTILE_SITE_KEY
            is unset (local dev), the component renders nothing — see
            docs/security/turnstile.md. */}
        <TurnstileGate />
        {/* Opt-in debug overlay shown only when `?debug-cpu=1` is in the URL.
            Lets us watch Mitch's CPU/memory while users toggle UI knobs that
            re-trigger SSE timeline streams. See docs/observability/cpu-probe.md. */}
        <CpuProbeOverlay />
        {umamiWebsiteId ? (
          <script
            defer
            data-website-id={umamiWebsiteId}
            data-host-url="/_analytics"
            src="/_analytics/script.js"
          />
        ) : null}
      </body>
    </html>
  );
}

