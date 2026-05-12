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

import path from "node:path";

import {
  quarantineCorruptAssignments,
  scanAdaptiveHorizonAssignments,
} from "../../src/lib/diag/adaptive-horizon-check";

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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const result = await scanAdaptiveHorizonAssignments({ root: args.root });
  const total = result.okCount + result.corrupt.length;

  process.stdout.write(
    `\n[adaptive-horizon-check] scanned ${total} files in ${(result.durationMs / 1000).toFixed(1)}s\n`,
  );
  process.stdout.write(`  ✓ OK:      ${result.okCount}\n`);
  if (result.corrupt.length === 0) {
    process.stdout.write(`  \x1b[32m✓ corrupt: 0 — all good.\x1b[0m\n`);
    return 0;
  }
  const byRegion = new Map<string, number>();
  for (const c of result.corrupt) byRegion.set(c.region, (byRegion.get(c.region) ?? 0) + 1);
  process.stdout.write(`  \x1b[1;31m✗ corrupt: ${result.corrupt.length}\x1b[0m\n`);
  for (const [region, count] of [...byRegion.entries()].sort()) {
    process.stdout.write(`      ${region}: ${count}\n`);
  }
  process.stdout.write(`\nCorrupt files:\n`);
  for (const c of result.corrupt) {
    process.stdout.write(
      `  ${c.path}\n      \x1b[33m${c.error}\x1b[0m  (size=${c.size}B)\n`,
    );
  }

  if (args.quarantine) {
    process.stdout.write(`\n\x1b[36m[quarantine] renaming corrupt files...\x1b[0m\n`);
    const q = await quarantineCorruptAssignments(result.corrupt);
    for (const f of q.failed) {
      process.stderr.write(`  \x1b[31mfailed: ${f.path}: ${f.error}\x1b[0m\n`);
    }
    process.stdout.write(`  renamed ${q.renamed}/${result.corrupt.length}\n`);
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

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `\x1b[1;31m[adaptive-horizon-check] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}\x1b[0m\n`,
    );
    process.exit(2);
  },
);
