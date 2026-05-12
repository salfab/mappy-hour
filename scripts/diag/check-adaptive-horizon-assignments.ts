#!/usr/bin/env tsx
/**
 * Scan every adaptive-horizon assignment JSON under
 * `data/processed/horizon/adaptive-sharing/**\/*.json` and report which ones
 * are unparseable (root cause = non-atomic write in `persistAssignment()`,
 * ADR-0023).
 *
 * Usage:
 *   pnpm diag:adaptive-horizon                  # scan + report
 *   pnpm diag:adaptive-horizon --quarantine     # also rename corrupt → .corrupt-<ts>
 *   pnpm diag:adaptive-horizon --root <dir>     # custom scan root
 *
 * Exit code:
 *   0 — all assignments parse cleanly
 *   1 — at least one assignment is corrupt
 *   2 — script failed (I/O, bad args, …)
 */

import fs from "node:fs/promises";
import path from "node:path";

interface Args {
  root: string;
  quarantine: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: path.resolve(process.cwd(), "data/processed/horizon/adaptive-sharing"),
    quarantine: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quarantine") args.quarantine = true;
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx scripts/diag/check-adaptive-horizon-assignments.ts " +
          "[--root <dir>] [--quarantine]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`\x1b[1;31munknown arg: ${a}\x1b[0m\n`);
      process.exit(2);
    }
  }
  return args;
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

interface Corrupt {
  path: string;
  size: number;
  error: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let okCount = 0;
  let corruptCount = 0;
  const corruptByRegion = new Map<string, number>();
  const corruptDetails: Corrupt[] = [];

  for await (const file of walkJson(args.root)) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      process.stderr.write(
        `\x1b[1;31m[read-fail] ${file}: ${(err as Error).message}\x1b[0m\n`,
      );
      continue;
    }
    try {
      JSON.parse(raw);
      okCount++;
    } catch (err) {
      corruptCount++;
      const region = inferRegion(file, args.root);
      corruptByRegion.set(region, (corruptByRegion.get(region) ?? 0) + 1);
      corruptDetails.push({
        path: file,
        size: raw.length,
        error: (err as Error).message,
      });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const total = okCount + corruptCount;

  process.stdout.write(
    `\n[adaptive-horizon-check] scanned ${total} files in ${(elapsedMs / 1000).toFixed(1)}s\n`,
  );
  process.stdout.write(`  ✓ OK:      ${okCount}\n`);
  if (corruptCount === 0) {
    process.stdout.write(`  \x1b[32m✓ corrupt: 0 — all good.\x1b[0m\n`);
    return 0;
  }
  process.stdout.write(`  \x1b[1;31m✗ corrupt: ${corruptCount}\x1b[0m\n`);
  for (const [region, count] of [...corruptByRegion.entries()].sort()) {
    process.stdout.write(`      ${region}: ${count}\n`);
  }
  process.stdout.write(`\nCorrupt files:\n`);
  for (const c of corruptDetails) {
    process.stdout.write(
      `  ${c.path}\n      \x1b[33m${c.error}\x1b[0m  (size=${c.size}B)\n`,
    );
  }

  if (args.quarantine) {
    process.stdout.write(`\n\x1b[36m[quarantine] renaming corrupt files...\x1b[0m\n`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let renamed = 0;
    for (const c of corruptDetails) {
      const target = `${c.path}.corrupt-${stamp}`;
      try {
        await fs.rename(c.path, target);
        renamed++;
      } catch (err) {
        process.stderr.write(
          `  \x1b[31mfailed: ${c.path}: ${(err as Error).message}\x1b[0m\n`,
        );
      }
    }
    process.stdout.write(`  renamed ${renamed}/${corruptDetails.length}\n`);
    process.stdout.write(
      `\nThese assignments will be regenerated cleanly on the next precompute that touches their tile/date.\n`,
    );
  } else {
    process.stdout.write(
      `\nRe-run with \x1b[1m--quarantine\x1b[0m to rename them (they'll be regenerated next time the affected tile/date is precomputed).\n`,
    );
  }
  return 1;
}

function inferRegion(file: string, root: string): string {
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  return parts[0] ?? "<unknown>";
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `\x1b[1;31m[adaptive-horizon-check] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}\x1b[0m\n`,
    );
    process.exit(2);
  },
);
