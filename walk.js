/*
 * walk.js: builds a real 3D model of an area (terrain + satellite texture + textured buildings),
 * lets you walk or fly around in it, and exports it as a .glb file.
 *
 * Data: AWS Terrain Tiles (elevation), Esri World Imagery (texture), OpenFreeMap vector tiles (buildings).
 * Exposes window.Walk3D.open({ bbox:[w,s,e,n], name, facadeCanvas(name), facades:{wallName: roofColor} }).
 */
const THREE_URL = 'three';
let libs = null;
async function loadLibs() {
  if (libs) return libs;
  const [THREE, exp, vt, pbf] = await Promise.all([
    import(THREE_URL),
    import('three/addons/exporters/GLTFExporter.js'),
    import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm'),
    import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm'),
  ]);
  libs = { THREE, GLTFExporter: exp.GLTFExporter, VectorTile: vt.VectorTile, Pbf: pbf.default };
  return libs;
}

// ---------------------------------------------------------------- tile math
const lng2tx = (lng, z) => (lng + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const tx2lng = (x, z) => x / 2 ** z * 360 - 180;
const ty2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function pool(jobs, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) await jobs[i++](); }));
}

/** Stitches raster tiles covering bbox at zoom z into one canvas. */
async function mosaic(bbox, z, urlFn, onProgress) {
  const [w, s, e, n] = bbox;
  const xa = Math.floor(lng2tx(w, z)), xb = Math.floor(lng2tx(e, z));
  const ya = Math.floor(lat2ty(n, z)), yb = Math.floor(lat2ty(s, z));
  const T = 256, cols = xb - xa + 1, rows = yb - ya + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * T; canvas.height = rows * T;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let done = 0, failed = 0;
  const jobs = [];
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    jobs.push(async () => {
      try {
        const r = await fetch(urlFn(z, x, y));
        if (!r.ok) throw new Error(r.status);
        const img = await createImageBitmap(await r.blob());
        ctx.drawImage(img, (x - xa) * T, (y - ya) * T, T, T);
      } catch (err) { failed++; }
      onProgress && onProgress(++done, cols * rows);
    });
  }
  await pool(jobs, 8);
  if (failed === cols * rows) throw new Error('could not download any tiles');
  return {
    canvas, ctx, z,
    px: (lng) => (lng2tx(lng, z) - xa) * T,
    py: (lat) => (lat2ty(lat, z) - ya) * T,
  };
}

function pickZoom(bbox, maxZ, maxPx, maxTiles) {
  const [w, s, e, n] = bbox;
  for (let z = maxZ; z > 1; z--) {
    const pw = (lng2tx(e, z) - lng2tx(w, z)) * 256, ph = (lat2ty(s, z) - lat2ty(n, z)) * 256;
    const tiles = (Math.floor(lng2tx(e, z)) - Math.floor(lng2tx(w, z)) + 1) * (Math.floor(lat2ty(s, z)) - Math.floor(lat2ty(n, z)) + 1);
    if (pw <= maxPx && ph <= maxPx && tiles <= maxTiles) return z;
  }
  return 2;
}

// Sutherland–Hodgman clip of a ring (array of [lng,lat]) to a lng/lat rectangle.
function clipRing(ring, [w, s, e, n]) {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const edges = [
    [(p) => p[0] >= w, (a, b) => [w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n]],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    pts = out;
  }
  return pts;
}

const signedArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ build
const WIN = 3.2; // metres per facade texture repeat (one window bay / one storey)
const MATS = ['fac-brick', 'fac-stone', 'fac-plaster', 'fac-concrete', 'fac-sand'];

async function buildModel(opts, progress) {
  const { THREE, VectorTile, Pbf } = await loadLibs();
  const [w, s, e, n] = opts.bbox;
  const lng0 = (w + e) / 2, lat0 = (s + n) / 2;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), kz = 110574;
  const W = (e - w) * kx, H = (n - s) * kz;           // metres
  const toX = (lng) => (lng - lng0) * kx;
  const toN = (lat) => (lat - lat0) * kz;              // north metres; three z = -north

  // 1. elevation
  progress('Downloading elevation…');
  const dz = pickZoom(opts.bbox, 15, 1024, 16);
  const dem = await mosaic(opts.bbox, dz, (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
  const dimg = dem.ctx.getImageData(0, 0, dem.canvas.width, dem.canvas.height);
  const DW = dem.canvas.width, DH = dem.canvas.height;
  const elev = new Float32Array(DW * DH);
  for (let i = 0; i < elev.length; i++) elev[i] = dimg.data[i * 4] * 256 + dimg.data[i * 4 + 1] + dimg.data[i * 4 + 2] / 256 - 32768;
  const demAt = (lng, lat) => {
    const x = clamp(dem.px(lng) - 0.5, 0, DW - 1.001), y = clamp(dem.py(lat) - 0.5, 0, DH - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * DW + x0;
    return elev[i] * (1 - fx) * (1 - fy) + elev[i + 1] * fx * (1 - fy) + elev[i + DW] * (1 - fx) * fy + elev[i + DW + 1] * fx * fy;
  };

  // 2. satellite texture, cropped to the area
  const sz = pickZoom(opts.bbox, 19, 4096, 320);  // 4096 px is the largest texture most GPUs (incl. phones) accept
  const sat = await mosaic(opts.bbox, sz,
    (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    (d, t) => progress(`Downloading satellite imagery… ${d}/${t}`));
  const cx0 = Math.floor(sat.px(w)), cy0 = Math.floor(sat.py(n));
  const cw = Math.max(1, Math.ceil(sat.px(e)) - cx0), ch = Math.max(1, Math.ceil(sat.py(s)) - cy0);
  const texCanvas = document.createElement('canvas');
  texCanvas.width = cw; texCanvas.height = ch;
  texCanvas.getContext('2d').drawImage(sat.canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);

  // 3. terrain grid
  progress('Shaping terrain…');
  const spacing = Math.max(2.5, Math.max(W, H) / 280);
  const nx = Math.max(8, Math.round(W / spacing)), nz = Math.max(8, Math.round(H / spacing));
  const hg = new Float32Array((nx + 1) * (nz + 1));
  let hmin = Infinity;
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const v = demAt(w + (e - w) * i / nx, n - (n - s) * j / nz);
    hg[j * (nx + 1) + i] = v; if (v < hmin) hmin = v;
  }
  for (let k = 0; k < hg.length; k++) hg[k] -= hmin;
  const xmin = -W / 2, zmin = -H / 2;
  const terrainH = (x, z) => {
    const fi = clamp((x - xmin) / W * nx, 0, nx - 1e-6), fj = clamp((z - zmin) / H * nz, 0, nz - 1e-6);
    const i = Math.floor(fi), j = Math.floor(fj), fx = fi - i, fy = fj - j, k = j * (nx + 1) + i;
    return hg[k] * (1 - fx) * (1 - fy) + hg[k + 1] * fx * (1 - fy) + hg[k + nx + 1] * (1 - fx) * fy + hg[k + nx + 2] * fx * fy;
  };

  const tpos = new Float32Array((nx + 1) * (nz + 1) * 3), tuv = new Float32Array((nx + 1) * (nz + 1) * 2);
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const k = j * (nx + 1) + i, x = xmin + W * i / nx, z = zmin + H * j / nz;
    tpos.set([x, hg[k], z], k * 3);
    const lng = w + (e - w) * i / nx, lat = n - (n - s) * j / nz;
    tuv.set([(sat.px(lng) - cx0) / cw, 1 - (sat.py(lat) - cy0) / ch], k * 2);
  }
  const tidx = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    tidx.push(a, c, b, b, c, d);
  }
  const tgeo = new THREE.BufferGeometry();
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  tgeo.setAttribute('uv', new THREE.BufferAttribute(tuv, 2));
  tgeo.setIndex(tidx);
  tgeo.computeVertexNormals();
  const satTex = new THREE.CanvasTexture(texCanvas);
  satTex.colorSpace = THREE.SRGBColorSpace;
  satTex.anisotropy = 8;
  satTex.userData.mimeType = 'image/jpeg';
  const terrain = new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ map: satTex, roughness: 1, metalness: 0, name: 'Satellite ground' }));
  terrain.name = 'Terrain';
  terrain.receiveShadow = true;

  // Skirt + base so the exported model is a closed "diorama" block.
  const skirtBottom = -8;
  const perim = [];
  for (let i = 0; i <= nx; i++) perim.push([i, 0]);
  for (let j = 1; j <= nz; j++) perim.push([nx, j]);
  for (let i = nx - 1; i >= 0; i--) perim.push([i, nz]);
  for (let j = nz - 1; j >= 1; j--) perim.push([0, j]);
  const sp = [];
  const P = ([i, j]) => [xmin + W * i / nx, hg[j * (nx + 1) + i], zmin + H * j / nz];
  const pushTri = (arr, a, b, c, out) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nxv = uy * vz - uz * vy, nzv = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c[0]) / 3, mz = (a[2] + b[2] + c[2]) / 3;
    if (out && nxv * mx + nzv * mz < 0) arr.push(...a, ...c, ...b); else arr.push(...a, ...b, ...c);
  };
  for (let k = 0; k < perim.length; k++) {
    const p = P(perim[k]), q = P(perim[(k + 1) % perim.length]);
    const pb = [p[0], skirtBottom, p[2]], qb = [q[0], skirtBottom, q[2]];
    pushTri(sp, p, pb, qb, true); pushTri(sp, p, qb, q, true);
  }
  sp.push(xmin, skirtBottom, zmin, xmin + W, skirtBottom, zmin, xmin, skirtBottom, zmin + H,
    xmin + W, skirtBottom, zmin, xmin + W, skirtBottom, zmin + H, xmin, skirtBottom, zmin + H);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sgeo.computeVertexNormals();
  const skirt = new THREE.Mesh(sgeo, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1, name: 'Soil' }));
  skirt.name = 'Base';

  // 4. buildings from vector tiles
  progress('Downloading buildings…');
  const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
  const tpl = tj.tiles[0];
  const bz = 14;
  const tiles = [];
  for (let x = Math.floor(lng2tx(w, bz)); x <= Math.floor(lng2tx(e, bz)); x++)
    for (let y = Math.floor(lat2ty(n, bz)); y <= Math.floor(lat2ty(s, bz)); y++) tiles.push([x, y]);
  const raw = [];
  await pool(tiles.map(([x, y]) => async () => {
    const r = await fetch(tpl.replace('{z}', bz).replace('{x}', x).replace('{y}', y));
    if (!r.ok) return;
    const vt = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
    const layer = vt.layers.building;
    if (!layer) return;
    // Clip every piece to its own tile, so buildings cut by tile edges join without overlaps.
    const rect = [Math.max(w, tx2lng(x, bz)), Math.max(s, ty2lat(y + 1, bz)), Math.min(e, tx2lng(x + 1, bz)), Math.min(n, ty2lat(y, bz))];
    if (rect[0] >= rect[2] || rect[1] >= rect[3]) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3 || f.properties.hide_3d) continue;
      const g = f.toGeoJSON(x, y, bz).geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const rings = poly.map((rg) => clipRing(rg, rect)).filter((rg) => rg.length >= 3);
        if (!rings.length || clipRing(poly[0], rect).length < 3) continue;
        raw.push({ id: f.id || 0, h: +f.properties.render_height || 8, minH: +f.properties.render_min_height || 0, rings });
      }
    }
  }), 6);

  progress(`Building ${raw.length.toLocaleString()} buildings…`);
  const buckets = {}; // key -> {pos:[], nor:[], uv:[]}
  const bucket = (k) => (buckets[k] || (buckets[k] = { pos: [], nor: [], uv: [] }));
  const footprints = [];
  for (const b of raw) {
    const rings = b.rings.map((r) => r.map(([lng, lat]) => [toX(lng), toN(lat)]));
    if (Math.abs(signedArea(rings[0])) < 2) continue;
    rings.forEach((r, i) => { const a = signedArea(r); if ((i === 0 && a < 0) || (i > 0 && a > 0)) r.reverse(); });
    let ground = Infinity;
    for (const [x, y] of rings[0]) ground = Math.min(ground, terrainH(x, -y));
    const top = ground + b.h, base = ground + b.minH;
    if (top - base < 0.5) continue;
    const bottom = b.minH > 0 ? base : ground - 1.5;
    const tall = b.h >= 45;
    const mi = (Math.floor(b.id / 10) + Math.floor(b.h)) % 5;
    const wallKey = tall ? 'fac-glass' : MATS[mi];
    const W_ = bucket('w:' + wallKey), R_ = bucket('r:' + wallKey);
    for (const r of rings) {
      let acc = 0;
      for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        const nxv = dy / len, nzv = dx / len;
        const A0 = [ax, bottom, -ay], B0 = [bx, bottom, -by], B1 = [bx, top, -by], A1 = [ax, top, -ay];
        const u0 = acc / WIN, u1 = (acc + len) / WIN, v0 = (bottom - ground) / WIN, v1 = b.h / WIN;
        W_.pos.push(...A0, ...B0, ...B1, ...A0, ...B1, ...A1);
        for (let t = 0; t < 6; t++) W_.nor.push(nxv, 0, nzv);
        W_.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
        acc += len;
      }
    }
    const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
    const holes = rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const all = contour.concat(...holes);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      const a = all[i], c = all[j], d = all[k];
      // with three z = -north, a counter-clockwise (x,north) triangle already faces +Y
      const ccw = (c.x - a.x) * (d.y - a.y) - (c.y - a.y) * (d.x - a.x) > 0;
      const tri = ccw ? [a, c, d] : [a, d, c];
      for (const p of tri) { R_.pos.push(p.x, top, -p.y); R_.nor.push(0, 1, 0); R_.uv.push(0, 0); }
    }
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of rings[0]) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    footprints.push({ rings, top, base, bottom, minx, miny, maxx, maxy });
  }

  const group = new THREE.Group();
  group.name = opts.name || 'Area';
  group.add(terrain, skirt);
  const texCache = {};
  const facadeTex = (name) => {
    if (texCache[name]) return texCache[name];
    const t = new THREE.CanvasTexture(opts.facadeCanvas(name));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return (texCache[name] = t);
  };
  for (const [key, bk] of Object.entries(buckets)) {
    if (!bk.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    const [kind, mat] = key.split(':');
    const label = mat.replace('fac-', '');
    const material = kind === 'w'
      ? new THREE.MeshStandardMaterial({ map: facadeTex(mat), roughness: mat === 'fac-glass' ? 0.35 : 0.9, metalness: mat === 'fac-glass' ? 0.25 : 0, name: `${label} walls` })
      : new THREE.MeshStandardMaterial({ color: new THREE.Color(opts.facades[mat]), roughness: 0.85, name: `${label} roofs` });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `Buildings (${label} ${kind === 'w' ? 'walls' : 'roofs'})`;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // spatial index of footprints for walking collisions
  const CELL = 16, grid = new Map();
  footprints.forEach((f, idx) => {
    for (let gx = Math.floor(f.minx / CELL); gx <= Math.floor(f.maxx / CELL); gx++)
      for (let gy = Math.floor(f.miny / CELL); gy <= Math.floor(f.maxy / CELL); gy++) {
        const k = gx + ',' + gy; (grid.get(k) || grid.set(k, []).get(k)).push(idx);
      }
  });
  const buildingAt = (x, z) => {
    const y = -z, list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL));
    if (!list) return null;
    for (const idx of list) {
      const f = footprints[idx];
      if (x < f.minx || x > f.maxx || y < f.miny || y > f.maxy) continue;
      if (pointInRing(x, y, f.rings[0]) && !f.rings.slice(1).some((h) => pointInRing(x, y, h))) return f;
    }
    return null;
  };

  return { group, W, H, terrainH, buildingAt, buildings: footprints.length, maxH: Math.max(...hg) };
}

// ----------------------------------------------------------------- viewer
let ui = null;
let session = null;
let cache = null; // { key, model }

function el(tag, attrs, html) { const d = document.createElement(tag); Object.assign(d, attrs || {}); if (html != null) d.innerHTML = html; return d; }

function buildUI() {
  const root = el('div', { id: 'walk' });
  root.innerHTML = `
    <div class="w-top">
      <div class="w-title"><b>Walking in 3D</b><span id="w-name"></span></div>
      <div class="w-btns">
        <button id="w-fly" title="Toggle flying (F)">Fly</button>
        <button id="w-dl" class="primary" disabled>Download 3D file (.glb)</button>
        <button id="w-exit" title="Exit">Exit</button>
      </div>
    </div>
    <div id="w-load"><div class="w-spin"></div><div id="w-msg">Preparing…</div></div>
    <div id="w-help" hidden>
      <b>Click to look around.</b> W A S D or arrow keys to move · mouse to look · Shift to run · Space to jump ·
      F to fly (Space up, C down) · Esc to release the mouse
    </div>
    <div id="w-joy" hidden><div></div></div>
    <button id="w-jump" hidden>Jump</button>`;
  document.body.appendChild(root);
  return root;
}

async function open(opts) {
  if (session) return;
  ui = ui || buildUI();
  ui.hidden = false;
  document.body.classList.add('walking');
  const $ = (id) => ui.querySelector('#' + id);
  $('w-name').textContent = opts.name ? ' · ' + opts.name : '';
  $('w-load').hidden = false; $('w-help').hidden = true; $('w-dl').disabled = true;
  const msg = (t) => { $('w-msg').textContent = t; };
  session = { closed: false };
  const s = session;
  $('w-exit').onclick = close;

  let model;
  try {
    msg('Loading 3D engine…');
    const { THREE } = await loadLibs();
    const key = opts.bbox.map((v) => v.toFixed(6)).join(',');
    if (cache && cache.key === key) model = cache.model;
    else {
      model = await buildModel(opts, (t) => { if (!s.closed) msg(t); });
      cache = { key, model };
    }
    if (s.closed) return;
    startViewer(THREE, model, opts, s);
  } catch (err) {
    console.error(err);
    msg('Could not build the 3D model: ' + (err.message || err));
  }
}

function startViewer(THREE, model, opts, s) {
  const $ = (id) => ui.querySelector('#' + id);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'w-canvas';
  ui.insertBefore(renderer.domElement, ui.firstChild);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x9fc8ef);
  scene.background = sky;
  const span = Math.max(model.W, model.H);
  scene.fog = new THREE.Fog(sky, span * 0.5, span * 1.6);
  scene.add(model.group);
  scene.add(new THREE.HemisphereLight(0xd6ebff, 0x6b5a45, 1.3));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-span * 0.35, span * 0.55 + 200, span * 0.25);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -model.W / 2; sc.right = model.W / 2; sc.top = model.H / 2; sc.bottom = -model.H / 2;
  sc.near = 1; sc.far = span * 3 + 1000;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, span * 4 + 2000);
  camera.rotation.order = 'YXZ';

  // start in the middle, or the nearest open spot
  let px = 0, pz = 0;
  for (let k = 0; k < 400 && model.buildingAt(px, pz); k++) {
    const a = k * 0.7, r = 2 + k * 0.8;
    px = Math.cos(a) * r; pz = Math.sin(a) * r;
  }
  const EYE = 1.7;
  const st = { x: px, z: pz, feet: model.terrainH(px, pz), vy: 0, yaw: 0, pitch: 0, fly: false, onGround: true };
  const keys = new Set();
  const joy = { x: 0, y: 0 };

  const groundAt = (x, z, feet) => {
    const t = model.terrainH(x, z);
    const b = model.buildingAt(x, z);
    return b && feet >= b.top - 0.7 ? Math.max(t, b.top) : t;
  };
  const blocked = (x, z, feet) => {
    const b = model.buildingAt(x, z);
    return !!b && feet < b.top - 0.7 && feet + EYE > b.bottom;
  };

  // input
  const onKey = (e, down) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const k = e.code;
    if (down && k === 'KeyF') { toggleFly(); return; }
    if (down && k === 'Escape' && !document.pointerLockElement) { close(); return; }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyQ', 'KeyE'].includes(k)) {
      e.preventDefault();
      if (down) keys.add(k); else keys.delete(k);
    }
  };
  const kd = (e) => onKey(e, true), ku = (e) => onKey(e, false);
  window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);

  const look = (dx, dy, k) => {
    st.yaw -= dx * k; st.pitch = clamp(st.pitch - dy * k, -1.5, 1.5);
  };
  const canvas = renderer.domElement;
  let dragging = null;
  const onMouseMove = (e) => {
    if (document.pointerLockElement === canvas) look(e.movementX, e.movementY, 0.0022);
  };
  document.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('pointerdown', (e) => {
    $('w-help').hidden = true;
    if (e.pointerType === 'mouse' && canvas.requestPointerLock) {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
    if (document.pointerLockElement !== canvas) { dragging = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id || document.pointerLockElement === canvas) return;
    look(e.clientX - dragging.x, e.clientY - dragging.y, e.pointerType === 'mouse' ? 0.004 : 0.006);
    dragging.x = e.clientX; dragging.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  const onLock = () => { $('w-help').hidden = document.pointerLockElement === canvas; };
  document.addEventListener('pointerlockchange', onLock);

  // touch joystick (shown on touch devices)
  const touch = matchMedia('(pointer: coarse)').matches;
  const joyEl = $('w-joy'), jumpEl = $('w-jump');
  joyEl.hidden = !touch; jumpEl.hidden = !touch;
  let joyId = null;
  const joyMove = (e) => {
    const r = joyEl.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    joy.x = dx; joy.y = dy;
    joyEl.firstElementChild.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
  };
  joyEl.onpointerdown = (e) => { joyId = e.pointerId; joyEl.setPointerCapture(e.pointerId); joyMove(e); };
  joyEl.onpointermove = (e) => { if (e.pointerId === joyId) joyMove(e); };
  joyEl.onpointerup = joyEl.onpointercancel = () => { joyId = null; joy.x = joy.y = 0; joyEl.firstElementChild.style.transform = ''; };
  jumpEl.onpointerdown = () => { if (st.fly) keys.add('Space'); else if (st.onGround) { st.vy = 7; st.onGround = false; } };
  jumpEl.onpointerup = () => keys.delete('Space');

  function toggleFly() {
    st.fly = !st.fly;
    st.vy = 0;
    $('w-fly').classList.toggle('on', st.fly);
    $('w-fly').textContent = st.fly ? 'Walk' : 'Fly';
    if (st.fly && st.feet < groundAt(st.x, st.z, st.feet) + 3) st.feet += 3;
  }
  $('w-fly').onclick = toggleFly;
  $('w-dl').onclick = () => exportGLB(model, opts, $('w-dl'));
  $('w-dl').disabled = false;
  $('w-load').hidden = true;
  $('w-help').hidden = false;

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  const half = { x: model.W / 2 - 1, z: model.H / 2 - 1 };
  const fwd = new THREE.Vector3();
  function update(dt) {
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - joy.y;
    let r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + joy.x;
    const m = Math.hypot(f, r); if (m > 1) { f /= m; r /= m; }
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    if (st.fly) {
      const speed = (run ? 90 : 25) * dt;
      camera.getWorldDirection(fwd);
      st.x += (fwd.x * f + cy * r) * speed;
      st.z += (fwd.z * f - sy * r) * speed;
      st.feet += fwd.y * f * speed + ((keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyC') || keys.has('KeyQ') ? 1 : 0)) * speed;
      st.x = clamp(st.x, -half.x, half.x); st.z = clamp(st.z, -half.z, half.z);
      st.feet = Math.max(st.feet, groundAt(st.x, st.z, st.feet) + 0.5);
    } else {
      const speed = (run ? 12 : 4.5) * dt;
      const mx = (-sy * f + cy * r) * speed, mz = (-cy * f - sy * r) * speed;
      const nx = clamp(st.x + mx, -half.x, half.x), nz = clamp(st.z + mz, -half.z, half.z);
      // slide along walls: try both axes, then each one alone
      if (!blocked(nx, nz, st.feet)) { st.x = nx; st.z = nz; }
      else if (!blocked(nx, st.z, st.feet)) st.x = nx;
      else if (!blocked(st.x, nz, st.feet)) st.z = nz;
      if (keys.has('Space') && st.onGround) { st.vy = 7; st.onGround = false; }
      st.vy -= 22 * dt;
      st.feet += st.vy * dt;
      const g = groundAt(st.x, st.z, st.feet);
      // walk up gentle steps and slopes, fall off edges
      if (st.feet <= g || (st.onGround && st.feet - g < 0.45 && st.vy <= 0)) { st.feet = g; st.vy = 0; st.onGround = true; }
      else st.onGround = false;
    }
    camera.position.set(st.x, st.feet + EYE, st.z);
    camera.rotation.set(st.pitch, st.yaw, 0);
  }
  function frame() {
    if (s.closed) return;
    update(Math.min(clock.getDelta(), 0.05));
    renderer.render(scene, camera);
    s.raf = requestAnimationFrame(frame);
  }
  frame();

  s.cleanup = () => {
    cancelAnimationFrame(s.raf);
    window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onLock);
    if (document.pointerLockElement) document.exitPointerLock();
    scene.remove(model.group);   // keep the cached model's geometry for a quick re-open
    renderer.dispose();
    renderer.domElement.remove();
  };
  s.debug = { st, camera, renderer, scene, model };
}

async function exportGLB(model, opts, btn) {
  const { GLTFExporter } = await loadLibs();
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing file…';
  try {
    const data = await new GLTFExporter().parseAsync(model.group, { binary: true, maxTextureSize: 4096 });
    const blob = new Blob([data], { type: 'model/gltf-binary' });
    const name = (opts.name || 'area').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'area';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-3d.glb`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    btn.textContent = `Saved (${(blob.size / 1048576).toFixed(1)} MB)`;
    setTimeout(() => { btn.textContent = label; }, 4000);
  } catch (err) {
    console.error(err);
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = label; }, 4000);
  } finally {
    btn.disabled = false;
  }
}

function close() {
  if (!session) return;
  session.closed = true;
  if (session.cleanup) session.cleanup();
  session = null;
  if (ui) ui.hidden = true;
  document.body.classList.remove('walking');
}

window.Walk3D = { open, close, get session() { return session; }, buildModel };
