import path from "path";
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
  // Restrict Turbopack's file-system root to the project directory.
  // Without this, Turbopack auto-detects the root via lock-file discovery and
  // may pick a parent directory, causing it to watch/scan data/ (114k files).
  // Also silences the "multiple lockfiles detected" warning when running from a
  // git worktree that has its own pnpm-lock.yaml alongside the main repo's.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Exclude the data directory from Next.js output file tracing.
  // data/ contains ~114k atlas/cache files that are read at runtime via
  // MAPPY_DATA_ROOT env var — they are never part of the deployable bundle.
  // Without this exclusion, Next.js file-tracing walks the entire tree,
  // turning a ~15s build into a ~10min build.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
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
