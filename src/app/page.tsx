import { SunlightMapClient } from "@/components/sunlight-map-client";

// Force dynamic rendering so process.env.MAPPY_FORCE_CACHE_ONLY is read at
// request time, not at build time. Keeps the build artifact immutable across
// GPU-enabled and headless cache-only deployments — only `.env` differs.
export const dynamic = "force-dynamic";

export default function Home() {
  const forceCacheOnly = process.env.MAPPY_FORCE_CACHE_ONLY === "true";
  return (
    <main className="fixed inset-0 h-dvh max-h-dvh w-full overflow-hidden">
      <SunlightMapClient forceCacheOnly={forceCacheOnly} />
    </main>
  );
}
