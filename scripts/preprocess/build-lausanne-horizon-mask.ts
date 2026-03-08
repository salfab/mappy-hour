import fs from "node:fs/promises";
import path from "node:path";

import {
  LAUSANNE_CENTER,
  LAUSANNE_HORIZON_RADIUS_KM,
} from "../../src/lib/config/lausanne";

async function main() {
  const outputPath = path.join(
    process.cwd(),
    "data",
    "processed",
    "horizon",
    "lausanne-horizon-mask.json",
  );

  const binsDeg = Array.from({ length: 360 }, () => 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    method: "flat-placeholder",
    center: LAUSANNE_CENTER,
    radiusKm: LAUSANNE_HORIZON_RADIUS_KM,
    binsDeg,
    notes:
      "Placeholder horizon mask. Replace with DEM-derived horizon angles in the next iteration.",
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`[horizon-mask] Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(
    `[horizon-mask] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
