/**
 * Embarque le JSON de tuiles directement dans le HTML de la carte,
 * permettant d'ouvrir le fichier sans serveur HTTP (file://).
 *
 * Usage :
 *   node scripts/tools/embed-tile-selection-in-map.mjs
 *   node scripts/tools/embed-tile-selection-in-map.mjs \
 *     --json=data/processed/precompute/high-value-tile-selection.top-priority.json \
 *     --html=docs/assets/high-value-tiles-top-priority-map.html
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_JSON = path.join(
  ROOT,
  "data/processed/precompute/high-value-tile-selection.top-priority.json",
);
const DEFAULT_HTML = path.join(ROOT, "docs/assets/high-value-tiles-top-priority-map.html");

function parseArgs(argv) {
  const result = { json: DEFAULT_JSON, html: DEFAULT_HTML };
  for (const arg of argv) {
    if (arg.startsWith("--json=")) {
      result.json = path.resolve(ROOT, arg.slice("--json=".length));
    } else if (arg.startsWith("--html=")) {
      result.html = path.resolve(ROOT, arg.slice("--html=".length));
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const jsonRaw = await fs.readFile(args.json, "utf8");
  const html = await fs.readFile(args.html, "utf8");

  // Remplace le placeholder null par les données JSON
  const PLACEHOLDER = "const SELECTION_DATA = null;";
  if (!html.includes(PLACEHOLDER)) {
    // Si déjà embarqué, remplace l'ancienne valeur
    const re = /const SELECTION_DATA = (\{[\s\S]*?\});(\s*\/\/[^\n]*)?\n/;
    if (!re.test(html)) {
      throw new Error(`Placeholder introuvable dans ${args.html}. Attendu : ${PLACEHOLDER}`);
    }
  }

  const jsonOneLine = JSON.stringify(JSON.parse(jsonRaw));
  const updated = html.replace(
    /const SELECTION_DATA = (?:null|\{[\s\S]*?\});/,
    `const SELECTION_DATA = ${jsonOneLine};`,
  );

  await fs.writeFile(args.html, updated, "utf8");
  console.log(
    `[embed-tile-selection] JSON embarqué (${Math.round(jsonOneLine.length / 1024)} KB) dans ${path.relative(ROOT, args.html)}`,
  );
}

main().catch((err) => {
  console.error(`[embed-tile-selection] Erreur : ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
