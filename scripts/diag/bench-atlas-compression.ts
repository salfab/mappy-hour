/**
 * Micro-bench: measure gzip compression ratio vs time across levels for a real atlas.
 *
 * Usage: npx tsx scripts/diag/bench-atlas-compression.ts <path-to-atlas.bin.gz>
 */
import fs from "node:fs/promises";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: bench-atlas-compression.ts <atlas.bin.gz>");
    process.exit(1);
  }

  const compressed = await fs.readFile(filePath);
  const raw = (await gunzip(compressed)) as Buffer;
  console.log(`Source: ${filePath}`);
  console.log(`  compressed (level 6 default): ${compressed.length} B`);
  console.log(`  raw binary:                   ${raw.length} B`);
  console.log(`  baseline ratio:               ${(raw.length / compressed.length).toFixed(2)}x`);
  console.log();

  const levels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
  const iterations = 5;

  console.log(`Compression bench (N=${iterations} iterations, median reported):\n`);
  console.log("level  size(KB)  ratio   mean-ms  median-ms   throughput-MB/s");
  console.log("-----  --------  -----   -------  ---------   ---------------");
  const results: { level: number; size: number; medianMs: number }[] = [];
  for (const level of levels) {
    const times: number[] = [];
    let outSize = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const out = (await gzip(raw, { level })) as Buffer;
      times.push(performance.now() - t0);
      outSize = out.length;
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const median = times[Math.floor(times.length / 2)];
    const mb = raw.length / 1024 / 1024;
    const throughput = mb / (median / 1000);
    const ratio = raw.length / outSize;
    console.log(
      `  ${level}    ${(outSize / 1024).toFixed(1).padStart(7)}   ${ratio.toFixed(2).padStart(4)}x  ${mean.toFixed(1).padStart(6)}    ${median.toFixed(1).padStart(6)}    ${throughput.toFixed(0).padStart(8)}`,
    );
    results.push({ level, size: outSize, medianMs: median });
  }

  console.log();
  console.log("Decompression bench (same N):\n");
  console.log("level  size(KB)  decompress-median-ms  throughput-MB/s");
  console.log("-----  --------  --------------------  ---------------");
  for (const r of results) {
    const comp = (await gzip(raw, { level: r.level })) as Buffer;
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await gunzip(comp);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const mb = raw.length / 1024 / 1024;
    console.log(
      `  ${r.level}    ${(r.size / 1024).toFixed(1).padStart(7)}   ${median.toFixed(1).padStart(14)}   ${(mb / (median / 1000)).toFixed(0).padStart(8)}`,
    );
  }

  console.log();
  console.log("Raw (no compression) write bench for reference:");
  const rawTimes: number[] = [];
  const tmpPath = `${filePath}.raw.tmp`;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fs.writeFile(tmpPath, raw);
    rawTimes.push(performance.now() - t0);
  }
  rawTimes.sort((a, b) => a - b);
  await fs.unlink(tmpPath).catch(() => {});
  const rawMedian = rawTimes[Math.floor(rawTimes.length / 2)];
  console.log(`  write raw ${(raw.length / 1024).toFixed(1)}KB to disk: ${rawMedian.toFixed(1)}ms median`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
