/**
 * Append manually-supplied tiles to the top-priority selection file.
 *
 * Reads region assignments from _classify-new-tiles.ts output, merges them
 * into data/processed/precompute/high-value-tile-selection.top-priority.json
 * as zero-score manual entries, and skips tiles that are already present.
 */
import fs from "node:fs";

type Region = "lausanne" | "morges" | "nyon" | "geneve";

interface TileEntry {
  tileId: string;
  region: Region;
  score: number;
  counts: {
    totalPlaces: number;
    parks: number;
    terraceCandidates: number;
    outdoorSeating: number;
  };
  subcategories: Record<string, number>;
  samplePlaceNames: string[];
  targetAreaIds: string[];
  targetAreaLabels: string[];
  notes: string[];
}

interface Selection {
  generatedAt: string;
  selectionVersion: number;
  source: string;
  tileSizeMeters: number;
  selectionPolicy: unknown;
  areas: unknown[];
  tiles: TileEntry[];
  selectionProfile?: string;
  derivedFrom?: string;
}

const SELECTION_PATH =
  "C:/sources/MappyHour/data/processed/precompute/high-value-tile-selection.top-priority.json";
const ASSIGNMENTS_PATH =
  "C:/Users/fabio.salvalai/AppData/Local/Temp/new-tile-assignments.json";
const MANUAL_AREA_ID = "manual-addition-2026-04-18";
const MANUAL_AREA_LABEL = "Ajout manuel — 2026-04-18";
const MANUAL_NOTE = "Tuile ajoutée manuellement (batch 2026-04-18)";

const selection = JSON.parse(fs.readFileSync(SELECTION_PATH, "utf8")) as Selection;
const assignments = JSON.parse(fs.readFileSync(ASSIGNMENTS_PATH, "utf8")) as Record<
  string,
  Region
>;

const existingIds = new Set(selection.tiles.map((t) => t.tileId));

const added: TileEntry[] = [];
const skipped: string[] = [];

for (const [tileId, region] of Object.entries(assignments)) {
  if (existingIds.has(tileId)) {
    skipped.push(tileId);
    continue;
  }
  const entry: TileEntry = {
    tileId,
    region,
    score: 0,
    counts: { totalPlaces: 0, parks: 0, terraceCandidates: 0, outdoorSeating: 0 },
    subcategories: {},
    samplePlaceNames: [],
    targetAreaIds: [MANUAL_AREA_ID],
    targetAreaLabels: [MANUAL_AREA_LABEL],
    notes: [MANUAL_NOTE],
  };
  added.push(entry);
  existingIds.add(tileId);
}

selection.tiles = [...selection.tiles, ...added];
selection.generatedAt = new Date().toISOString();

fs.writeFileSync(SELECTION_PATH, JSON.stringify(selection, null, 2), "utf8");

console.log(`Added ${added.length} new tiles, skipped ${skipped.length} already present.`);
console.log(`Total tiles in selection: ${selection.tiles.length}`);
// Region breakdown of added
const byRegion: Record<string, number> = {};
for (const t of added) byRegion[t.region] = (byRegion[t.region] ?? 0) + 1;
console.log("added per region:", byRegion);
