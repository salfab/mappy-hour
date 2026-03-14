import {
  purgeCacheRuns,
  verifyCacheRuns,
  type CacheAdminFilters,
} from "../../src/lib/admin/cache-admin";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

interface CliArgs extends CacheAdminFilters {
  action: "verify" | "purge";
  date?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    action: "verify",
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--action=")) {
      const value = arg.slice("--action=".length);
      if (value === "verify" || value === "purge") {
        result.action = value;
      }
      continue;
    }
    if (arg.startsWith("--region=")) {
      const value = arg.slice("--region=".length);
      if (value === "lausanne" || value === "nyon") {
        result.region = value as PrecomputedRegionName;
      }
      continue;
    }
    if (arg.startsWith("--model-version-hash=")) {
      result.modelVersionHash = arg.slice("--model-version-hash=".length);
      continue;
    }
    if (arg.startsWith("--date=")) {
      result.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--end-date=")) {
      result.endDate = arg.slice("--end-date=".length);
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
    }
  }

  if (result.date) {
    result.startDate = result.date;
    result.endDate = result.date;
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filters: CacheAdminFilters = {
    region: args.region,
    modelVersionHash: args.modelVersionHash,
    startDate: args.startDate,
    endDate: args.endDate,
  };

  if (args.action === "verify") {
    const result = await verifyCacheRuns(filters);
    console.log(JSON.stringify(result, null, 2));
    if (result.problems.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await purgeCacheRuns(filters, {
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(
    `[cache-admin] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
