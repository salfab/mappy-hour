/**
 * Export 3D mesh for a specific area as a JSON file + open a Three.js viewer.
 *
 * Usage:
 *   npx tsx scripts/tools/export-mesh-viewer.ts --center=2538350,1152720 --radius=100
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { loadGpuMeshes } from "../../src/lib/sun/gpu-mesh-loader";

interface Args {
  centerX: number;
  centerY: number;
  radius: number;
}

function parseArgs(argv: string[]): Args {
  let centerX = 2538350, centerY = 1152720, radius = 100;
  for (const arg of argv) {
    if (arg.startsWith("--center=")) {
      const [x, y] = arg.slice(9).split(",").map(Number);
      centerX = x; centerY = y;
    } else if (arg.startsWith("--radius=")) {
      radius = Number(arg.slice(9));
    }
  }
  return { centerX, centerY, radius };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[mesh-export] Loading buildings index...`);
  const index = await loadBuildingsObstacleIndex();
  if (!index) throw new Error("No buildings index");

  // Filter obstacles in the area
  const nearby = index.obstacles.filter(o =>
    o.centerX > args.centerX - args.radius &&
    o.centerX < args.centerX + args.radius &&
    o.centerY > args.centerY - args.radius &&
    o.centerY < args.centerY + args.radius
  );
  console.log(`[mesh-export] ${nearby.length} obstacles in radius ${args.radius}m around ${args.centerX},${args.centerY}`);

  // Load meshes
  const originX = args.centerX;
  const originY = args.centerY;
  const meshResult = await loadGpuMeshes(nearby, originX, originY);
  console.log(`[mesh-export] ${meshResult.dxfTriangleCount} DXF triangles, ${meshResult.fallbackTriangleCount} fallback`);

  // Convert to JSON-friendly format: array of [x,y,z] triplets per triangle
  const vertices = meshResult.vertices;
  const triangles: number[][] = [];
  for (let i = 0; i < vertices.length; i += 9) {
    triangles.push([
      vertices[i], vertices[i+1], vertices[i+2],
      vertices[i+3], vertices[i+4], vertices[i+5],
      vertices[i+6], vertices[i+7], vertices[i+8],
    ]);
  }

  const outputDir = path.join(process.cwd(), "data", "tmp");
  await fs.mkdir(outputDir, { recursive: true });

  const meshPath = path.join(outputDir, "mesh-export.json");
  await fs.writeFile(meshPath, JSON.stringify({
    originX, originY,
    triangleCount: triangles.length,
    obstacleCount: nearby.length,
    triangles,
  }));
  console.log(`[mesh-export] Wrote ${meshPath} (${triangles.length} triangles)`);

  // Write HTML viewer
  const htmlPath = path.join(outputDir, "mesh-viewer.html");
  await fs.writeFile(htmlPath, `<!DOCTYPE html>
<html>
<head>
  <title>MappyHour 3D Mesh Viewer</title>
  <style>body { margin: 0; overflow: hidden; background: #1a1a2e; }
  #info { position: absolute; top: 10px; left: 10px; color: #eee; font: 14px monospace; background: rgba(0,0,0,0.7); padding: 8px; border-radius: 4px; }</style>
</head>
<body>
  <div id="info">Loading mesh...</div>
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -200; sun.shadow.camera.right = 200;
    sun.shadow.camera.top = 200; sun.shadow.camera.bottom = -200;
    scene.add(sun);

    // Ground plane
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x3a5a40, roughness: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Load mesh
    const resp = await fetch('./mesh-export.json');
    const data = await resp.json();

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(data.triangles.length * 9);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < data.triangles.length; i++) {
      const t = data.triangles[i];
      // DXF coords: x=easting-origin, y=elevation, z=northing-origin
      // Three.js: x=right, y=up, z=toward camera
      for (let v = 0; v < 3; v++) {
        positions[i*9 + v*3 + 0] = t[v*3 + 0]; // x = easting
        positions[i*9 + v*3 + 1] = t[v*3 + 1]; // y = elevation (up)
        positions[i*9 + v*3 + 2] = -t[v*3 + 2]; // z = -northing (Three.js convention)
        if (t[v*3+1] < minY) minY = t[v*3+1];
        if (t[v*3+1] > maxY) maxY = t[v*3+1];
      }
    }
    // Shift ground plane to min elevation
    ground.position.y = minY - 0.1;

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0xc4a882,
      roughness: 0.7,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Camera position
    const height = maxY - minY;
    camera.position.set(120, height + 40, 120);
    controls.target.set(0, minY + height/2, 0);
    controls.update();

    document.getElementById('info').textContent =
      data.triangleCount + ' triangles, ' + data.obstacleCount + ' obstacles — ' +
      'origin: ' + data.originX + ', ' + data.originY;

    // Animate
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });
  </script>
</body>
</html>`);
  console.log(`[mesh-export] Wrote ${htmlPath}`);
  console.log(`[mesh-export] Open in browser: file://${htmlPath.replace(/\\/g, '/')}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
