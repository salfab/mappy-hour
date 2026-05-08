/**
 * Generate a static HTML comparison of indoor detection methods.
 * Reads zenith grid metadata, convex hull footprints, and SSE data.
 *
 * Usage:
 *   npx tsx scripts/tools/generate-indoor-comparison.ts
 */
import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";

interface Area {
  name: string;
  obsId: string;
  centerLv95: [number, number];
  radius: number;
  tileId: string;
  tileOrigin: [number, number];
  sseFile: string;
}

const AREAS: Area[] = [
  {
    name: "Bâtiment en U (obs-42143)",
    obsId: "obs-42143",
    centerLv95: [2537772, 1152197],
    radius: 80,
    tileId: "e2537750_n1152000_s250",
    tileOrigin: [2537750, 1152000],
    sseFile: "data/tmp/sse-u-building.txt",
  },
  {
    name: "Cathédrale Notre-Dame",
    obsId: "obs-38852",
    centerLv95: [2538350, 1152700],
    radius: 80,
    tileId: "e2538250_n1152500_s250",
    tileOrigin: [2538250, 1152500],
    sseFile: "data/tmp/sse-cathedral.txt",
  },
];

function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function main() {
  const index = JSON.parse(await fs.readFile("data/processed/buildings/lausanne-buildings-index.json", "utf8"));

  const sections: string[] = [];

  for (const area of AREAS) {
    const [cx, cy] = area.centerLv95;
    const r = area.radius;
    const [tileE, tileN] = area.tileOrigin;
    const w = r * 2, h = r * 2;
    const minX = cx - r, minY = cy - r;

    // Load zenith grid metadata
    const gmBuf = await fs.readFile(`data/cache/tile-grid-metadata/lausanne/862929451170e67e/g1/${area.tileId}.json.gz`);
    const gm = JSON.parse(zlib.gunzipSync(gmBuf).toString());

    // Compute zenith and hull masks
    const zenithData: number[] = [];
    const hullData: number[] = [];
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const e = minX + ix + 0.5, n = minY + iy + 0.5;
        const gmIx = Math.floor(e) - tileE;
        const gmIy = Math.floor(n) - tileN;
        const gmIdx = gmIy * 250 + gmIx;
        zenithData.push((gmIx >= 0 && gmIx < 250 && gmIy >= 0 && gmIy < 250 && gm.indoor[gmIdx]) ? 1 : 0);

        let isInHull = false;
        for (const obs of index.obstacles) {
          if (!obs.footprint || obs.footprint.length < 3) continue;
          if (e < obs.minX - 1 || e > obs.maxX + 1 || n < obs.minY - 1 || n > obs.maxY + 1) continue;
          if (pointInPolygon(e, n, obs.footprint)) { isInHull = true; break; }
        }
        hullData.push(isInHull ? 1 : 0);
      }
    }

    // Parse SSE to get outdoor mask
    let sseData: number[] | null = null;
    try {
      const raw = await fs.readFile(area.sseFile, "utf8");
      const tileLines = raw.split("\n").filter(l => l.startsWith("data: {"));
      for (const line of tileLines) {
        const d = JSON.parse(line.slice(6));
        if (!d.tileId || !d.grid || !d.masksBase64) continue;
        // Check if this tile covers our area
        const g = d.grid;
        if (g.minIx > cx + r || g.minIx + g.width < cx - r) continue;
        if (g.minIy > cy + r || g.minIy + g.height < cy - r) continue;

        const buf = Buffer.from(d.masksBase64, "base64");
        const decompressed = zlib.gunzipSync(buf);
        const maskByteLen = Math.ceil(g.width * g.height / 8);
        const outdoorMask = decompressed.slice(0, maskByteLen);

        sseData = new Array(w * h).fill(-1);
        for (let iy = 0; iy < g.height; iy++) {
          for (let ix = 0; ix < g.width; ix++) {
            const gIx = g.minIx + ix;
            const gIy = g.minIy + iy;
            const lx = gIx - minX, ly = gIy - minY;
            if (lx >= 0 && lx < w && ly >= 0 && ly < h) {
              const sseIdx = iy * g.width + ix;
              const outdoor = (outdoorMask[sseIdx >> 3] >> (sseIdx & 7)) & 1;
              sseData[ly * w + lx] = outdoor ? 0 : 1;
            }
          }
        }
        break; // first matching tile
      }
    } catch {}

    const zenithIndoor = zenithData.filter(v => v).length;
    const hullIndoor = hullData.filter(v => v).length;
    const hullOnly = zenithData.reduce((n, z, i) => n + (!z && hullData[i] ? 1 : 0), 0);
    const zenithOnly = zenithData.reduce((n, z, i) => n + (z && !hullData[i] ? 1 : 0), 0);

    sections.push(`
    <h2>${area.name}</h2>
    <p class="stats">Zenith indoor: <b>${zenithIndoor}</b> | Hull indoor: <b>${hullIndoor}</b> | Courtyard recovered: <b style="color:#ef4444">${hullOnly} m²</b></p>
    <div class="row">
      <div><canvas id="z_${area.obsId}" width="${w}" height="${h}" style="width:${w*2}px;height:${h*2}px"></canvas><div class="label">Zenith Shadow Map</div></div>
      <div><canvas id="h_${area.obsId}" width="${w}" height="${h}" style="width:${w*2}px;height:${h*2}px"></canvas><div class="label">Convex Hull</div></div>
      <div><canvas id="d_${area.obsId}" width="${w}" height="${h}" style="width:${w*2}px;height:${h*2}px"></canvas><div class="label">Diff (<span style="color:#ef4444">■</span> courtyard recovered)</div></div>
      ${sseData ? `<div><canvas id="s_${area.obsId}" width="${w}" height="${h}" style="width:${w*2}px;height:${h*2}px"></canvas><div class="label">SSE (server response)</div></div>` : ""}
    </div>
    <script>
    (function() {
      var w=${w}, h=${h};
      var z=${JSON.stringify(zenithData)};
      var hu=${JSON.stringify(hullData)};
      ${sseData ? `var sse=${JSON.stringify(sseData)};` : ""}
      function draw(id, fn) {
        var c=document.getElementById(id); if(!c)return;
        var ctx=c.getContext("2d"), img=ctx.createImageData(w,h);
        for(var iy=0;iy<h;iy++) for(var ix=0;ix<w;ix++) {
          var i=iy*w+ix, ci=((h-1-iy)*w+ix)*4, rgb=fn(i);
          img.data[ci]=rgb[0]; img.data[ci+1]=rgb[1]; img.data[ci+2]=rgb[2]; img.data[ci+3]=255;
        }
        ctx.putImageData(img,0,0);
      }
      draw("z_${area.obsId}", function(i){ return z[i]?[60,60,80]:[220,200,120]; });
      draw("h_${area.obsId}", function(i){ return hu[i]?[60,60,80]:[220,200,120]; });
      draw("d_${area.obsId}", function(i){
        if(z[i]&&!hu[i]) return [34,197,94];
        if(!z[i]&&hu[i]) return [239,68,68];
        if(z[i]&&hu[i]) return [60,60,80];
        return [180,180,160];
      });
      ${sseData ? `draw("s_${area.obsId}", function(i){ return sse[i]===-1?[40,40,50]:sse[i]?[60,60,80]:[220,200,120]; });` : ""}
    })();
    </script>`);
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Indoor Detection Comparison</title>
<style>
body{margin:0;background:#1a1a2e;color:#eee;font:14px monospace;padding:20px;}
h1{text-align:center;margin-bottom:5px;}
h2{margin:20px 0 5px;text-align:center;}
.row{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;}
canvas{border:1px solid #444;image-rendering:pixelated;}
.label{text-align:center;font-size:11px;margin-top:4px;}
.stats{text-align:center;font-size:12px;color:#aaa;}
</style></head><body>
<h1>Indoor Detection: Zenith Shadow Map vs Convex Hull</h1>
<p style="text-align:center;color:#888;font-size:12px">Yellow=outdoor, Dark=indoor | Grid metadata uses real DXF mesh via zenith render</p>
${sections.join("\n")}
</body></html>`;

  await fs.writeFile("data/tmp/indoor-comparison.html", html);
  console.log("Wrote data/tmp/indoor-comparison.html (" + Math.round(html.length / 1024) + "KB)");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
