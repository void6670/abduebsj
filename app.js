/* Places → 3D: app logic. Needs maplibre-gl (global) and parse.js (PlaceParser). */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const P = window.PlaceParser;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const STORE_KEY = 'places3d.places';
  const KEY_KEY = 'places3d.googleKey';
  const CESIUM_VER = '1.123.0';

  const state = {
    places: [],
    selected: null,
    mode: 'free',     // 'free' | 'photo'
    style: 'realistic', // 'realistic' | 'streets'
    buildings: true,
    terrain: true,
    exag: 1.5,
    orbit: false,
    tool: null,       // null | 'pick' | 'area'
  };
  let nextId = 1;

  // ------------------------------------------------------------------ status
  let statusTimer = null;
  function status(msg, kind) {
    const el = $('#status');
    el.textContent = msg || '';
    el.className = kind || '';
    clearTimeout(statusTimer);
    if (msg && kind === 'ok') statusTimer = setTimeout(() => status(''), 5000);
  }

  // ------------------------------------------------------------- geocoding
  // OpenStreetMap Nominatim: free, but limited to 1 request per second.
  const geoCache = new Map();
  let lastGeo = 0;
  async function nominatim(q) {
    const wait = lastGeo + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeo = Date.now();
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (!r.ok) throw new Error('Geocoder HTTP ' + r.status);
    const j = await r.json();
    return j[0] ? { lat: +j[0].lat, lng: +j[0].lon, display: j[0].display_name } : null;
  }
  async function geocode(q) {
    if (geoCache.has(q)) return geoCache.get(q);
    let res = await nominatim(q);
    // "Business name, street, city": if the full string fails, retry without the name, then the name alone.
    if (!res && q.includes(',')) {
      const parts = q.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) res = await nominatim(parts.slice(1).join(', '));
      if (!res) res = await nominatim(parts[0]);
    }
    geoCache.set(q, res);
    return res;
  }

  // ------------------------------------------------------------ places
  function label(p) {
    return p.name || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  }

  async function addSpecs(specs, { fly = true } = {}) {
    if (!specs.length) { status('Nothing recognisable found.', 'error'); return; }
    const added = [];
    const problems = [];
    const needGeo = specs.filter((s) => !s.error && s.lat === undefined).length;
    let done = 0;
    for (const s of specs) {
      if (s.error === 'short') { problems.push('Short links (maps.app.goo.gl) can\'t be read in the browser. Open the link, then copy the full URL from the address bar.'); continue; }
      if (s.error) { problems.push('Not understood: ' + s.raw.slice(0, 60)); continue; }
      let { lat, lng, name } = s;
      if (lat === undefined) {
        status(`Finding “${s.query}”… (${++done}/${needGeo})`);
        try {
          const g = await geocode(s.query);
          if (!g) { problems.push(`Couldn't find “${s.query}”`); continue; }
          lat = g.lat; lng = g.lng;
          if (!name) name = g.display.split(',')[0];
        } catch (e) {
          problems.push(`Geocoding failed for “${s.query}” (${e.message})`); continue;
        }
      }
      const p = { id: nextId++, name: name || null, address: s.address || null, lat, lng, camera: s.camera || {}, bbox: s.bbox || null };
      state.places.push(p);
      added.push(p);
    }
    save();
    renderList();
    syncMarkers();
    if (problems.length) status(problems.slice(0, 3).join(' · ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ''), 'error');
    else status(`Added ${added.length} place${added.length === 1 ? '' : 's'}.`, 'ok');
    if (fly && added.length === 1) select(added[0].id);
    else if (fly && added.length > 1) fitAll();
    return added;
  }

  function removePlace(id) {
    state.places = state.places.filter((p) => p.id !== id);
    if (state.selected === id) state.selected = null;
    save(); renderList(); syncMarkers();
  }

  function select(id, { fly = true } = {}) {
    state.selected = id;
    renderList();
    updateMarkerSelection();
    updateAreas();
    if (viewer) syncEntities();
    const p = state.places.find((x) => x.id === id);
    if (p && fly) flyTo(p);
  }

  function renderList() {
    const ul = $('#places');
    ul.innerHTML = '';
    state.places.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = p.id === state.selected ? 'sel' : '';
      const sub = p.bbox ? `Area · ${areaSize(p.bbox)}` : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      li.innerHTML = `<span class="num${p.bbox ? ' area' : ''}">${i + 1}</span><span class="txt"><div class="name"></div><div class="coord">${sub}</div></span><button class="del" title="Remove">✕</button>`;
      li.querySelector('.name').textContent = label(p);
      li.title = p.address || label(p);
      li.addEventListener('click', () => select(p.id));
      li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removePlace(p.id); });
      ul.appendChild(li);
    });
    $('#count').textContent = state.places.length ? `(${state.places.length})` : '';
  }

  // ----------------------------------------------------- persistence/share
  function compact() {
    return state.places.map((p) => {
      const c = p.camera || {};
      const cam = ['zoom', 'range', 'heading', 'tilt'].map((k) => (c[k] == null ? null : c[k]));
      const row = [p.name || '', +p.lat.toFixed(6), +p.lng.toFixed(6), cam.some((v) => v != null) ? cam : null];
      if (p.bbox) row.push(p.bbox.map((v) => +v.toFixed(6)));
      else if (!row[3]) row.pop();
      return row;
    });
  }
  function expand(arr) {
    return arr.map(([name, lat, lng, cam, bbox]) => {
      const camera = {};
      if (cam) ['zoom', 'range', 'heading', 'tilt'].forEach((k, i) => { if (cam[i] != null) camera[k] = cam[i]; });
      return { name: name || null, lat, lng, camera, bbox: Array.isArray(bbox) && bbox.length === 4 ? bbox : null };
    }).filter((s) => P.isValid(s.lat, s.lng));
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(compact())); } catch (e) { /* private mode */ }
  }
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  function shareLink() {
    const url = new URL(location.href);
    url.hash = 'p=' + b64urlEncode(JSON.stringify(compact()));
    return url.toString();
  }
  function loadInitial() {
    const m = /[#&]p=([\w-]+)/.exec(location.hash);
    if (m) {
      try { return expand(JSON.parse(b64urlDecode(m[1]))); } catch (e) { console.warn('bad share link', e); }
    }
    try { return expand(JSON.parse(localStorage.getItem(STORE_KEY) || '[]')); } catch (e) { return []; }
  }

  // ======================================================= Free 3D (MapLibre)
  const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
  const DEM_ATTR = 'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Mapzen / AWS Terrain Tiles</a>';

  const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const OFM_SPRITE = 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm';
  const STREETS_URL = 'https://tiles.openfreemap.org/styles/liberty';
  // The street style is also the source of label layers for the realistic view.
  const libertyP = fetch(STREETS_URL).then((r) => r.json()).catch(() => null);

  // Realistic: satellite imagery draped on 3D terrain, with labels and textured buildings added on style load.
  function realisticStyle() {
    return {
      version: 8,
      glyphs: OFM_GLYPHS,
      sprite: OFM_SPRITE,
      sources: {
        sat: {
          type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
        openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#1b2a1f' } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': 0.12, 'raster-contrast': 0.08 } },
        { id: 'p3d-roads', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 11,
          filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], 'rgba(255,214,120,0.7)', 'rgba(255,248,225,0.45)'],
            'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 0.6, 15, 2.2, 18, 6],
          } },
      ],
    };
  }

  const map = new maplibregl.Map({
    container: 'map',
    style: realisticStyle(),
    center: [10, 30],
    zoom: 1.6,
    pitch: 0,
    maxPitch: 85,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  function firstSymbolLayer() {
    const l = map.getStyle().layers.find((x) => x.type === 'symbol');
    return l && l.id;
  }

  // ---- procedural facade textures (walls with windows), generated once on a canvas
  const FACADES = {
    'fac-brick':    { wall: [150, 78, 58],   win: [42, 52, 62],  frame: [225, 214, 196], noise: 26, mortar: true },
    'fac-stone':    { wall: [201, 186, 158], win: [48, 58, 70],  frame: [236, 228, 210], noise: 16 },
    'fac-plaster':  { wall: [226, 220, 205], win: [56, 70, 84],  frame: [250, 248, 240], noise: 10 },
    'fac-concrete': { wall: [150, 152, 150], win: [38, 48, 58],  frame: [120, 122, 122], noise: 14 },
    'fac-sand':     { wall: [214, 176, 128], win: [52, 60, 70],  frame: [240, 226, 200], noise: 18 },
    'fac-glass':    { glass: true },
  };
  const ROOFS = { 'fac-brick': '#8e4b3b', 'fac-stone': '#77706a', 'fac-plaster': '#a59c8e', 'fac-concrete': '#6a6d70', 'fac-sand': '#9a7e62', 'fac-glass': '#59646d' };
  const facadeCache = {};
  function facadeImage(name) {
    if (facadeCache[name]) return facadeCache[name];
    const f = FACADES[name];
    const N = 32;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    let seed = name.length * 977;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const rgb = (a, d = 0) => `rgb(${a.map((v) => clamp(Math.round(v + d), 0, 255)).join(',')})`;
    if (f.glass) {
      const grad = g.createLinearGradient(0, 0, N, N);
      grad.addColorStop(0, '#7fa6bd'); grad.addColorStop(0.5, '#4b6f86'); grad.addColorStop(1, '#2f4b5e');
      g.fillStyle = grad; g.fillRect(0, 0, N, N);
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 0, N, 5);
      g.fillStyle = '#26343f';
      for (let i = 0; i < N; i += 8) { g.fillRect(i, 0, 1, N); g.fillRect(0, i, N, 2); }
    } else {
      g.fillStyle = rgb(f.wall); g.fillRect(0, 0, N, N);
      for (let i = 0; i < 260; i++) {            // surface grain
        g.fillStyle = rgb(f.wall, (rnd() - 0.5) * f.noise * 2);
        g.fillRect(Math.floor(rnd() * N), Math.floor(rnd() * N), 1, 1);
      }
      if (f.mortar) {
        g.fillStyle = 'rgba(230,215,200,0.35)';
        for (let y = 2; y < N; y += 4) g.fillRect(0, y, N, 1);
      }
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, 29, N, 2);      // floor ledge shadow
      g.fillStyle = rgb(f.frame); g.fillRect(8, 6, 16, 18);            // window frame
      g.fillStyle = rgb(f.win); g.fillRect(9, 7, 14, 16);              // glass
      g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(9, 7, 14, 5); // sky reflection
      g.fillStyle = rgb(f.frame); g.fillRect(15, 7, 2, 16);            // mullion
    }
    const d = g.getImageData(0, 0, N, N);
    facadeCache[name] = { width: N, height: N, data: new Uint8Array(d.data.buffer), canvas: c };
    return facadeCache[name];
  }

  const H = ['coalesce', ['get', 'render_height'], 8];
  // Pseudo-random but stable material per building, from its height and id.
  // OpenFreeMap building ids are multiples of 10, so divide first or every building lands on the same material.
  const MAT = ['%', ['+', ['floor', ['/', ['to-number', ['coalesce', ['id'], 0]], 10]], ['floor', H]], 5];
  const TALL = ['>=', H, 45];

  function addBuildings() {
    if (map.getLayer('building-3d')) map.removeLayer('building-3d');   // Liberty's plain grey blocks
    if (map.getLayer('p3d-bwalls')) return;
    for (const name of Object.keys(FACADES)) if (!map.hasImage(name)) map.addImage(name, facadeImage(name), { pixelRatio: 4 });
    const filter = ['!', ['has', 'hide_3d']];
    const before = firstSymbolLayer();
    map.addLayer({
      id: 'p3d-bwalls', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, filter,
      paint: {
        'fill-extrusion-pattern': ['case', TALL, 'fac-glass',
          ['match', MAT, 0, 'fac-brick', 1, 'fac-stone', 2, 'fac-plaster', 3, 'fac-concrete', 'fac-sand']],
        'fill-extrusion-height': H,
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 1,
      },
    }, before);
    // A thin coloured cap on top so roofs look like roofs, not more windows.
    map.addLayer({
      id: 'p3d-broofs', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14, filter,
      paint: {
        'fill-extrusion-color': ['case', TALL, ROOFS['fac-glass'],
          ['match', MAT, 0, ROOFS['fac-brick'], 1, ROOFS['fac-stone'], 2, ROOFS['fac-plaster'], 3, ROOFS['fac-concrete'], ROOFS['fac-sand']]],
        'fill-extrusion-height': ['+', H, 0.8],
        'fill-extrusion-base': H,
        'fill-extrusion-opacity': 1,
      },
    }, before);
  }

  async function addLabels() {
    const lib = await libertyP;
    if (!lib || state.style !== 'realistic' || !map.getSource('openmaptiles')) return;
    for (const l of lib.layers) {
      if (l.type !== 'symbol' || l.source !== 'openmaptiles' || /one_way|shield/.test(l.id) || map.getLayer(l.id)) continue;
      const layer = JSON.parse(JSON.stringify(l));
      if (layer.layout && layer.layout['text-field'] && !/shield/.test(l.id)) {
        // White text with a dark halo reads well on top of imagery.
        layer.paint = Object.assign({}, layer.paint, { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.8)', 'text-halo-width': 1.4 });
      }
      try { map.addLayer(layer); } catch (e) { /* skip layers this style can't host */ }
    }
  }

  function decorateStyle() {
    // Terrain (separate sources for 3D mesh and hillshade, as MapLibre recommends)
    if (!map.getSource('dem')) map.addSource('dem', { type: 'raster-dem', tiles: DEM_TILES, encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: DEM_ATTR });
    if (!map.getSource('dem-hs')) map.addSource('dem-hs', { type: 'raster-dem', tiles: DEM_TILES, encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
    if (!map.getLayer('p3d-hillshade')) {
      const realistic = state.style === 'realistic';
      map.addLayer({ id: 'p3d-hillshade', type: 'hillshade', source: 'dem-hs',
        paint: realistic
          ? { 'hillshade-exaggeration': 0.28, 'hillshade-shadow-color': '#0d1410', 'hillshade-highlight-color': '#fff6e0', 'hillshade-accent-color': '#1d2a20' }
          : { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5a5146' },
      }, realistic ? 'p3d-roads' : firstSymbolLayer());
    }
    addBuildings();
    map.setLight({ anchor: 'map', position: [1.5, 210, 35], color: '#fff8ec', intensity: 0.45 });
    map.setSky({
      'sky-color': '#7fb2ec', 'horizon-color': '#dfe9f5', 'fog-color': '#e6edf5',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0],
    });
    addAreaLayers();
    applyBuildings();
    applyTerrain();
    if (state.style === 'realistic') addLabels();
  }

  function applyBuildings() {
    for (const id of ['p3d-bwalls', 'p3d-broofs']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.buildings ? 'visible' : 'none');
    }
  }
  function applyTerrain() {
    if (!map.getSource('dem')) return;
    map.setTerrain(state.terrain ? { source: 'dem', exaggeration: state.exag } : null);
  }

  function setStyle(style) {
    state.style = style;
    map.setStyle(style === 'realistic' ? realisticStyle() : STREETS_URL, { diff: false });
  }
  map.on('style.load', decorateStyle);
  map.on('error', (e) => console.warn('map error', e && e.error));

  // markers
  const markers = new Map(); // id -> maplibregl.Marker
  function makePinEl(p, i) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.innerHTML = '<div class="label"></div><div class="stem"></div><div class="dot"></div>';
    el.querySelector('.label').textContent = `${i + 1}. ${label(p)}`;
    el.addEventListener('click', (e) => { e.stopPropagation(); select(p.id); });
    return el;
  }
  function syncMarkers() {
    for (const m of markers.values()) m.remove();
    markers.clear();
    state.places.forEach((p, i) => {
      const m = new maplibregl.Marker({ element: makePinEl(p, i), anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
      markers.set(p.id, m);
    });
    updateMarkerSelection();
    updateAreas();
    if (viewer) syncEntities();
  }
  function updateMarkerSelection() {
    for (const [id, m] of markers) m.getElement().classList.toggle('sel', id === state.selected);
  }

  function zoomForRange(range, lat) {
    const h = map.getContainer().clientHeight || 800;
    return clamp(Math.log2((78271.517 * Math.cos(lat * Math.PI / 180) * h) / range), 2, 20);
  }

  function freeFly(p) {
    if (p.bbox) {
      const [w, s, e, n] = p.bbox;
      const pad = Math.round(Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight) * 0.12);
      const cam = map.cameraForBounds([[w, s], [e, n]], { padding: pad, bearing: map.getBearing() + 25, pitch: 58 });
      map.flyTo(Object.assign({}, cam || { center: [p.lng, p.lat], zoom: 15 }, { pitch: 58, bearing: map.getBearing() + 25, duration: 3000, essential: true }));
      return new Promise((r) => map.once('moveend', r));
    }
    const c = p.camera || {};
    let zoom = 16.6;
    if (c.range) zoom = zoomForRange(c.range * 1.4, p.lat);
    else if (c.zoom != null) zoom = clamp(c.zoom - 0.6, 3, 19);
    map.flyTo({
      center: [p.lng, p.lat],
      zoom,
      pitch: c.tilt != null ? clamp(c.tilt, 0, 80) : 62,
      bearing: c.heading != null ? c.heading : map.getBearing() + 30,
      duration: 3500,
      essential: true,
    });
    return new Promise((r) => map.once('moveend', r));
  }

  function freeFitAll() {
    if (!state.places.length) return;
    if (state.places.length === 1) return freeFly(state.places[0]);
    const b = new maplibregl.LngLatBounds();
    state.places.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: 90, pitch: 50, maxZoom: 16, duration: 2500 });
  }

  // ================================================ Photorealistic (Cesium)
  let viewer = null;
  let cesiumLoad = null;

  function loadCesium() {
    if (window.Cesium) return Promise.resolve();
    if (cesiumLoad) return cesiumLoad;
    const base = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VER}/Build/Cesium/`;
    window.CESIUM_BASE_URL = base;
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = base + 'Widgets/widgets.css';
    document.head.appendChild(css);
    cesiumLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'Cesium.js';
      s.onload = resolve;
      s.onerror = () => { cesiumLoad = null; reject(new Error('Could not load CesiumJS')); };
      document.head.appendChild(s);
    });
    return cesiumLoad;
  }

  async function startPhoto() {
    const key = $('#apiKey').value.trim();
    if (!key) { status('Enter a Google Maps Platform API key first.', 'error'); $('#apiKey').focus(); return false; }
    try { localStorage.setItem(KEY_KEY, key); } catch (e) { /* ignore */ }
    if (viewer) return true;
    status('Loading photorealistic 3D…');
    $('#loadPhoto').disabled = true;
    try {
      await loadCesium();
      const C = window.Cesium;
      C.GoogleMaps.defaultApiKey = key;
      viewer = new C.Viewer('globe', {
        globe: false, baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, animation: false, timeline: false,
        fullscreenButton: false, infoBox: false, selectionIndicator: false,
      });
      viewer.scene.skyAtmosphere.show = true;
      const tileset = await C.createGooglePhotorealistic3DTileset();
      viewer.scene.primitives.add(tileset);
      let warned = false;
      tileset.tileFailed.addEventListener(() => {
        if (!warned) { warned = true; status('Some 3D tiles failed to load. Check that the Map Tiles API is enabled for your key.', 'error'); }
      });
      viewer.screenSpaceEventHandler.setInputAction((ev) => {
        if (state.tool === 'pick') {
          const pos = viewer.scene.pickPosition(ev.position);
          if (pos) {
            const carto = C.Cartographic.fromCartesian(pos);
            pickAt(C.Math.toDegrees(carto.latitude), C.Math.toDegrees(carto.longitude), carto.height);
          } else status('Nothing to pick there. Click on the 3D surface.', 'error');
          return;
        }
        const picked = viewer.scene.pick(ev.position);
        const id = picked && picked.id && picked.id.placeId;
        if (id) select(id);
      }, C.ScreenSpaceEventType.LEFT_CLICK);
      viewer.clock.onTick.addEventListener(photoOrbitTick);
      syncEntities();
      status('Photorealistic 3D loaded.', 'ok');
      return true;
    } catch (e) {
      console.error(e);
      if (viewer) { viewer.destroy(); viewer = null; }
      status('Photorealistic 3D failed: ' + (e.message || e) + '. Check the API key and that the Map Tiles API is enabled.', 'error');
      return false;
    } finally {
      $('#loadPhoto').disabled = false;
    }
  }

  function syncEntities() {
    if (!viewer) return;
    const C = window.Cesium;
    viewer.entities.removeAll();
    state.places.forEach((p, i) => {
      const sel = p.id === state.selected;
      const e = viewer.entities.add({
        position: C.Cartesian3.fromDegrees(p.lng, p.lat, p.ground != null ? p.ground : (p.elev || 0)),
        point: {
          pixelSize: sel ? 16 : 13,
          color: C.Color.fromCssColorString(sel ? '#4f8cff' : '#ff4d4f'),
          outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${i + 1}. ${label(p)}`,
          font: '600 14px system-ui, sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString(sel ? 'rgba(79,140,255,0.92)' : 'rgba(18,20,26,0.85)'),
          backgroundPadding: new C.Cartesian2(8, 5),
          pixelOffset: new C.Cartesian2(0, -26),
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      e.placeId = p.id;
      if (p.bbox) {
        const rect = C.Rectangle.fromDegrees(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);
        const ring = [[0, 1], [2, 1], [2, 3], [0, 3], [0, 1]].flatMap(([a, b]) => [p.bbox[a], p.bbox[b]]);
        viewer.entities.add({
          rectangle: { coordinates: rect, material: C.Color.fromCssColorString(sel ? '#4f8cff' : '#ffd166').withAlpha(sel ? 0.18 : 0.12), classificationType: C.ClassificationType.BOTH },
        });
        viewer.entities.add({
          polyline: { positions: C.Cartesian3.fromDegreesArray(ring), width: 3, clampToGround: true, classificationType: C.ClassificationType.BOTH,
            material: C.Color.fromCssColorString(sel ? '#4f8cff' : '#ffd166') },
        });
      }
    });
  }

  async function elevation(p) {
    if (p.elev != null) return p.elev;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lng}`);
      const j = await r.json();
      p.elev = (j.elevation && j.elevation[0]) || 0;
    } catch (e) { p.elev = 0; }
    return p.elev;
  }

  function photoRange(p) {
    const c = p.camera || {};
    if (c.range) return clamp(c.range, 80, 50000);
    if (c.zoom != null) return clamp(156543 * Math.cos(p.lat * Math.PI / 180) / Math.pow(2, c.zoom) * 700, 150, 50000);
    return 550;
  }

  async function photoFly(p) {
    const C = window.Cesium;
    const c = p.camera || {};
    // Open-Meteo gives height above sea level, while the 3D tiles use ellipsoid height.
    // That is close enough for the first flight; the real surface height is sampled afterwards.
    const h = p.ground != null ? p.ground : await elevation(p);
    const tilt = p.bbox ? 45 : c.tilt != null ? clamp(c.tilt, 0, 80) : 50;
    const range = p.bbox ? clamp(areaMeters(p.bbox).diag * 1.15, 200, 200000) : photoRange(p);
    const hpr = new C.HeadingPitchRange(p.bbox ? viewer.camera.heading : C.Math.toRadians(c.heading || 0), C.Math.toRadians(tilt - 90), range);
    const fly = (height, duration) => new Promise((resolve) => {
      viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(p.lng, p.lat, height), 40), {
        offset: hpr, duration, complete: resolve, cancel: resolve,
      });
    });
    await fly(h, 3);
    if (p.ground == null) {
      try {
        const [carto] = await viewer.scene.sampleHeightMostDetailed([C.Cartographic.fromDegrees(p.lng, p.lat)]);
        if (carto && Number.isFinite(carto.height)) {
          p.ground = carto.height;
          syncEntities();
          if (Math.abs(carto.height - h) > 15 && state.selected === p.id) await fly(carto.height, 1);
        }
      } catch (e) { /* sampling not supported: keep approximate height */ }
    }
  }

  function photoFitAll() {
    const C = window.Cesium;
    if (!state.places.length) return;
    if (state.places.length === 1) return photoFly(state.places[0]);
    const pts = state.places.map((p) => C.Cartesian3.fromDegrees(p.lng, p.lat, p.ground || p.elev || 0));
    const sphere = C.BoundingSphere.fromPoints(pts);
    viewer.camera.flyToBoundingSphere(sphere, { offset: new C.HeadingPitchRange(0, C.Math.toRadians(-45), Math.max(sphere.radius * 2.6, 800)), duration: 2.5 });
  }

  // orbit (Cesium)
  let photoOrbit = null;
  function photoOrbitTick() {
    if (!viewer) return;
    const C = window.Cesium;
    const want = state.orbit && state.mode === 'photo' && state.selected != null;
    if (!want) {
      if (photoOrbit) { viewer.camera.lookAtTransform(C.Matrix4.IDENTITY); photoOrbit = null; }
      return;
    }
    const p = state.places.find((x) => x.id === state.selected);
    if (!p) return;
    if (!photoOrbit || photoOrbit.id !== p.id) {
      const target = C.Cartesian3.fromDegrees(p.lng, p.lat, p.ground != null ? p.ground : (p.elev || 0));
      const range = C.Cartesian3.distance(viewer.camera.positionWC, target);
      photoOrbit = { id: p.id, target, heading: viewer.camera.heading, pitch: Math.min(viewer.camera.pitch, -0.2), range: clamp(range, 120, 20000) };
    }
    photoOrbit.heading += 0.0025;
    viewer.camera.lookAt(photoOrbit.target, new C.HeadingPitchRange(photoOrbit.heading, photoOrbit.pitch, photoOrbit.range));
  }

  // orbit (MapLibre)
  let lastFrame = 0;
  function freeOrbitLoop(t) {
    const dt = lastFrame ? t - lastFrame : 16;
    lastFrame = t;
    if (state.orbit && state.mode === 'free' && !map.isMoving() && !userInteracting) {
      map.setBearing((map.getBearing() + dt * 0.006) % 360);
    }
    requestAnimationFrame(freeOrbitLoop);
  }
  let userInteracting = false;
  map.getCanvasContainer().addEventListener('pointerdown', () => { userInteracting = true; });
  window.addEventListener('pointerup', () => { userInteracting = false; });
  requestAnimationFrame(freeOrbitLoop);

  // ======================================================= areas & tools
  function areaMeters([w, s, e, n]) {
    const lat = (s + n) / 2;
    const wM = (e - w) * 111320 * Math.cos(lat * Math.PI / 180);
    const hM = (n - s) * 110574;
    return { w: wM, h: hM, diag: Math.hypot(wM, hM) };
  }
  function fmtLen(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m'; }
  function areaSize(b) { const a = areaMeters(b); return `${fmtLen(a.w)} × ${fmtLen(a.h)}`; }
  function ringOf([w, s, e, n]) { return [[w, s], [e, s], [e, n], [w, n], [w, s]]; }
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  function addAreaLayers() {
    if (map.getSource('p3d-areas')) return;
    map.addSource('p3d-areas', { type: 'geojson', data: EMPTY_FC });
    map.addSource('p3d-mask', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({ id: 'p3d-mask', type: 'fill', source: 'p3d-mask', paint: { 'fill-color': '#0b0d12', 'fill-opacity': 0.5 } });
    map.addLayer({ id: 'p3d-area-fill', type: 'fill', source: 'p3d-areas',
      paint: { 'fill-color': ['case', ['get', 'sel'], '#4f8cff', '#ffd166'], 'fill-opacity': ['case', ['get', 'sel'], 0.06, 0.14] } });
    map.addLayer({ id: 'p3d-area-line', type: 'line', source: 'p3d-areas', layout: { 'line-join': 'round' },
      paint: { 'line-color': ['case', ['get', 'sel'], '#4f8cff', '#ffd166'], 'line-width': 3 } });
    // A thin glowing wall around each square, so its edge stays visible between 3D buildings.
    map.addSource('p3d-walls', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({ id: 'p3d-area-wall', type: 'fill-extrusion', source: 'p3d-walls',
      paint: { 'fill-extrusion-color': ['case', ['get', 'sel'], '#4f8cff', '#ffd166'], 'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.75 } });
    updateAreas();
  }

  function updateAreas() {
    const src = map.getSource('p3d-areas');
    const mask = map.getSource('p3d-mask');
    if (!src || !mask) return;
    const areas = state.places.filter((p) => p.bbox);
    src.setData({ type: 'FeatureCollection', features: areas.map((p) => ({
      type: 'Feature', properties: { sel: p.id === state.selected }, geometry: { type: 'Polygon', coordinates: [ringOf(p.bbox)] },
    })) });
    const walls = map.getSource('p3d-walls');
    if (walls) walls.setData({ type: 'FeatureCollection', features: areas.map((p) => {
      const [w, so, e, n] = p.bbox;
      const m = areaMeters(p.bbox);
      const t = clamp(m.diag * 0.004, 2, 60);                    // wall thickness in metres
      const dLat = t / 110574, dLng = t / (111320 * Math.cos(p.lat * Math.PI / 180));
      return { type: 'Feature', properties: { sel: p.id === state.selected, h: clamp(m.diag * 0.04, 25, 600) },
        geometry: { type: 'Polygon', coordinates: [ringOf([w - dLng, so - dLat, e + dLng, n + dLat]), ringOf(p.bbox).reverse()] } };
    }) });
    // Dim everything outside the selected area so the square stands out.
    const sel = areas.find((p) => p.id === state.selected);
    mask.setData(sel ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
      coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ringOf(sel.bbox).reverse()] } }] } : EMPTY_FC);
  }

  async function reverseName(lat, lng, zoom) {
    const wait = lastGeo + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeo = Date.now();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=${zoom}&lat=${lat}&lon=${lng}`,
        { headers: { 'Accept-Language': navigator.language || 'en' } });
      const j = await r.json();
      if (!j || j.error) return null;
      const a = j.address || {};
      const road = a.road ? (a.house_number ? `${a.house_number} ${a.road}` : a.road) : null;
      const name = (zoom >= 16 ? j.name || road : null) || a.neighbourhood || a.suburb || a.quarter || a.village || a.town || a.city || j.name || null;
      return { name, address: j.display_name };
    } catch (e) { return null; }
  }

  async function pickAt(lat, lng, height) {
    const p = { id: nextId++, name: null, address: null, lat, lng, camera: {}, bbox: null };
    if (height != null && Number.isFinite(height)) p.ground = height;
    state.places.push(p);
    save(); renderList(); syncMarkers();
    select(p.id, { fly: false });
    status('Pin added. Looking up its name…');
    const r = await reverseName(lat, lng, 18);
    if (r && r.name && state.places.includes(p)) { p.name = r.name; p.address = r.address; save(); renderList(); syncMarkers(); }
    status(`Added “${label(p)}”. Click again to add more, or press Esc to stop.`, 'ok');
  }

  async function addArea(bbox) {
    const p = { id: nextId++, name: `Area ${state.places.filter((x) => x.bbox).length + 1}`, address: null,
      lat: (bbox[1] + bbox[3]) / 2, lng: (bbox[0] + bbox[2]) / 2, camera: {}, bbox };
    state.places.push(p);
    save(); renderList(); syncMarkers();
    select(p.id);
    status(`Area selected (${areaSize(bbox)}).`, 'ok');
    const r = await reverseName(p.lat, p.lng, 14);
    if (r && r.name && state.places.includes(p)) { p.name = `${r.name} area`; p.address = r.address; save(); renderList(); syncMarkers(); }
    return p;
  }

  // ---- walk in 3D
  const WALK_MAX = 3000; // metres: bigger areas get too heavy to build in a browser
  function walkTarget() {
    const p = state.places.find((x) => x.id === state.selected);
    if (p && p.bbox) return { bbox: p.bbox.slice(), name: label(p), center: { lat: p.lat, lng: p.lng } };
    if (!p && map.getZoom() < 12) return null;
    const c = p ? { lat: p.lat, lng: p.lng } : map.getCenter();
    return { bbox: squareAround(c, 350), name: p ? label(p) : 'Map view', center: c };
  }
  function squareAround(c, half) {
    const dLat = half / 110574, dLng = half / (111320 * Math.cos(c.lat * Math.PI / 180));
    return [c.lng - dLng, c.lat - dLat, c.lng + dLng, c.lat + dLat];
  }
  function openWalk() {
    if (!window.Walk3D) { status('The 3D walker is still loading. Try again in a moment.', 'error'); return; }
    const t = walkTarget();
    if (!t) { status('Zoom in on the map, select a place, or select an area first. That is what gets turned into a 3D model.', 'error'); return; }
    const a = areaMeters(t.bbox);
    if (a.w > WALK_MAX || a.h > WALK_MAX) {
      const [w, s, e, n] = t.bbox;
      const half = WALK_MAX / 2;
      const c = { lng: (w + e) / 2, lat: (s + n) / 2 };
      const sq = squareAround(c, half);
      t.bbox = [Math.max(w, sq[0]), Math.max(s, sq[1]), Math.min(e, sq[2]), Math.min(n, sq[3])];
      status(`That area is big, so the 3D model uses the middle ${fmtLen(WALK_MAX)} × ${fmtLen(WALK_MAX)}.`, '');
    }
    if (state.tool) setTool(null);
    window.Walk3D.open({
      bbox: t.bbox,
      name: t.name,
      facadeCanvas: (name) => facadeImage(name).canvas,
      facades: ROOFS,
    });
  }

  function setTool(tool) {
    if (state.tool === tool) tool = null;
    if (tool === 'area' && state.mode === 'photo') {
      status('Selecting an area works in Free 3D. Switch to Free 3D, select it, then come back. The square shows up here too.', 'error');
      return;
    }
    cancelDrag();
    state.tool = tool;
    document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    document.body.classList.toggle('tool-pick', tool === 'pick');
    document.body.classList.toggle('tool-area', tool === 'area');
    if (tool === 'area') {
      map.dragPan.disable(); map.boxZoom.disable(); map.dragRotate.disable();
      // Look straight down so the box drawn on screen is a true square on the ground.
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
      status('Drag a box over the map to select an area. Hold Shift for an exact square. Press Esc to cancel.');
    } else {
      map.dragPan.enable(); map.boxZoom.enable(); map.dragRotate.enable();
      status(tool === 'pick' ? 'Click anywhere on the map to drop a pin. Press Esc to stop.' : '');
    }
  }

  map.on('click', (e) => {
    if (state.tool === 'pick' && state.mode === 'free') pickAt(e.lngLat.lat, e.lngLat.lng);
  });

  // drag-to-select an area
  const selbox = $('#selbox');
  const cont = map.getCanvasContainer();
  let drag = null;
  function dragRect(shift) {
    let dx = drag.x - drag.x0, dy = drag.y - drag.y0;
    if (shift) { const sz = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * sz; dy = Math.sign(dy || 1) * sz; }
    return [Math.min(drag.x0, drag.x0 + dx), Math.min(drag.y0, drag.y0 + dy), Math.max(drag.x0, drag.x0 + dx), Math.max(drag.y0, drag.y0 + dy)];
  }
  function rectToBbox([x0, y0, x1, y1]) {
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((pt) => map.unproject(pt));
    const lngs = pts.map((q) => q.lng), lats = pts.map((q) => q.lat);
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }
  function drawBox(shift) {
    const r = dragRect(shift);
    Object.assign(selbox.style, { left: r[0] + 'px', top: r[1] + 'px', width: (r[2] - r[0]) + 'px', height: (r[3] - r[1]) + 'px' });
    selbox.firstElementChild.textContent = r[2] - r[0] > 40 ? areaSize(rectToBbox(r)) : '';
  }
  function cancelDrag() { drag = null; selbox.hidden = true; }
  cont.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'area' || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const b = cont.getBoundingClientRect();
    drag = { x0: e.clientX - b.left, y0: e.clientY - b.top, x: e.clientX - b.left, y: e.clientY - b.top };
    try { cont.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    selbox.hidden = false;
    drawBox(e.shiftKey);
  }, true);
  cont.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const b = cont.getBoundingClientRect();
    drag.x = clamp(e.clientX - b.left, 0, b.width); drag.y = clamp(e.clientY - b.top, 0, b.height);
    drawBox(e.shiftKey);
  }, true);
  cont.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const r = dragRect(e.shiftKey);
    cancelDrag();
    if (r[2] - r[0] < 12 || r[3] - r[1] < 12) { status('That box was too small. Drag a bigger one.', 'error'); return; }
    const bbox = rectToBbox(r);
    setTool(null);
    addArea(bbox);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.tool) setTool(null);
  });

  // ================================================= mode-independent camera
  function flyTo(p) {
    stopOrbitDuringFlight();
    return state.mode === 'photo' && viewer ? photoFly(p) : freeFly(p);
  }
  function fitAll() {
    return state.mode === 'photo' && viewer ? photoFitAll() : freeFitAll();
  }
  function stopOrbitDuringFlight() {
    if (photoOrbit && viewer) { viewer.camera.lookAtTransform(window.Cesium.Matrix4.IDENTITY); photoOrbit = null; }
  }

  async function setMode(mode) {
    if (mode === 'photo') {
      if (state.tool === 'area') setTool(null);
      $('#photoOpts').hidden = false; $('#freeOpts').hidden = true;
      if (!viewer && !$('#apiKey').value.trim()) {
        markSeg('#modeSeg', 'mode', 'photo');
        status('Add your Google API key to load photorealistic 3D.', '');
        return;
      }
      const ok = await startPhoto();
      if (!ok) return;
      state.mode = 'photo';
      $('#map').hidden = true; $('#globe').hidden = false;
      const p = state.places.find((x) => x.id === state.selected);
      if (p) photoFly(p); else if (state.places.length) photoFitAll();
      else syncCameraToPhoto();
    } else {
      state.mode = 'free';
      $('#photoOpts').hidden = true; $('#freeOpts').hidden = false;
      $('#map').hidden = false; $('#globe').hidden = true;
      map.resize();
    }
    markSeg('#modeSeg', 'mode', mode);
  }

  function syncCameraToPhoto() {
    const C = window.Cesium;
    const c = map.getCenter();
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(c.lng, c.lat, Math.max(800, 40000000 / Math.pow(2, map.getZoom()))) });
  }

  function markSeg(sel, attr, val) {
    document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === val));
  }

  // =============================================================== tour
  let touring = false;
  async function tour() {
    if (touring) { touring = false; return; }
    if (!state.places.length) { status('Add some places first.', 'error'); return; }
    touring = true;
    $('#tourBtn').textContent = '■ Stop tour';
    const wasOrbit = state.orbit;
    try {
      for (let i = 0; touring; i = (i + 1) % state.places.length) {
        const p = state.places[i];
        state.orbit = false;
        state.selected = p.id; renderList(); updateMarkerSelection(); if (viewer) syncEntities();
        await flyTo(p);
        if (!touring) break;
        state.orbit = true;
        for (let t = 0; t < 70 && touring; t++) await sleep(100);
      }
    } finally {
      touring = false;
      state.orbit = wasOrbit;
      $('#orbit').checked = wasOrbit;
      $('#tourBtn').textContent = '▶ Tour';
    }
  }

  // ================================================================ files
  async function importFiles(files) {
    const specs = [];
    for (const f of files) {
      try {
        specs.push(...P.parseFile(f.name, await f.text()));
      } catch (e) {
        status(`Couldn't read ${f.name}: ${e.message}`, 'error');
        return;
      }
    }
    await addSpecs(specs);
  }

  // =============================================================== wiring
  const EXAMPLES = [
    'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2919064,17z/data=!3m1!4b1!4m6!3m5!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0!8m2!3d48.8583701!4d2.2944813',
    'Empire State Building https://www.google.com/maps/@40.7484405,-73.9856644,600a,900d,35y,200h,65t/data=!3m1!1e3',
    'Golden Gate Bridge https://www.google.com/maps?q=37.8199,-122.4783&z=15',
    "Matterhorn https://www.google.com/maps/place/45%C2%B058'35.0%22N+7%C2%B039'31.0%22E/@45.9763889,7.6586111,13z",
    'Sydney Opera House',
  ].join('\n');

  $('#addBtn').addEventListener('click', async () => {
    const text = $('#input').value;
    if (!text.trim()) { status('Paste a Google Maps link, coordinates or a place name.', 'error'); return; }
    $('#addBtn').disabled = true;
    try {
      const added = await addSpecs(P.parseText(text));
      if (added && added.length) $('#input').value = '';
    } finally { $('#addBtn').disabled = false; }
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#addBtn').click();
  });
  $('#exampleBtn').addEventListener('click', () => { $('#input').value = EXAMPLES; $('#addBtn').click(); });
  $('#fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });

  document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#walkBtn').addEventListener('click', openWalk);
  $('#tourBtn').addEventListener('click', tour);
  $('#clearBtn').addEventListener('click', () => {
    if (state.places.length && !confirm('Remove all places?')) return;
    state.places = []; state.selected = null; save(); renderList(); syncMarkers();
    history.replaceState(null, '', location.pathname + location.search);
  });
  $('#shareBtn').addEventListener('click', async () => {
    if (!state.places.length) { status('Add some places first.', 'error'); return; }
    const link = shareLink();
    history.replaceState(null, '', link);
    try { await navigator.clipboard.writeText(link); status('Share link copied to clipboard.', 'ok'); }
    catch (e) { status('Share link is now in the address bar.', 'ok'); }
  });

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#loadPhoto').addEventListener('click', () => setMode('photo'));
  $('#apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') setMode('photo'); });
  document.querySelectorAll('#styleSeg button').forEach((b) => b.addEventListener('click', () => {
    if (state.style === b.dataset.style) return;
    markSeg('#styleSeg', 'style', b.dataset.style);
    setStyle(b.dataset.style);
  }));
  $('#buildings').addEventListener('change', (e) => { state.buildings = e.target.checked; applyBuildings(); });
  $('#terrain').addEventListener('change', (e) => { state.terrain = e.target.checked; applyTerrain(); });
  $('#exag').addEventListener('input', (e) => {
    state.exag = +e.target.value;
    $('#exagOut').textContent = state.exag.toFixed(1) + '×';
    applyTerrain();
  });
  $('#orbit').addEventListener('change', (e) => {
    state.orbit = e.target.checked;
    if (state.orbit && state.selected == null && state.places.length) select(state.places[0].id);
  });
  $('#panelToggle').addEventListener('click', () => { document.body.classList.toggle('collapsed'); map.resize(); });

  // drag & drop
  const stage = $('#stage');
  let dragDepth = 0;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  stage.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
    else {
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (text) addSpecs(P.parseText(text));
    }
  });
  // pasting a Google Maps link anywhere (outside inputs) adds it right away
  document.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('textarea, input')) return;
    const text = e.clipboardData.getData('text');
    if (text && text.trim()) { e.preventDefault(); addSpecs(P.parseText(text)); }
  });

  // ================================================================ boot
  try { $('#apiKey').value = localStorage.getItem(KEY_KEY) || ''; } catch (e) { /* ignore */ }
  const initial = loadInitial();
  if (initial.length) {
    initial.forEach((s) => state.places.push({ id: nextId++, name: s.name, lat: s.lat, lng: s.lng, camera: s.camera, bbox: s.bbox }));
    renderList();
    syncMarkers();
    fitAll();
  } else {
    renderList();
  }

  // exposed for debugging / automation
  window.places3d = { state, map, openWalk, addText: (t) => addSpecs(P.parseText(t)), select, fitAll, setMode, setTool, addArea, pickAt };
})();
