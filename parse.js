/*
 * parse.js: turns Google Maps links, coordinates, place names and exported
 * place files into plain "place specs":
 *
 *   { name, address, lat, lng, camera: { zoom, range, heading, tilt }, query, error }
 *
 * A spec with lat/lng is ready to show. A spec with only `query` still needs geocoding.
 * Works in the browser (window.PlaceParser) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  function isValid(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  }

  function clean(s) {
    if (s == null) return '';
    let out = String(s).replace(/\+/g, ' ');
    try { out = decodeURIComponent(out); } catch (e) { /* keep as-is */ }
    return out.replace(/\s+/g, ' ').trim();
  }

  // ---------- coordinates in plain text ----------

  const DEC = /^\s*(?:loc:\s*)?\(?\s*([-+]?\d{1,2}(?:\.\d+)?)\s*(?:,|;|\s)\s*([-+]?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/;

  function parseDecimal(s) {
    const m = DEC.exec(s);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    return isValid(lat, lng) ? { lat, lng } : null;
  }

  const DMS_PART = '(\\d{1,3}(?:\\.\\d+)?)\\s*[°º]\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*[\'′’]\\s*)?(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|″|”|\'\')\\s*)?([NSEW])';
  const DMS = new RegExp('^\\s*' + DMS_PART + '[\\s,]*' + DMS_PART + '\\s*$', 'i');

  function dmsToDec(d, m, s, hemi) {
    const v = +d + (+m || 0) / 60 + (+s || 0) / 3600;
    return /[SW]/i.test(hemi) ? -v : v;
  }

  function parseDMS(s) {
    const m = DMS.exec(s);
    if (!m) return null;
    const a = dmsToDec(m[1], m[2], m[3], m[4]);
    const b = dmsToDec(m[5], m[6], m[7], m[8]);
    let lat, lng;
    if (/[NS]/i.test(m[4]) && /[EW]/i.test(m[8])) { lat = a; lng = b; }
    else if (/[EW]/i.test(m[4]) && /[NS]/i.test(m[8])) { lat = b; lng = a; }
    else return null;
    return isValid(lat, lng) ? { lat, lng } : null;
  }

  function parseCoords(s) {
    return parseDecimal(s) || parseDMS(s);
  }

  // ---------- Google Maps URLs ----------

  // "@48.85,2.29,17z" | "@40.7,-74.0,50a,1000d,35y,20h,60t" | "@lat,lng,500m" | street view "@lat,lng,3a,75y,90h,90t"
  function parseAt(seg) {
    const parts = seg.split(',');
    const lat = +parts[0], lng = +parts[1];
    if (!isValid(lat, lng)) return null;
    const raw = {};
    for (const p of parts.slice(2)) {
      const m = /^(-?[\d.]+)([a-z])$/i.exec(p);
      if (m) raw[m[2]] = +m[1];
    }
    const camera = {};
    if (raw.z != null) camera.zoom = raw.z;
    if (raw.m != null) camera.range = raw.m;
    if (raw.d != null) camera.range = raw.d;
    if (raw.h != null) camera.heading = raw.h;
    const streetView = raw.y != null && raw.d == null && raw.m == null;
    if (streetView) {
      // Street View: stand close and look across the scene.
      camera.range = 150;
      camera.tilt = 72;
    } else if (raw.t != null) {
      camera.tilt = raw.t;
    }
    return { lat, lng, camera };
  }

  function specFromText(text) {
    const t = clean(text);
    if (!t) return null;
    const c = parseCoords(t);
    if (c) return { name: null, lat: c.lat, lng: c.lng, camera: {} };
    return { name: shortName(t), address: t, query: t, camera: {} };
  }

  function shortName(full) {
    if (!full) return full;
    const first = full.split(',')[0].trim();
    return first || full;
  }

  function isShortLink(host) {
    return /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/.test(host);
  }

  /** Parses one Google Maps (or geo:) URL. Returns an array of specs, or null if it isn't a URL. */
  function parseUrl(str) {
    str = String(str).trim();

    const geo = /^geo:([^?]+)(?:\?(.*))?$/i.exec(str);
    if (geo) {
      const c = parseCoords(geo[1].split(';')[0]);
      const q = geo[2] ? new URLSearchParams(geo[2]).get('q') : null;
      if (c && isValid(c.lat, c.lng)) return [{ name: q ? shortName(clean(q)) : null, lat: c.lat, lng: c.lng, camera: {} }];
      if (q) return [specFromText(q)];
      return [{ error: 'unrecognized', raw: str }];
    }

    let u;
    try { u = new URL(str); } catch (e) { return null; }
    const host = u.hostname.toLowerCase();
    if (isShortLink(host)) return [{ error: 'short', raw: str }];

    const segs = u.pathname.split('/').filter(Boolean);
    const params = u.searchParams;

    // Directions: /maps/dir/A/B/C/@... or ?api=1&origin=..&destination=..&waypoints=a|b
    const dirIdx = segs.indexOf('dir');
    if (dirIdx >= 0) {
      const stops = segs.slice(dirIdx + 1)
        .filter(s => !s.startsWith('@') && !s.startsWith('data=') && s !== 'am=t')
        .map(specFromText).filter(Boolean);
      if (stops.length) return stops;
      const api = [params.get('origin')]
        .concat((params.get('waypoints') || '').split('|'))
        .concat([params.get('destination')])
        .filter(Boolean).map(specFromText).filter(Boolean);
      if (api.length) return api;
    }
    if (params.get('saddr') || params.get('daddr')) {
      const list = [params.get('saddr')].concat((params.get('daddr') || '').split('+to:'))
        .filter(Boolean).map(specFromText).filter(Boolean);
      if (list.length) return list;
    }

    const spec = { name: null, address: null, lat: undefined, lng: undefined, camera: {} };

    const at = segs.find(s => s.startsWith('@'));
    if (at) {
      const r = parseAt(at.slice(1));
      if (r) { spec.lat = r.lat; spec.lng = r.lng; spec.camera = r.camera; }
    }

    // The exact place pin lives in the data blob: ...!3d48.8583701!4d2.2944813...
    const pins = [...str.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
    if (pins.length) {
      const p = pins[pins.length - 1];
      if (isValid(+p[1], +p[2])) { spec.lat = +p[1]; spec.lng = +p[2]; }
    }

    const nameSeg = (key) => {
      const i = segs.indexOf(key);
      return i >= 0 && segs[i + 1] && !segs[i + 1].startsWith('@') && !segs[i + 1].startsWith('data=') ? clean(segs[i + 1]) : null;
    };
    const placeText = nameSeg('place') || nameSeg('search');

    const qText = params.get('q') || params.get('query') || params.get('destination');
    const llText = params.get('ll') || params.get('center') || params.get('sll') || params.get('viewpoint');

    for (const t of [placeText, qText ? clean(qText) : null]) {
      if (!t) continue;
      const c = parseCoords(t);
      if (c) {
        if (spec.lat === undefined || !pins.length) { spec.lat = c.lat; spec.lng = c.lng; }
      } else if (!spec.address) {
        spec.address = t;
        spec.name = shortName(t);
      }
    }
    if (spec.lat === undefined && llText) {
      const c = parseCoords(clean(llText));
      if (c) { spec.lat = c.lat; spec.lng = c.lng; }
    }
    const z = params.get('z') || params.get('zoom');
    if (z && spec.camera.zoom == null && Number.isFinite(+z)) spec.camera.zoom = +z;

    if (spec.lat === undefined) {
      if (spec.address) spec.query = spec.address;
      else return [{ error: 'unrecognized', raw: str }];
    }
    return [spec];
  }

  /** Parses free text: one item per line (URL, coordinates or place name). */
  function parseText(text) {
    const out = [];
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const urls = line.match(/(?:https?:\/\/|geo:)\S+/gi);
      if (urls) {
        // Anything that isn't a URL on the line is treated as a label: "Home  https://maps..."
        const label = line.replace(/(?:https?:\/\/|geo:)\S+/gi, '').replace(/^[\s:|,-]+|[\s:|,-]+$/g, '');
        for (const url of urls) {
          const specs = parseUrl(url.replace(/[),.;]+$/, '')) || [{ error: 'unrecognized', raw: url }];
          if (label && urls.length === 1 && specs.length === 1 && !specs[0].error) specs[0].name = label;
          out.push(...specs);
        }
      } else {
        // "Label 45.97, 7.65" / "Label: 45.97,7.65": a label with trailing decimal coordinates
        const lc = /^(.*?\D)[\s:|,(-]+([-+]?\d{1,2}\.\d+)\s*[,;\s]\s*([-+]?\d{1,3}\.\d+)\)?$/.exec(line);
        if (lc && lc[1].trim() && isValid(+lc[2], +lc[3])) {
          out.push({ name: lc[1].replace(/[\s:|,(-]+$/, '').trim(), lat: +lc[2], lng: +lc[3], camera: {} });
          continue;
        }
        const s = specFromText(line);
        if (s) out.push(s);
      }
    }
    return out;
  }

  // ---------- exported files ----------

  function centroid(coords) {
    const pts = [];
    (function walk(c) {
      if (typeof c[0] === 'number') pts.push(c);
      else c.forEach(walk);
    })(coords);
    if (!pts.length) return null;
    const lng = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return { lat, lng };
  }

  /** GeoJSON, including Google Takeout "Saved Places.json". */
  function parseGeoJSON(obj) {
    const feats = obj.type === 'FeatureCollection' ? obj.features : obj.type === 'Feature' ? [obj] : [];
    const out = [];
    for (const f of feats) {
      const p = f.properties || {};
      const loc = p.location || p.Location || {};
      const name = p.name || p.Name || p.Title || p.title || loc.name || loc['Business Name'] || null;
      const address = loc.address || loc.Address || p.address || p.Address || null;
      let c = f.geometry && f.geometry.coordinates ? centroid(f.geometry.coordinates) : null;
      if (c && !isValid(c.lat, c.lng)) c = null;
      if (!c && loc['Geo Coordinates']) {
        const g = loc['Geo Coordinates'];
        if (isValid(+g.Latitude, +g.Longitude)) c = { lat: +g.Latitude, lng: +g.Longitude };
      }
      const url = p.google_maps_url || p['Google Maps URL'];
      if (!c && url) {
        const r = parseUrl(url);
        if (r && r[0] && r[0].lat !== undefined && !r[0].error) c = { lat: r[0].lat, lng: r[0].lng };
      }
      if (c) out.push({ name, address, lat: c.lat, lng: c.lng, camera: {} });
      else if (name || address) {
        const q = [name, address].filter(Boolean).join(', ');
        out.push({ name: name || shortName(address), address, query: q, camera: {} });
      }
    }
    return out;
  }

  /** KML (Google My Maps / Earth export). Needs a DOMParser (browser). */
  function parseKML(text, DOMParserImpl) {
    const DP = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('KML parsing needs DOMParser');
    const doc = new DP().parseFromString(text, 'application/xml');
    const out = [];
    for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
      const nameEl = pm.getElementsByTagName('name')[0];
      const name = nameEl ? nameEl.textContent.trim() : null;
      const coordEl = pm.getElementsByTagName('coordinates')[0];
      const addrEl = pm.getElementsByTagName('address')[0];
      if (coordEl) {
        const pts = coordEl.textContent.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(p => p.length >= 2);
        const c = centroid(pts);
        if (c && isValid(c.lat, c.lng)) { out.push({ name, lat: c.lat, lng: c.lng, camera: {} }); continue; }
      }
      if (addrEl || name) {
        const address = addrEl ? addrEl.textContent.trim() : null;
        out.push({ name: name || shortName(address), address, query: address || name, camera: {} });
      }
    }
    return out;
  }

  function splitCSVLine(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  /** CSV, including Google Takeout saved lists (Title,Note,URL,...) and any lat/lng table. */
  function parseCSV(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const head = splitCSVLine(lines[0]).map(h => h.toLowerCase());
    const col = (...names) => head.findIndex(h => names.includes(h));
    const iLat = col('lat', 'latitude', 'y');
    const iLng = col('lng', 'lon', 'long', 'longitude', 'x');
    const iName = col('title', 'name', 'place', 'label');
    const iUrl = col('url', 'google maps url', 'link');
    const iAddr = col('address', 'location');
    if (iLat < 0 && iUrl < 0 && iName < 0 && iAddr < 0) return parseText(text); // not really a table
    const out = [];
    for (const line of lines.slice(1)) {
      const row = splitCSVLine(line);
      const name = iName >= 0 ? row[iName] || null : null;
      const address = iAddr >= 0 ? row[iAddr] || null : null;
      if (iLat >= 0 && iLng >= 0 && isValid(+row[iLat], +row[iLng])) {
        out.push({ name, address, lat: +row[iLat], lng: +row[iLng], camera: {} });
        continue;
      }
      if (iUrl >= 0 && row[iUrl]) {
        const r = parseUrl(row[iUrl]);
        if (r && r[0] && !r[0].error && r[0].lat !== undefined) {
          out.push(Object.assign(r[0], { name: name || r[0].name }));
          continue;
        }
        if (r && r[0] && !r[0].error && r[0].query && !name) { out.push(r[0]); continue; }
      }
      if (name || address) {
        out.push({ name: name || shortName(address), address, query: [name, address].filter(Boolean).join(', '), camera: {} });
      }
    }
    return out;
  }

  /** Picks a parser from the file name / content. */
  function parseFile(name, text) {
    const lower = (name || '').toLowerCase();
    const trimmed = text.trim();
    if (lower.endsWith('.kml') || trimmed.startsWith('<')) return parseKML(text);
    if (lower.endsWith('.json') || lower.endsWith('.geojson') || trimmed.startsWith('{')) return parseGeoJSON(JSON.parse(text));
    if (lower.endsWith('.csv')) return parseCSV(text);
    return parseText(text);
  }

  const api = { parseText, parseUrl, parseCoords, parseGeoJSON, parseKML, parseCSV, parseFile, isValid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlaceParser = api;
})(typeof self !== 'undefined' ? self : this);
