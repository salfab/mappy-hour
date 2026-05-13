import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), microphone=(), camera=()" },
];

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["gl", "earcut", "@mongodb-js/zstd"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
  // Umami analytics proxied under /_analytics/* so the tracker script and
  // event collection live on the same origin as the app. Avoids CORS, no
  // extra DNS needed, one Tailscale Funnel host suffices. Destination is
  // the umami container inside docker compose's network. In local dev
  // (no umami container running) the rewrite returns 502 — harmless;
  // analytics simply doesn't load.
  async rewrites() {
    return [
      { source: "/_analytics/script.js", destination: "http://umami:3000/script.js" },
      { source: "/_analytics/api/:path*", destination: "http://umami:3000/api/:path*" },
    ];
  },
};

export default nextConfig;
