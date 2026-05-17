/**
 * Preflight atlas health check, run before any precompute starts.
 *
 * Two responsibilities:
 *
 *  A. **Fail-fast on missing horizon DEM manifest** — atlases generated without
 *     a terrain horizon mask declare cells as "sunny" that should actually be
 *     blocked by distant relief (Jorat, Alps...). The runtime `terrainHorizonMethod`
 *     in the atlas meta ends up as `"none"`, and divergences of ~3× on sunny
 *     counts have been observed because of this. Refusing to even start the
 *     precompute is the safest option.
 *
 *  B. **Quarantine unhealthy atlases already on disk** — past precompute runs
 *     have left atlases with `model.terrainHorizonMethod === "none"` or with a
 *     `"No horizon mask. ..."` warning. These are silently incorrect. Before
 *     producing fresh atlases, we move every unhealthy atlas (and its `.atlas.idx`
 *     sidecar) under `data/_quarantine/<timestamp>/...` so the run rebuilds
 *     them. We never delete; we move.
 *
 * Called from the precompute entrypoints (`precompute-region-sunlight.ts` and
 * `precompute-all-regions-sunlight.ts`) so the safety net is uniform.
 *
 * See: `project_no_horizon_warning_false_positive_todo.md` in user memory and
 * the orphan-atlas bug found 2026-05-15.
 */

import fs from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import path from "node:path";

import { decodeTileAtlasFromBinary } from "@/lib/precompute/sunlight-cache-atlas";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";
import { ensureHorizonDemManifestForRegion } from "@/lib/ingest/horizon-dem";
import {
  CACHE_SUNLIGHT_DIR,
  DATA_ROOT,
  RAW_HORIZON_DEM_DIR,
  RAW_HORIZON_DEM_MANIFEST_LAUSANNE_PATH,
  RAW_HORIZON_DEM_MANIFEST_NYON_PATH,
} from "@/lib/storage/data-paths";

const gunzip = promisify(gunzipCb);

// Lazy zstd, mirroring sunlight-cache-atlas.ts. We do raw filesystem reads here
// (not going through the cache loader API), so we need our own decompression.
let _zstd:
  | { decompress: typeof import("@mongodb-js/zstd").decompress }
  | null
  | undefined;
function getZstd() {
  if (_zstd === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _zstd = require("@mongodb-js/zstd");
    } catch {
      _zstd = null;
    }
  }
  return _zstd;
}

export interface PreflightUnhealthyAtlas {
  filePath: string;
  modelVersionHash: string;
  gridStepMeters: number;
  resolutionDeg: string;
  tileId: string;
  reason: "none" | "warning";
}

export interface PreflightScanResult {
  scanned: number;
  healthy: number;
  quarantined: PreflightUnhealthyAtlas[];
  /** Atlases that could not be decoded (corrupt header, truncated payload, etc.). */
  unreadable: Array<{ filePath: string; error: string }>;
  /** Set to a non-null value once at least one quarantine destination has been allocated. */
  quarantineRoot: string | null;
}

/**
 * Returns the absolute path to the Copernicus DEM30 horizon manifest for a
 * region. For lausanne/nyon we use the explicit constants in
 * `data-paths.ts`; for other regions we synthesise the path following the same
 * convention (`<RAW_HORIZON_DEM_DIR>/manifest-<region>-horizon.json`).
 *
 * Centralising this here means callers (preflight, future ingest scripts)
 * agree on the layout and we have one place to fix if the convention changes.
 */
export function getHorizonDemManifestPath(region: PrecomputedRegionName): string {
  switch (region) {
    case "lausanne":
      return RAW_HORIZON_DEM_MANIFEST_LAUSANNE_PATH;
    case "nyon":
      return RAW_HORIZON_DEM_MANIFEST_NYON_PATH;
    default:
      // Convention from download-<region>-horizon-dem.ts scripts.
      return path.join(RAW_HORIZON_DEM_DIR, `manifest-${region}-horizon.json`);
  }
}

/**
 * Ensures the horizon manifest for the region is on disk. If missing, fetches
 * the Copernicus DEM 30 m tiles covering the region's horizon bbox and writes
 * the manifest in place — so the precompute can proceed instead of skipping
 * the region. Idempotent: a region that already has tiles + manifest is a no-op
 * (no network calls).
 *
 * Throws only if the download itself fails (network error, unknown region).
 */
export async function ensureHorizonDemManifest(
  region: PrecomputedRegionName,
): Promise<void> {
  const manifestPath = getHorizonDemManifestPath(region);
  try {
    await fs.access(manifestPath);
    return;
  } catch {
    // Manifest missing — generate it.
  }

  console.log(
    `[preflight] Manifest horizon DEM manquant pour ${region}: ${manifestPath}. ` +
      `Téléchargement des tuiles Copernicus DEM 30 m en cours…`,
  );
  try {
    const result = await ensureHorizonDemManifestForRegion(region, {
      verbose: true,
    });
    console.log(
      `[preflight] Manifest horizon DEM généré pour ${region} ` +
        `(${result.counts.downloaded} downloaded, ${result.counts.skipped} cached, ${result.counts.notFound} not-found).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `[preflight] Manifest horizon DEM manquant pour ${region}: ${manifestPath}. ` +
        `Tentative de téléchargement automatique a échoué (${message}). ` +
        `Run \`npx tsx scripts/ingest/download-horizon-dem.ts --region=${region}\` manually.`,
    );
  }
}

/**
 * Decompress raw bytes from disk transparently — gzip (legacy) or zstd.
 *
 * Mirrors the magic-byte detection in `sunlight-cache-atlas.ts` but operates
 * directly on bytes we read with fs/promises so we don't have to thread the
 * storage abstraction through preflight.
 */
async function decompressAtlasBytes(raw: Buffer): Promise<Buffer> {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return (await gunzip(raw)) as Buffer;
  }
  if (
    raw.length >= 4 &&
    raw[0] === 0x28 &&
    raw[1] === 0xb5 &&
    raw[2] === 0x2f &&
    raw[3] === 0xfd
  ) {
    const zstd = getZstd();
    if (!zstd) {
      throw new Error(
        "[preflight] zstd binary unavailable; reinstall with build tools or set MAPPY_ATLAS_COMPRESSION=gzip",
      );
    }
    return (await zstd.decompress(raw)) as Buffer;
  }
  throw new Error(
    `[preflight] unknown compression format (first bytes ${[...raw.slice(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")})`,
  );
}

const NO_HORIZON_WARNING_FRAGMENT = "No horizon mask";

interface AtlasHealthCheck {
  healthy: boolean;
  reason: PreflightUnhealthyAtlas["reason"] | null;
}

/**
 * Pure: given decoded atlas meta, decide whether it is healthy.
 *
 * Exposed for tests — exercising the full disk pipeline isn't practical for a
 * format-level invariant.
 */
export function classifyAtlasMetaHealth(meta: {
  model?: Record<string, unknown> | undefined;
  warnings?: readonly string[] | undefined;
}): AtlasHealthCheck {
  const method = meta.model?.terrainHorizonMethod;
  if (typeof method === "string" && method === "none") {
    return { healthy: false, reason: "none" };
  }
  const warnings = meta.warnings ?? [];
  for (const w of warnings) {
    if (typeof w === "string" && w.includes(NO_HORIZON_WARNING_FRAGMENT)) {
      return { healthy: false, reason: "warning" };
    }
  }
  return { healthy: true, reason: null };
}

/**
 * Quarantine path under `<DATA_ROOT>/_quarantine/<YYYY-MM-DD-HH-MM-SS>/...`
 * Preserves the relative arborescence under CACHE_SUNLIGHT_DIR so it is
 * straightforward to inspect or restore.
 *
 * We pick the timestamp once per preflight invocation (passed in) so all
 * atlases moved in the same run land in the same dated folder.
 */
function buildQuarantineDestination(
  sourcePath: string,
  cacheRoot: string,
  quarantineRoot: string,
): string {
  // `path.relative` returns POSIX or Win32 separators depending on platform;
  // both `fs.rename` and `fs.copyFile` accept either, no normalisation needed.
  const rel = path.relative(cacheRoot, sourcePath);
  return path.join(quarantineRoot, "cache", "sunlight", rel);
}

function timestampForQuarantine(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/**
 * Move `src` to `dest`. Uses `fs.rename` first (atomic on same volume); on
 * cross-device failure (Windows: EXDEV) we fall back to copy+unlink so this
 * works when DATA_ROOT lives on a different drive than the cache.
 */
async function moveFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/**
 * Recursively walk `<CACHE_SUNLIGHT_DIR>/<region>/` collecting every
 * `*.atlas.bin.gz` (note: the `.gz` suffix is historical — the payload may be
 * gzip OR zstd). Returns absolute paths.
 *
 * We don't try to be clever and only scan `r0.75` etc.; we just enumerate every
 * file matching the suffix because the format already encodes resolution in
 * the meta — better to over-scan than miss a tile.
 */
async function findAtlasFiles(regionRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Region dir may not exist on a fresh machine: a healthy precompute run
      // simply has nothing to scan.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".atlas.bin.gz")) {
        out.push(full);
      }
    }
  }
  await walk(regionRoot);
  return out;
}

interface AtlasPathParts {
  modelVersionHash: string;
  gridStepMeters: number;
  resolutionDeg: string;
  tileId: string;
}

/**
 * Decode the structure `<CACHE_SUNLIGHT_DIR>/<region>/<hash>/g<grid>/atlas/r<res>/<tileId>.atlas.bin.gz`
 * back into its component parts for logging purposes.
 *
 * Returns null if the file path does not match the expected layout. We don't
 * throw because preflight is best-effort and stranded files (e.g. an old
 * format) shouldn't block the run.
 */
function parseAtlasPath(
  regionRoot: string,
  absPath: string,
): AtlasPathParts | null {
  const rel = path.relative(regionRoot, absPath);
  const segments = rel.split(/[/\\]/);
  if (segments.length !== 5) return null;
  const [hash, gridDir, atlasDir, resDir, file] = segments;
  if (!gridDir.startsWith("g")) return null;
  if (atlasDir !== "atlas") return null;
  if (!resDir.startsWith("r")) return null;
  if (!file.endsWith(".atlas.bin.gz")) return null;
  const gridStepMeters = Number(gridDir.slice(1));
  if (!Number.isFinite(gridStepMeters) || gridStepMeters <= 0) return null;
  const tileId = file.slice(0, file.length - ".atlas.bin.gz".length);
  return {
    modelVersionHash: hash,
    gridStepMeters,
    resolutionDeg: resDir.slice(1),
    tileId,
  };
}

export interface PreflightOptions {
  /** Override quarantine root for tests. Defaults to `<DATA_ROOT>/_quarantine/<timestamp>`. */
  quarantineRootOverride?: string;
  /** Override sunlight cache root for tests. Defaults to `CACHE_SUNLIGHT_DIR`. */
  cacheRootOverride?: string;
  /** Inject a clock for tests so the timestamp is deterministic. */
  now?: Date;
  /** Sink for human-readable progress. Tests pass a no-op. */
  logger?: (line: string) => void;
}

/**
 * Scans every atlas under `<CACHE_SUNLIGHT_DIR>/<region>/` (all model hashes,
 * grid steps and resolutions) and quarantines those whose meta indicates a
 * missing terrain horizon.
 *
 * Idempotent: re-running after a successful scan finds nothing to quarantine.
 * Failures to decode individual atlases are reported in `unreadable` but do
 * not stop the scan — we want to know about them but the run can still
 * proceed.
 */
export async function scanAndQuarantineAtlases(
  region: PrecomputedRegionName,
  options: PreflightOptions = {},
): Promise<PreflightScanResult> {
  const logger = options.logger ?? ((line: string) => console.log(line));
  const cacheRoot = options.cacheRootOverride ?? CACHE_SUNLIGHT_DIR;
  const regionRoot = path.join(cacheRoot, region);
  const files = await findAtlasFiles(regionRoot);

  const result: PreflightScanResult = {
    scanned: 0,
    healthy: 0,
    quarantined: [],
    unreadable: [],
    quarantineRoot: null,
  };

  // Lazily compute the quarantine root only when we know we'll need it.
  let quarantineRoot: string | null = null;
  function ensureQuarantineRoot(): string {
    if (quarantineRoot !== null) return quarantineRoot;
    quarantineRoot =
      options.quarantineRootOverride ??
      path.join(
        DATA_ROOT,
        "_quarantine",
        timestampForQuarantine(options.now ?? new Date()),
      );
    result.quarantineRoot = quarantineRoot;
    return quarantineRoot;
  }

  const total = files.length;
  if (total === 0) {
    logger(`[preflight] ${region}: aucun atlas à scanner`);
    return result;
  }
  logger(`[preflight] ${region}: ${total} atlas à scanner…`);
  const scanStart = Date.now();
  const PROGRESS_EVERY = Math.max(1, Math.min(500, Math.ceil(total / 20)));

  for (const filePath of files) {
    result.scanned++;

    if (result.scanned % PROGRESS_EVERY === 0 || result.scanned === total) {
      const elapsed = (Date.now() - scanStart) / 1000;
      const rate = result.scanned / elapsed;
      const remaining = total - result.scanned;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
      const etaStr = etaSec > 60
        ? `${Math.floor(etaSec / 60)}m${etaSec % 60}s`
        : `${etaSec}s`;
      logger(
        `[preflight] ${region}: ${result.scanned}/${total} (${Math.round((result.scanned / total) * 100)}%)` +
        ` healthy=${result.healthy} quarantined=${result.quarantined.length}` +
        (result.scanned < total ? ` ETA≈${etaStr}` : ` elapsed=${Math.round(elapsed)}s`),
      );
    }

    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch (error) {
      result.unreadable.push({
        filePath,
        error: (error as Error).message,
      });
      continue;
    }

    let decompressed: Buffer;
    try {
      decompressed = await decompressAtlasBytes(raw);
    } catch (error) {
      result.unreadable.push({
        filePath,
        error: (error as Error).message,
      });
      continue;
    }

    let meta: { model?: Record<string, unknown>; warnings?: string[] };
    try {
      const atlas = decodeTileAtlasFromBinary(new Uint8Array(decompressed));
      meta = { model: atlas.meta.model, warnings: atlas.meta.warnings };
    } catch (error) {
      result.unreadable.push({
        filePath,
        error: (error as Error).message,
      });
      continue;
    }

    const health = classifyAtlasMetaHealth(meta);
    if (health.healthy) {
      result.healthy++;
      continue;
    }

    const parts = parseAtlasPath(regionRoot, filePath);
    const tileLabel = parts ? `${parts.modelVersionHash}/${parts.tileId}` : filePath;
    logger(`[preflight] quarantine ${tileLabel} reason=${health.reason}`);

    const qroot = ensureQuarantineRoot();
    const dest = buildQuarantineDestination(filePath, cacheRoot, qroot);
    await moveFile(filePath, dest);

    // Move the sidecar `.atlas.idx` if it exists next to the atlas. It's
    // derived from the atlas content, so an orphan sidecar would mislead
    // skip-existing checks.
    const sidecar = filePath.replace(/\.atlas\.bin\.gz$/, ".atlas.idx");
    const sidecarDest = dest.replace(/\.atlas\.bin\.gz$/, ".atlas.idx");
    try {
      await fs.access(sidecar);
      await moveFile(sidecar, sidecarDest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Surface unexpected errors but don't abort the rest of the scan.
        logger(`[preflight] sidecar move failed for ${tileLabel}: ${(error as Error).message}`);
      }
    }

    result.quarantined.push({
      filePath,
      modelVersionHash: parts?.modelVersionHash ?? "(unknown)",
      gridStepMeters: parts?.gridStepMeters ?? -1,
      resolutionDeg: parts?.resolutionDeg ?? "(unknown)",
      tileId: parts?.tileId ?? path.basename(filePath),
      reason: health.reason ?? "none",
    });
  }

  logger(
    `[preflight] scanned ${result.scanned} atlases, ${result.healthy} healthy, ${result.quarantined.length} quarantined`,
  );
  if (result.unreadable.length > 0) {
    logger(
      `[preflight] ${result.unreadable.length} atlas(es) unreadable — see logs above (left in place, will be retried next run).`,
    );
  }
  return result;
}

export interface PreflightOutcome {
  /** True if the precompute should proceed for this region. */
  ok: boolean;
  /** Human-readable explanation when `ok=false`. */
  reason?: string;
  scan?: PreflightScanResult;
}

/**
 * Single entrypoint used by the precompute scripts:
 *
 *   1. Verifies the horizon DEM manifest exists for `region`.
 *   2. Scans existing atlases for that region and quarantines unhealthy ones.
 *
 * Throws on programming errors only. Manifest-missing returns `{ ok: false,
 * reason }` so the multi-region orchestrator can skip the region without
 * tearing down the whole run.
 */
export async function runPreflight(
  region: PrecomputedRegionName,
  options: PreflightOptions = {},
): Promise<PreflightOutcome> {
  try {
    await ensureHorizonDemManifest(region);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const scan = await scanAndQuarantineAtlases(region, options);
  return { ok: true, scan };
}
