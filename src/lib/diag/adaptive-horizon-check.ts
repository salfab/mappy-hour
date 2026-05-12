/**
 * Pure scan logic for adaptive-horizon assignment JSON corruption (ADR-0023).
 *
 * Shared between the standalone CLI (`scripts/diag/check-adaptive-horizon-
 * assignments.ts`) and the end-of-run sanity check baked into the precompute
 * driver. Walks every `*.json` under the given root and tries to `JSON.parse`
 * each one — anything that throws is flagged as corrupt. Catches both
 * signatures we've seen in the wild:
 *
 *  - "Unexpected non-whitespace character after JSON at position N"
 *    → write-over-longer-payload (the ADR-0023 signature).
 *  - "Unexpected end of JSON input"
 *    → process killed mid-write.
 *
 * Does NOT validate the schema (a well-formed-but-semantically-bogus payload
 * slips through). That's a separate, larger problem.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface CorruptAssignment {
  /** Absolute path of the offending JSON. */
  path: string;
  /** Size in bytes. Useful for spotting trailing-garbage cases (size > the
   *  position reported in the parse error). */
  size: number;
  /** The `JSON.parse` error message verbatim. */
  error: string;
  /** Region key derived from the path (top-level dir under `root`). */
  region: string;
  /** Date segment (`YYYY-MM-DD`) when the path has the canonical layout, else null. */
  date: string | null;
  /** Window segment (`tHHMM-HHMM`) when the path has the canonical layout, else null. */
  window: string | null;
}

export interface ScanResult {
  okCount: number;
  corrupt: CorruptAssignment[];
  scanRoot: string;
  durationMs: number;
}

async function* walkJson(root: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkJson(full);
    } else if (e.isFile() && e.name.endsWith(".json")) {
      yield full;
    }
  }
}

export async function scanAdaptiveHorizonAssignments(opts: {
  root: string;
}): Promise<ScanResult> {
  const startedAt = Date.now();
  let okCount = 0;
  const corrupt: CorruptAssignment[] = [];

  for await (const file of walkJson(opts.root)) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // read failures aren't our concern here — surfaced upstream
    }
    try {
      JSON.parse(raw);
      okCount++;
    } catch (err) {
      const { region, date, window } = inferPathSegments(file, opts.root);
      corrupt.push({
        path: file,
        size: raw.length,
        error: (err as Error).message,
        region,
        date,
        window,
      });
    }
  }

  return {
    okCount,
    corrupt,
    scanRoot: opts.root,
    durationMs: Date.now() - startedAt,
  };
}

/** Pull region / date / window from a canonical path like
 *  `<root>/<region>/<hash>/g{N}/m15/<date>/<window>.json`. Returns nulls for
 *  segments that don't match the expected pattern. */
function inferPathSegments(
  file: string,
  root: string,
): { region: string; date: string | null; window: string | null } {
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  const region = parts[0] ?? "<unknown>";
  // parts: [region, hash, g{N}, m15, date, "<window>.json"]
  const date = parts[4] && /^\d{4}-\d{2}-\d{2}$/.test(parts[4]) ? parts[4] : null;
  const windowFile = parts[5] ?? "";
  const window = /^t\d{4}-\d{4}\.json$/.test(windowFile)
    ? windowFile.replace(/\.json$/, "")
    : null;
  return { region, date, window };
}

/** Quarantine: rename corrupt files to `<path>.corrupt-<iso>`. The next
 *  precompute touching the affected tile/date regenerates them cleanly. */
export async function quarantineCorruptAssignments(
  corrupt: CorruptAssignment[],
): Promise<{ renamed: number; failed: Array<{ path: string; error: string }> }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const failed: Array<{ path: string; error: string }> = [];
  let renamed = 0;
  for (const c of corrupt) {
    try {
      await fs.rename(c.path, `${c.path}.corrupt-${stamp}`);
      renamed++;
    } catch (err) {
      failed.push({ path: c.path, error: (err as Error).message });
    }
  }
  return { renamed, failed };
}
