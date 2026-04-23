import fs from "node:fs/promises";

async function main() {
  const data = JSON.parse(
    await fs.readFile("data/processed/precompute/partial-atlas-lausanne.json", "utf8"),
  ) as { tiles: Array<{ tileId: string }> };

  const parsed = data.tiles.map((t) => {
    const m = /^e(\d+)_n(\d+)_s250$/.exec(t.tileId)!;
    return { tileId: t.tileId, e: +m[1], n: +m[2] };
  });

  const eMin = Math.min(...parsed.map((p) => p.e));
  const eMax = Math.max(...parsed.map((p) => p.e));
  const nMin = Math.min(...parsed.map((p) => p.n));
  const nMax = Math.max(...parsed.map((p) => p.n));

  const corruptSet = new Set(parsed.map((p) => `${p.e}_${p.n}`));

  console.log(`Lausanne footprint: E=[${eMin}..${eMax}] N=[${nMin}..${nMax}]`);
  console.log(`Dimensions: ${(eMax - eMin) / 250 + 1} × ${(nMax - nMin) / 250 + 1} tiles`);
  console.log(`Legend: █ = corrompue  (partial atlas, bBlk≈0%)   ░ = saine ou absente\n`);

  for (let n = nMax; n >= nMin; n -= 250) {
    let line = `${n}: `;
    for (let e = eMin; e <= eMax; e += 250) {
      line += corruptSet.has(`${e}_${n}`) ? "█" : "·";
    }
    console.log(line);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
