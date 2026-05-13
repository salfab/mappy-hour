import dynamic from "next/dynamic";

// MapLibre is browser-only (uses WebGL + window). Load the client component
// with SSR disabled — same pattern as the Leaflet `SunlightMapClient`.
const MapLibrePreviewClient = dynamic(
  () => import("@/components/maplibre-preview-client").then((m) => m.MapLibrePreviewClient),
  { ssr: false },
);

export const metadata = {
  title: "MapLibre preview",
  description:
    "Phase 1 du portage Leaflet -> MapLibre : basemap switcher + overlay places natif (clusters + symboles).",
};

export default function MapLibrePreviewPage() {
  return (
    <main className="fixed inset-0 h-dvh max-h-dvh w-full overflow-hidden">
      <MapLibrePreviewClient />
    </main>
  );
}
