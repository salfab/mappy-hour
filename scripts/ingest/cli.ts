export interface IngestCliArgs {
  dryRun: boolean;
  overwrite: boolean;
  maxItems?: number;
}

export function parseIngestCliArgs(argv: string[]): IngestCliArgs {
  let dryRun = false;
  let overwrite = false;
  let maxItems: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--overwrite") {
      overwrite = true;
      continue;
    }

    if (arg === "--max-items" && i + 1 < argv.length) {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next > 0) {
        maxItems = Math.floor(next);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--max-items=")) {
      const [, rawValue] = arg.split("=");
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxItems = Math.floor(parsed);
      }
    }
  }

  return {
    dryRun,
    overwrite,
    maxItems,
  };
}
