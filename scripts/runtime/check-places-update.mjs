#!/usr/bin/env node
/**
 * Posture 4 — Baked image + fail-soft startup check.
 *
 * Runs at container startup BEFORE the main server. Queries GitHub
 * Releases for `places-v*` tags. If a newer one exists than the baked
 * `/data/processed/places/places.json`, downloads the JSON asset,
 * validates it, and writes it atomically to the tmpfs at
 * `/data/processed/places/places.json`, then re-splits per-region.
 *
 * Hard constraints:
 *   - 5s hard timeout (AbortController)
 *   - Catches every error class (DNS, HTTP, parse, disk)
 *   - ALWAYS exits 0, never blocks server startup
 *   - Logs warnings with `[places-check]` prefix
 *
 * Override the API base via MAPPY_PLACES_RELEASE_API_BASE for tests
 * (e.g. point at an invalid host to simulate offline).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLACES_DIR = "/data/processed/places";
const COMBINED_PATH = path.join(PLACES_DIR, "places.json");
const REPO = process.env.MAPPY_PLACES_REPO || "salfab/mappy-hour";
const API_BASE =
  process.env.MAPPY_PLACES_RELEASE_API_BASE || `https://api.github.com/repos/${REPO}/releases`;
const TIMEOUT_MS = 5000;

// Paranoia: any uncaught error in this script MUST NOT prevent the
// container from starting. Always exit 0.
process.on("uncaughtException", (err) => {
  console.warn(`[places-check] uncaughtException: ${err && err.message ? err.message : err}`);
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  console.warn(`[places-check] unhandledRejection: ${err && err.message ? err.message : err}`);
  process.exit(0);
});

function parseSemver(tag) {
  const m = /^places-v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function parseVersion(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function readBakedVersion() {
  try {
    const raw = fs.readFileSync(COMBINED_PATH, "utf8");
    const data = JSON.parse(raw);
    const v = parseVersion(data.version);
    if (!v) {
      console.warn(`[places-check] baked places.json has no parseable version field — treating as 0.0.0`);
      return { major: 0, minor: 0, patch: 0 };
    }
    return v;
  } catch (err) {
    console.warn(`[places-check] cannot read baked places.json (${err && err.message ? err.message : err}) — treating as 0.0.0`);
    return { major: 0, minor: 0, patch: 0 };
  }
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "mappy-hour-startup/1.0",
        ...(init.headers || {}),
      },
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const baked = readBakedVersion();
  console.log(`[places-check] baked version: ${baked.major}.${baked.minor}.${baked.patch}`);

  let releases;
  try {
    const resp = await fetchWithTimeout(API_BASE);
    if (!resp.ok) {
      console.warn(`[places-check] GitHub API returned HTTP ${resp.status} — sticking with baked`);
      return;
    }
    releases = await resp.json();
  } catch (err) {
    console.warn(`[places-check] GitHub API query failed (${err && err.message ? err.message : err}) — sticking with baked`);
    return;
  }

  if (!Array.isArray(releases)) {
    console.warn(`[places-check] GitHub API response not an array — sticking with baked`);
    return;
  }

  const candidates = releases
    .map((r) => ({ release: r, v: parseSemver(typeof r?.tag_name === "string" ? r.tag_name : "") }))
    .filter((c) => c.v !== null && !c.release.draft);
  if (candidates.length === 0) {
    console.log(`[places-check] no places-v* releases found — sticking with baked`);
    return;
  }
  candidates.sort((a, b) => cmpSemver(b.v, a.v));
  const top = candidates[0];

  if (cmpSemver(top.v, baked) <= 0) {
    console.log(`[places-check] baked is up-to-date (latest published = ${top.v.major}.${top.v.minor}.${top.v.patch})`);
    return;
  }

  console.log(`[places-check] newer release available: ${top.v.major}.${top.v.minor}.${top.v.patch} > baked`);

  const asset = Array.isArray(top.release.assets)
    ? top.release.assets.find((a) => a && a.name === "places.json")
    : null;
  if (!asset || typeof asset.browser_download_url !== "string") {
    console.warn(`[places-check] release has no places.json asset — sticking with baked`);
    return;
  }

  let body;
  try {
    const resp = await fetchWithTimeout(asset.browser_download_url, {
      headers: { Accept: "application/octet-stream" },
    });
    if (!resp.ok) {
      console.warn(`[places-check] asset download HTTP ${resp.status} — sticking with baked`);
      return;
    }
    body = await resp.text();
  } catch (err) {
    console.warn(`[places-check] asset download failed (${err && err.message ? err.message : err}) — sticking with baked`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    console.warn(`[places-check] downloaded places.json is not valid JSON (${err && err.message ? err.message : err}) — sticking with baked`);
    return;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.places)) {
    console.warn(`[places-check] downloaded places.json failed shape validation — sticking with baked`);
    return;
  }

  const tmpPath = `${COMBINED_PATH}.tmp`;
  try {
    fs.mkdirSync(PLACES_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, body, "utf8");
    fs.renameSync(tmpPath, COMBINED_PATH);
  } catch (err) {
    console.warn(`[places-check] failed to write updated places.json (${err && err.message ? err.message : err}) — sticking with baked`);
    try { fs.unlinkSync(tmpPath); } catch { /* swallow */ }
    return;
  }

  // Re-split per region using the sibling script.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const splitScript = path.join(here, "split-places-per-region.mjs");
    const result = spawnSync(process.execPath, [splitScript, COMBINED_PATH, PLACES_DIR], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.warn(`[places-check] split-places-per-region exited ${result.status} (non-fatal)`);
    }
  } catch (err) {
    console.warn(`[places-check] split-places-per-region failed (${err && err.message ? err.message : err}) (non-fatal)`);
  }

  console.log(`[places-check] updated to version ${parsed.version || "(unknown)"} from release ${top.release.tag_name}`);
}

main()
  .catch((err) => {
    console.warn(`[places-check] main() rejected (${err && err.message ? err.message : err}) — sticking with baked`);
  })
  .finally(() => {
    process.exit(0);
  });
