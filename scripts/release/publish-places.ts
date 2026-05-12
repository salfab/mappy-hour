/**
 * Orchestrator for places releases.
 *
 *  1. Run `download-places-osm.ts --regions=lausanne,nyon,vevey_city` to
 *     regenerate the combined `data/processed/places/places.json`.
 *  2. Pick the next semver tag by querying `gh release list` filtered on
 *     `places-v*`. Bump policy controlled by `--bump=major|minor|patch`
 *     (default = patch).
 *  3. Write the bumped `version` field into the combined places.json.
 *  4. Create a GitHub release with `gh release create places-vX.Y.Z`
 *     attaching `places.json`. The release stays `--draft` unless
 *     `--publish-now` is passed.
 *
 *  The very first places release MUST be triggered by the operator
 *  manually (the CLAUDE.md instructions for Posture 4 say so).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PROCESSED_PLACES_DIR } from "../../src/lib/storage/data-paths";

interface Cli {
  bump: "major" | "minor" | "patch";
  publishNow: boolean;
  regions: string;
}

function parseArgs(argv: string[]): Cli {
  let bump: Cli["bump"] = "patch";
  let publishNow = false;
  let regions = "lausanne,nyon,vevey_city";
  for (const arg of argv) {
    if (arg.startsWith("--bump=")) {
      const v = arg.slice("--bump=".length);
      if (v !== "major" && v !== "minor" && v !== "patch") {
        throw new Error(`Invalid --bump value: ${v}`);
      }
      bump = v;
    } else if (arg === "--publish-now") {
      publishNow = true;
    } else if (arg.startsWith("--regions=")) {
      regions = arg.slice("--regions=".length);
    }
  }
  return { bump, publishNow, regions };
}

function run(cmd: string, args: string[], opts: { capture?: boolean } = {}): string {
  const result = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${result.status}`);
  }
  return (result.stdout ?? "").trim();
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(tag: string): Semver | null {
  const m = /^places-v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatTag(v: Semver): string {
  return `places-v${v.major}.${v.minor}.${v.patch}`;
}

function bumpVersion(v: Semver, bump: Cli["bump"]): Semver {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function findLatestPlacesTag(): Semver | null {
  let out: string;
  try {
    out = run("gh", ["release", "list", "--limit", "200", "--json", "tagName", "--jq", ".[].tagName"], { capture: true });
  } catch {
    console.warn("[publish-places] gh release list failed — assuming no prior release");
    return null;
  }
  const versions: Semver[] = out
    .split(/\r?\n/)
    .map(parseSemver)
    .filter((v): v is Semver => v !== null);
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    return b.patch - a.patch;
  });
  return versions[0];
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  console.log(`[publish-places] bump=${cli.bump} publishNow=${cli.publishNow} regions=${cli.regions}`);

  const latest = findLatestPlacesTag();
  const next = latest ? bumpVersion(latest, cli.bump) : { major: 0, minor: 1, patch: 0 };
  const nextTag = formatTag(next);
  const nextVersion = `${next.major}.${next.minor}.${next.patch}`;
  console.log(`[publish-places] latest=${latest ? formatTag(latest) : "(none)"} next=${nextTag}`);

  // (1) Regenerate combined places.json
  run("npx", ["tsx", "scripts/ingest/download-places-osm.ts", `--regions=${cli.regions}`]);

  // (2) Patch the version field
  const combinedPath = path.join(PROCESSED_PLACES_DIR, "places.json");
  const json = JSON.parse(fs.readFileSync(combinedPath, "utf8"));
  json.version = nextVersion;
  fs.writeFileSync(combinedPath, JSON.stringify(json, null, 2), "utf8");
  console.log(`[publish-places] wrote version=${nextVersion} into ${combinedPath}`);

  // (3) gh release create
  // `--latest=false` prevents this places release from clobbering the
  // atlas `v9.2.YYYYMMDDNNN` release as GitHub's "Latest" tag — atlas-loader
  // uses `--release=latest` to find the atlas manifest, so latest must
  // stay on the atlas track. Places releases are addressed by their tag
  // prefix (`places-v*`) via the runtime check, no need to mark them latest.
  const args = [
    "release",
    "create",
    nextTag,
    combinedPath,
    "--title",
    `Places ${nextVersion}`,
    "--notes",
    `Auto-generated places dataset for regions: ${cli.regions}\n\nTotal places: ${json.totalPlaces}\nGenerated at: ${json.generatedAt}`,
    "--latest=false",
  ];
  if (!cli.publishNow) args.push("--draft");

  run("gh", args);
  console.log(`[publish-places] release ${nextTag} created (${cli.publishNow ? "published" : "draft"})`);
}

try {
  main();
} catch (err) {
  console.error(`[publish-places] failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
