#!/usr/bin/env node
// Split a combined places.json into per-region <region>-places.json files.
// Usage: node split-places-per-region.mjs <combined.json> <out-dir>
// Used by both CI (image build pre-step) and the runtime startup check.
import fs from "node:fs";
import path from "node:path";

function main() {
  const [, , combinedPath, outDir] = process.argv;
  if (!combinedPath || !outDir) {
    console.error("Usage: split-places-per-region.mjs <combined.json> <out-dir>");
    process.exit(2);
  }

  const raw = fs.readFileSync(combinedPath, "utf8");
  const data = JSON.parse(raw);
  const places = Array.isArray(data.places) ? data.places : [];

  const byRegion = new Map();
  for (const p of places) {
    const region = typeof p.region === "string" && p.region.length > 0 ? p.region : "unknown";
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(p);
  }

  fs.mkdirSync(outDir, { recursive: true });

  for (const [region, regionPlaces] of byRegion) {
    const minLon = Math.min(...regionPlaces.map((p) => p.lon));
    const minLat = Math.min(...regionPlaces.map((p) => p.lat));
    const maxLon = Math.max(...regionPlaces.map((p) => p.lon));
    const maxLat = Math.max(...regionPlaces.map((p) => p.lat));

    const payload = {
      generatedAt: data.generatedAt ?? new Date().toISOString(),
      source: data.source ?? "Overpass (split from combined)",
      bbox: [minLon, minLat, maxLon, maxLat],
      totalPlaces: regionPlaces.length,
      categories: {
        parks: regionPlaces.filter((p) => p.category === "park").length,
        terraceCandidates: regionPlaces.filter((p) => p.category === "terrace_candidate").length,
        outdoorSeatingYes: regionPlaces.filter((p) => p.hasOutdoorSeating).length,
      },
      places: regionPlaces,
    };

    const outPath = path.join(outDir, `${region}-places.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[split-places] wrote ${regionPlaces.length} → ${outPath}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[split-places] failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
