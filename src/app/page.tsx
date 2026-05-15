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
      {/* Discreet link to the in-progress MapLibre preview (Phase 1 of the
       *  Leaflet -> MapLibre migration). Lives on `feature/maplibre-migration`
       *  only; remove before merging to master if the migration is aborted. */}
      <a
        href="/maplibre-preview"
        className="fixed bottom-2 right-2 z-[2000] rounded-md bg-white/85 px-2 py-1 text-xs text-gray-700 shadow-sm backdrop-blur hover:bg-white hover:text-gray-900"
        style={{ font: "11px system-ui, sans-serif" }}
      >
        Try MapLibre preview ↗
      </a>
    </main>
  );
}
