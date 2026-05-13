import { MapLibrePreviewClient } from "@/components/maplibre-preview-client";

// The preview client component is marked `"use client"`, so App Router takes
// care of the server/client boundary natively — no `next/dynamic({ssr:false})`
// needed (and disallowed in Server Components in Next 16). The MapLibre code
// only runs in the browser via the `useEffect` mount.
export const metadata = {
  title: "MapLibre preview",
  description:
    "Phase 1 du portage Leaflet -> MapLibre : basemap switcher + overlay places natif (clusters + symboles).",
};

// Force dynamic — same rationale as `/` (no point pre-rendering a map page).
export const dynamic = "force-dynamic";

export default function MapLibrePreviewPage() {
  return (
    <main className="fixed inset-0 h-dvh max-h-dvh w-full overflow-hidden">
      <MapLibrePreviewClient />
    </main>
  );
}
