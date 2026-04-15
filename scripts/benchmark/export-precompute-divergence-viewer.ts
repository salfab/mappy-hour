import fs from "node:fs/promises";
import path from "node:path";

import { lv95ToWgs84 } from "@/lib/geo/projection";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";

type ModeName = "gpu-raster" | "rust-wgpu-vulkan" | "detailed";

type Args = {
  summaryDir: string;
  tileId: string | null;
  frame: number;
  out: string;
  buildingMarginMeters: number;
  includeBuildings: boolean;
};

type ValueSummaryPoint = {
  outdoorIndex: number;
  id: string;
  lat: number;
  lon: number;
  lv95Easting: number;
  lv95Northing: number;
  pointElevationMeters: number | null;
};

type ValueSummaryFrame = {
  index: number;
  localTime: string;
  utcTime: string;
  buildingsBlockedMaskBase64: string;
};

type ValueSummary = {
  mode: ModeName;
  region: string;
  tileId: string;
  date: string;
  timezone?: string;
  stats: {
    pointCount: number;
  };
  points?: ValueSummaryPoint[];
  frames: ValueSummaryFrame[];
};

type GeoJsonFeature = {
  type: "Feature";
  geometry: {
    type: "Point" | "Polygon";
    coordinates: [number, number] | [number, number][][];
  };
  properties: Record<string, string | number | boolean | null>;
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

type TileBounds = {
  minEasting: number;
  minNorthing: number;
  maxEasting: number;
  maxNorthing: number;
};

const DEFAULT_SUMMARY_DIR = path.join(
  "data",
  "processed",
  "wgpu-vulkan-probe",
  "hot-tiles-value-summaries-divergence-fulltile-1frame",
);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    summaryDir: DEFAULT_SUMMARY_DIR,
    tileId: null,
    frame: 0,
    out: path.join(
      "data",
      "processed",
      "wgpu-vulkan-probe",
      "divergence-inspection-fulltile-1frame.html",
    ),
    buildingMarginMeters: 20,
    includeBuildings: true,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  pnpm exec tsx scripts/benchmark/export-precompute-divergence-viewer.ts -- --tile-id=e2538000_n1152500_s250",
        "",
        "Options:",
        "  --summary-dir=data/processed/wgpu-vulkan-probe/hot-tiles-value-summaries-divergence-fulltile-1frame",
        "  --tile-id=e2538000_n1152500_s250",
        "  --frame=0",
        "  --out=data/processed/wgpu-vulkan-probe/divergence-inspection-fulltile-1frame.html",
        "  --building-margin-meters=20",
        "  --include-buildings=true|false",
      ].join("\n"));
      process.exit(0);
    }

    const [key, value] = splitArg(arg);
    if (key === "--summary-dir") args.summaryDir = value;
    else if (key === "--tile-id") args.tileId = value;
    else if (key === "--frame") args.frame = parseNonNegativeInteger(value, key);
    else if (key === "--out") args.out = value;
    else if (key === "--building-margin-meters") args.buildingMarginMeters = parseNonNegativeNumber(value, key);
    else if (key === "--include-buildings") args.includeBuildings = parseBoolean(value, key);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function splitArg(arg: string): [string, string] {
  const index = arg.indexOf("=");
  if (index === -1) throw new Error(`Expected --key=value, got ${arg}`);
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function parseNonNegativeInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`Invalid ${key}: ${value}`);
}

function parseNonNegativeNumber(value: string, key: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  throw new Error(`Invalid ${key}: ${value}`);
}

function parseBoolean(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${key}: ${value}`);
}

async function findSummaryPath(summaryDir: string, mode: ModeName, tileId: string | null): Promise<string> {
  const entries = await fs.readdir(path.resolve(process.cwd(), summaryDir), {
    withFileTypes: true,
  });
  const matches = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(`-${mode}.values.json`))
    .filter((name) => !tileId || name.includes(tileId))
    .sort();

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one value summary for mode=${mode}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }

  return path.join(summaryDir, matches[0]);
}

async function readValueSummary(filePath: string): Promise<ValueSummary> {
  return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8")) as ValueSummary;
}

function isMaskBitSet(mask: Buffer, index: number): boolean {
  return ((mask[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function pointAt(points: ValueSummaryPoint[] | undefined, outdoorIndex: number): ValueSummaryPoint | null {
  if (!points) return null;
  return points[outdoorIndex] ?? points.find((point) => point.outdoorIndex === outdoorIndex) ?? null;
}

function parseTileBounds(tileId: string): TileBounds {
  const match = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!match) throw new Error(`Cannot parse tile id: ${tileId}`);
  const minEasting = Number(match[1]);
  const minNorthing = Number(match[2]);
  const size = Number(match[3]);
  return {
    minEasting,
    minNorthing,
    maxEasting: minEasting + size,
    maxNorthing: minNorthing + size,
  };
}

function assertCompatible(summaries: Record<ModeName, ValueSummary>, frame: number): void {
  const base = summaries["gpu-raster"];
  for (const summary of Object.values(summaries)) {
    if (summary.tileId !== base.tileId) {
      throw new Error(`Tile mismatch: ${summary.tileId} != ${base.tileId}`);
    }
    if (summary.date !== base.date) {
      throw new Error(`Date mismatch: ${summary.date} != ${base.date}`);
    }
    if (summary.stats.pointCount !== base.stats.pointCount) {
      throw new Error(`Point count mismatch: ${summary.stats.pointCount} != ${base.stats.pointCount}`);
    }
    if (!summary.frames.some((candidate) => candidate.index === frame)) {
      throw new Error(`Frame ${frame} not found for ${summary.mode}`);
    }
  }
}

function selectedFrame(summary: ValueSummary, frame: number): ValueSummaryFrame {
  const selected = summary.frames.find((candidate) => candidate.index === frame);
  if (!selected) throw new Error(`Frame ${frame} not found for ${summary.mode}`);
  return selected;
}

function collectDivergentPointFeatures(
  summaries: Record<ModeName, ValueSummary>,
  frame: number,
): { collection: GeoJsonFeatureCollection; counts: Record<string, number> } {
  const raster = summaries["gpu-raster"];
  const vulkan = summaries["rust-wgpu-vulkan"];
  const detailed = summaries.detailed;
  const rasterMask = Buffer.from(selectedFrame(raster, frame).buildingsBlockedMaskBase64, "base64");
  const vulkanMask = Buffer.from(selectedFrame(vulkan, frame).buildingsBlockedMaskBase64, "base64");
  const detailedMask = Buffer.from(selectedFrame(detailed, frame).buildingsBlockedMaskBase64, "base64");
  const counts: Record<string, number> = {};
  const features: GeoJsonFeature[] = [];

  for (let outdoorIndex = 0; outdoorIndex < raster.stats.pointCount; outdoorIndex += 1) {
    const rasterBlocked = isMaskBitSet(rasterMask, outdoorIndex);
    const vulkanBlocked = isMaskBitSet(vulkanMask, outdoorIndex);
    const detailedBlocked = isMaskBitSet(detailedMask, outdoorIndex);
    const category = [
      rasterBlocked ? "R" : "-",
      vulkanBlocked ? "V" : "-",
      detailedBlocked ? "D" : "-",
    ].join("");
    counts[category] = (counts[category] ?? 0) + 1;

    if (category === "---" || category === "RVD") continue;
    const point = pointAt(raster.points, outdoorIndex);
    if (!point) continue;
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [point.lon, point.lat],
      },
      properties: {
        category,
        outdoorIndex,
        pointId: point.id,
        lat: point.lat,
        lon: point.lon,
        lv95Easting: point.lv95Easting,
        lv95Northing: point.lv95Northing,
        pointElevationMeters: point.pointElevationMeters,
        rasterBlocked,
        vulkanBlocked,
        detailedBlocked,
      },
    });
  }

  return {
    collection: {
      type: "FeatureCollection",
      features,
    },
    counts,
  };
}

async function collectBuildingFeatures(
  bounds: TileBounds,
  marginMeters: number,
): Promise<GeoJsonFeatureCollection> {
  const index = await loadBuildingsObstacleIndex();
  if (!index) {
    return {
      type: "FeatureCollection",
      features: [],
    };
  }

  const minEasting = bounds.minEasting - marginMeters;
  const minNorthing = bounds.minNorthing - marginMeters;
  const maxEasting = bounds.maxEasting + marginMeters;
  const maxNorthing = bounds.maxNorthing + marginMeters;
  const features: GeoJsonFeature[] = [];

  for (const obstacle of index.obstacles) {
    if (
      obstacle.maxX < minEasting ||
      obstacle.minX > maxEasting ||
      obstacle.maxY < minNorthing ||
      obstacle.minY > maxNorthing
    ) {
      continue;
    }

    const footprint = obstacle.footprint && obstacle.footprint.length >= 3
      ? obstacle.footprint
      : [
          { x: obstacle.minX, y: obstacle.minY },
          { x: obstacle.maxX, y: obstacle.minY },
          { x: obstacle.maxX, y: obstacle.maxY },
          { x: obstacle.minX, y: obstacle.maxY },
        ];
    const geometryKind = obstacle.footprint && obstacle.footprint.length >= 3 ? "footprint" : "bbox";
    const ring = footprint.map((point) => {
      const wgs84 = lv95ToWgs84(point.x, point.y);
      return [wgs84.lon, wgs84.lat] as [number, number];
    });
    ring.push(ring[0]);
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [ring],
      },
      properties: {
        id: obstacle.id,
        minZ: obstacle.minZ,
        maxZ: obstacle.maxZ,
        height: obstacle.height,
        sourceZip: obstacle.sourceZip,
        geometryKind,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

function tileBoundsFeature(bounds: TileBounds): GeoJsonFeature {
  const sw = lv95ToWgs84(bounds.minEasting, bounds.minNorthing);
  const se = lv95ToWgs84(bounds.maxEasting, bounds.minNorthing);
  const ne = lv95ToWgs84(bounds.maxEasting, bounds.maxNorthing);
  const nw = lv95ToWgs84(bounds.minEasting, bounds.maxNorthing);
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [sw.lon, sw.lat],
        [se.lon, se.lat],
        [ne.lon, ne.lat],
        [nw.lon, nw.lat],
        [sw.lon, sw.lat],
      ]],
    },
    properties: {
      kind: "tile-bounds",
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function renderHtml(params: {
  summaries: Record<ModeName, ValueSummary>;
  points: GeoJsonFeatureCollection;
  buildings: GeoJsonFeatureCollection;
  tileBounds: GeoJsonFeatureCollection;
  counts: Record<string, number>;
  frame: number;
}): string {
  const raster = params.summaries["gpu-raster"];
  const frame = selectedFrame(raster, params.frame);
  const title = `Divergences bâtiments ${raster.tileId} ${raster.date} ${frame.localTime}`;
  const counts = {
    "---": params.counts["---"] ?? 0,
    "R--": params.counts["R--"] ?? 0,
    "-V-": params.counts["-V-"] ?? 0,
    "RV-": params.counts["RV-"] ?? 0,
    RVD: params.counts.RVD ?? 0,
  };

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1b1f23; }
    .panel {
      position: absolute;
      z-index: 1000;
      top: 12px;
      left: 12px;
      max-width: 420px;
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid rgba(0, 0, 0, 0.18);
      border-radius: 6px;
      padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      line-height: 1.35;
    }
    .panel h1 { font-size: 17px; margin: 0 0 8px; }
    .panel p { margin: 5px 0; font-size: 13px; }
    .legend { display: grid; grid-template-columns: auto 1fr auto; gap: 5px 8px; align-items: center; margin-top: 8px; font-size: 13px; }
    .swatch { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(0, 0, 0, 0.35); }
    .muted { color: #59636e; }
    .leaflet-popup-content { min-width: 260px; }
    .popup-title { font-weight: 700; margin-bottom: 6px; }
    .popup-grid { display: grid; grid-template-columns: 110px 1fr; gap: 3px 8px; font-size: 12px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <section class="panel">
    <h1>${escapeHtml(title)}</h1>
    <p>Frame ${params.frame}, ${escapeHtml(frame.utcTime)}, ${raster.stats.pointCount} points outdoor.</p>
    <p class="muted">R = gpu-raster, V = Rust/wgpu Vulkan, D = CPU détaillé. Les bâtiments affichés sont les géométries disponibles dans l'index local ; sur l'index actif sans footprint, le viewer affiche les bboxes SwissTopo filtrées autour de la tuile.</p>
    <div class="legend">
      <span class="swatch" style="background:#d73027"></span><span>R-- raster seul</span><strong>${counts["R--"]}</strong>
      <span class="swatch" style="background:#4575b4"></span><span>-V- Vulkan seul</span><strong>${counts["-V-"]}</strong>
      <span class="swatch" style="background:#7b3294"></span><span>RV- deux GPU, pas CPU</span><strong>${counts["RV-"]}</strong>
      <span class="swatch" style="background:#bdbdbd"></span><span>--- aucun blocage</span><strong>${counts["---"]}</strong>
      <span class="swatch" style="background:#4d4d4d"></span><span>RVD accord complet bloqué</span><strong>${counts.RVD}</strong>
    </div>
  </section>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const pointData = ${jsonForHtml(params.points)};
    const buildingData = ${jsonForHtml(params.buildings)};
    const tileBoundsData = ${jsonForHtml(params.tileBounds)};
    const categoryStyles = {
      "R--": { color: "#d73027", label: "gpu-raster seul" },
      "-V-": { color: "#4575b4", label: "Rust/wgpu Vulkan seul" },
      "RV-": { color: "#7b3294", label: "deux GPU, pas CPU détaillé" },
    };

    const map = L.map("map", { preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const buildingsLayer = L.geoJSON(buildingData, {
      style: {
        color: "#2f4f4f",
        weight: 1,
        fillColor: "#9aa7a7",
        fillOpacity: 0.28,
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        layer.bindPopup("<div class='popup-title'>Bâtiment " + escapeText(p.id) + "</div>" +
          "<div class='popup-grid'>" +
          row("height", p.height) +
          row("minZ", p.minZ) +
          row("maxZ", p.maxZ) +
          row("source", p.sourceZip) +
          row("géométrie", p.geometryKind) +
          "</div>");
      },
    }).addTo(map);

    const tileLayer = L.geoJSON(tileBoundsData, {
      style: {
        color: "#111111",
        weight: 2,
        fillOpacity: 0,
        dashArray: "6 6",
      },
    }).addTo(map);

    const pointsLayer = L.geoJSON(pointData, {
      pointToLayer: (feature, latlng) => {
        const category = feature.properties.category;
        const style = categoryStyles[category] || { color: "#111111" };
        return L.circleMarker(latlng, {
          radius: category === "RV-" ? 5 : 4,
          color: "#111111",
          weight: 1,
          fillColor: style.color,
          fillOpacity: 0.9,
        });
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const style = categoryStyles[p.category] || { label: p.category };
        layer.bindPopup("<div class='popup-title'>" + escapeText(p.category) + " · " + escapeText(style.label) + "</div>" +
          "<div class='popup-grid'>" +
          row("outdoorIndex", p.outdoorIndex) +
          row("point", p.pointId) +
          row("LV95 E", p.lv95Easting) +
          row("LV95 N", p.lv95Northing) +
          row("élévation", p.pointElevationMeters) +
          row("lat", p.lat) +
          row("lon", p.lon) +
          row("raster", p.rasterBlocked) +
          row("Vulkan", p.vulkanBlocked) +
          row("detailed", p.detailedBlocked) +
          "</div>");
      },
    }).addTo(map);

    const layers = {
      "Points divergents": pointsLayer,
      "Bâtiments index": buildingsLayer,
      "Bord de tuile": tileLayer,
    };
    L.control.layers({}, layers, { collapsed: false }).addTo(map);
    map.fitBounds(tileLayer.getBounds().pad(0.12));

    function row(label, value) {
      return "<span>" + escapeText(label) + "</span><strong>" + escapeText(String(value ?? "")) + "</strong>";
    }

    function escapeText(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }
  </script>
</body>
</html>`;
}

async function writeTextFile(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), filePath), value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summaryPaths = {
    "gpu-raster": await findSummaryPath(args.summaryDir, "gpu-raster", args.tileId),
    "rust-wgpu-vulkan": await findSummaryPath(args.summaryDir, "rust-wgpu-vulkan", args.tileId),
    detailed: await findSummaryPath(args.summaryDir, "detailed", args.tileId),
  };
  const summaries = {
    "gpu-raster": await readValueSummary(summaryPaths["gpu-raster"]),
    "rust-wgpu-vulkan": await readValueSummary(summaryPaths["rust-wgpu-vulkan"]),
    detailed: await readValueSummary(summaryPaths.detailed),
  };

  assertCompatible(summaries, args.frame);
  const bounds = parseTileBounds(summaries["gpu-raster"].tileId);
  const { collection: points, counts } = collectDivergentPointFeatures(summaries, args.frame);
  const buildings = args.includeBuildings
    ? await collectBuildingFeatures(bounds, args.buildingMarginMeters)
    : { type: "FeatureCollection" as const, features: [] };
  const tileBounds = {
    type: "FeatureCollection" as const,
    features: [tileBoundsFeature(bounds)],
  };

  await writeTextFile(args.out, renderHtml({
    summaries,
    points,
    buildings,
    tileBounds,
    counts,
    frame: args.frame,
  }));

  const absoluteOut = path.resolve(process.cwd(), args.out);
  console.log([
    `[divergence-viewer] wrote ${absoluteOut}`,
    `tile=${summaries["gpu-raster"].tileId}`,
    `frame=${args.frame}`,
    `points=${points.features.length}`,
    `buildings=${buildings.features.length}`,
    `counts=${Object.entries(counts).sort().map(([key, value]) => `${key}:${value}`).join(",")}`,
  ].join(" "));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
