'use strict';
/* Small LA — isometric live Los Angeles.
 * Real: OSM/CARTO map tiles, /api/live buses · planes · boats · weather.
 * Simulated (always labelled): traffic cars and robotaxis, which drive along real roads routed by OSRM.
 * Illustrated: landmarks and decorative palms. */
(() => {
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/* ---------- geography ---------- */
const WS = 256 * 4096; // world size in px at z12
const lon2x = (lon) => ((lon + 180) / 360) * WS;
const lat2y = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WS;
};
const x2lon = (x) => (x / WS) * 360 - 180;
const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WS))) * 180) / Math.PI;
const MPP = (40075016.686 / WS) * Math.cos((34.05 * Math.PI) / 180); // metres per world px
const B = { // diorama slab
  x0: lon2x(-118.8), x1: lon2x(-117.9), y0: lat2y(34.33), y1: lat2y(33.65),
};
const inSlab = (x, y, pad = 0) => x >= B.x0 - pad && x <= B.x1 + pad && y >= B.y0 - pad && y <= B.y1 + pad;
const CENTER_W = [lon2x(-118.30), lat2y(34.04)];

/* ---------- state ---------- */
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const savedLayers = (() => { try { return JSON.parse(store?.getItem('smallla.layers') || '{}'); } catch { return {}; } })();
const LAYERS = [
  { key: 'buses', name: 'Buses', kind: 'live', color: '#e4572e', sub: 'LA Metro vehicle positions' },
  { key: 'planes', name: 'Planes', kind: 'live', color: '#3b82f6', sub: 'ADS-B aircraft overhead' },
  { key: 'boats', name: 'Boats', kind: 'live', color: '#0ea5b7', sub: 'AIS vessels off the coast' },
  { key: 'robotaxis', name: 'Robotaxis', kind: 'sim', color: '#14b8a6', sub: 'Simulated fleet — rideable' },
  { key: 'traffic', name: 'Traffic', kind: 'sim', color: '#7c5cff', sub: 'Simulated cars on real roads' },
  { key: 'landmarks', name: 'Landmarks', kind: 'art', color: '#f4b73f', sub: 'Illustrated, at real locations' },
  { key: 'labels', name: 'Labels', kind: 'none', color: '#2b2a33', sub: 'Names & callsigns' },
  { key: 'weatherfx', name: 'Weather effects', kind: 'none', color: '#64748b', sub: 'Clouds, rain, fog, day/night' },
];
const on = Object.fromEntries(LAYERS.map((l) => [l.key, savedLayers[l.key] ?? true]));

const state = {
  live: null, lastOk: 0, lastTry: 0, failing: false, failMsg: '',
  entities: { buses: new Map(), planes: new Map(), boats: new Map() },
  statuses: {}, weather: null,
  selected: null, hover: null,
  timeMode: 'auto', // auto | day | golden | night
  pick: null, // 'pickup' | 'dest'
  tilesOk: 0, tilesFail: 0,
  routing: 'unknown', // unknown | ok | down
};

/* ---------- canvas + camera ---------- */
const canvas = $('#map');
const ctx = canvas.getContext('2d');
let vw = 0, vh = 0, dpr = 1;
const cam = { x: CENTER_W[0], y: CENTER_W[1], m: 1 };
const tgt = { x: cam.x, y: cam.y, m: 1 };
let K1 = 1, K2 = 1, minM = 0.3;
const MAX_M = 7;
let follow = null;

function fitM() {
  const bw = B.x1 - B.x0, bh = B.y1 - B.y0;
  return Math.min(vw / ((bw + bh) * 0.7071 * 1.08), vh / ((bw + bh) * 0.35355 * 1.25));
}
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  vw = window.innerWidth; vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  const firstTime = !resize.done;
  minM = fitM() * 0.85;
  if (firstTime) {
    tgt.m = cam.m = fitM() * (vw < 720 ? 2.2 : 1);
    tgt.x = cam.x = vw < 720 ? CENTER_W[0] : (B.x0 + B.x1) / 2; tgt.y = cam.y = vw < 720 ? CENTER_W[1] : (B.y0 + B.y1) / 2;
    resize.done = true;
  }
  tgt.m = clamp(tgt.m, minM, MAX_M);
}
const S = (wx, wy, h = 0) => [vw / 2 + K1 * (wx - cam.x - (wy - cam.y)), vh / 2 + K2 * (wx - cam.x + (wy - cam.y)) - h];
function screenToWorld(sx, sy, c = cam) {
  const a = (sx - vw / 2) / (0.7071 * c.m), b = (sy - vh / 2) / (0.35355 * c.m);
  return [c.x + (a + b) / 2, c.y + (b - a) / 2];
}
function clampCam(c) {
  c.x = clamp(c.x, B.x0, B.x1); c.y = clamp(c.y, B.y0, B.y1);
}
function zoomAt(factor, sx = vw / 2, sy = vh / 2) {
  const nm = clamp(tgt.m * factor, minM, MAX_M);
  const before = screenToWorld(sx, sy, tgt);
  tgt.m = nm;
  const after = screenToWorld(sx, sy, tgt);
  tgt.x += before[0] - after[0]; tgt.y += before[1] - after[1];
  clampCam(tgt);
}
function flyTo(wx, wy, m) {
  tgt.x = wx; tgt.y = wy; if (m) tgt.m = clamp(m, minM, MAX_M); clampCam(tgt);
}

/* ---------- colour helpers ---------- */
const colCache = new Map();
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function shade(hex, f) {
  const key = hex + f.toFixed(2);
  let v = colCache.get(key);
  if (!v) {
    const [r, g, b] = hex2rgb(hex);
    const mix = (c) => Math.round(clamp(f > 1 ? c + (255 - c) * (f - 1) : c * f, 0, 255));
    v = `rgb(${mix(r)},${mix(g)},${mix(b)})`;
    colCache.set(key, v);
  }
  return v;
}

/* ---------- iso primitives ---------- */
// screen-unit offset (f forward, r right) to world position
function off(px, py, f, r, b, sc) {
  const s = Math.sin(b), c = Math.cos(b), k = sc / cam.m;
  return [px + (s * f + c * r) * k, py + (-c * f + s * r) * k];
}
// oriented box; sizes in screen units (already scaled by caller), heights in px
function box(px, py, len, wid, h, b, color, z0 = 0, f = 0, r = 0) {
  const k = 1 / cam.m, s = Math.sin(b), c = Math.cos(b);
  const cx = px + (s * f + c * r) * k, cy = py + (-c * f + s * r) * k;
  const hl = len / 2, hw = wid / 2;
  const L = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([lf, lr]) => [
    cx + (s * lf + c * lr) * k, cy + (-c * lf + s * lr) * k]);
  const bot = L.map(([x, y]) => S(x, y, z0));
  const top = L.map(([x, y]) => S(x, y, z0 + h));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const nx = (L[i][0] + L[j][0]) / 2 - cx, ny = (L[i][1] + L[j][1]) / 2 - cy;
    if (nx + ny <= 0) continue;
    const t = (nx - ny) / Math.hypot(nx, ny) * 0.7071;
    ctx.fillStyle = shade(color, 0.78 + 0.16 * t);
    ctx.beginPath();
    ctx.moveTo(bot[i][0], bot[i][1]); ctx.lineTo(bot[j][0], bot[j][1]);
    ctx.lineTo(top[j][0], top[j][1]); ctx.lineTo(top[i][0], top[i][1]);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = shade(color, 1.1);
  ctx.beginPath();
  ctx.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(top[i][0], top[i][1]);
  ctx.closePath(); ctx.fill();
}
// upright cylinder / frustum with R screen units
function cyl(px, py, R, h, color, z0 = 0, topR = R) {
  const [x, y] = S(px, py, z0), yt = y - h;
  const g = ctx.createLinearGradient(x - R, 0, x + R, 0);
  g.addColorStop(0, shade(color, 0.72)); g.addColorStop(0.45, shade(color, 1.0)); g.addColorStop(1, shade(color, 0.7));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - topR, yt); ctx.lineTo(x - R, y);
  ctx.ellipse(x, y, R, R / 2, 0, Math.PI, 0, true);
  ctx.lineTo(x + topR, yt);
  ctx.ellipse(x, yt, topR, topR / 2, 0, 0, Math.PI, false);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(color, 1.12);
  ctx.beginPath(); ctx.ellipse(x, yt, topR, topR / 2, 0, 0, TAU); ctx.fill();
}
function dome(px, py, R, color, z0 = 0) {
  const [x, y] = S(px, py, z0);
  const g = ctx.createRadialGradient(x - R * 0.35, y - R * 0.6, R * 0.1, x, y - R * 0.3, R * 1.1);
  g.addColorStop(0, shade(color, 1.35)); g.addColorStop(1, shade(color, 0.8));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(x, y, R, R / 2, 0, 0, Math.PI, false);
  ctx.ellipse(x, y, R, R, 0, Math.PI, TAU, false); ctx.closePath(); ctx.fill();
}
function pyramid(px, py, sz, h, color, z0 = 0) {
  /* base */
  const k = 1 / cam.m, hs = sz / 2;
  const P = [[hs, hs], [hs, -hs], [-hs, -hs], [-hs, hs]].map(([a, b]) => S(px + a * k, py + b * k, z0));
  const apex = S(px, py, z0 + h);
  const faces = [[0, 1], [3, 0]];
  for (const [i, j] of faces) {
    ctx.fillStyle = shade(color, i === 0 ? 0.8 : 0.95);
    ctx.beginPath(); ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); ctx.lineTo(apex[0], apex[1]); ctx.closePath(); ctx.fill();
  }
}
function ellipseShadow(px, py, rx, alpha = 0.18) {
  const [x, y] = S(px, py, 0);
  ctx.fillStyle = `rgba(30,25,40,${alpha})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx, rx / 2, 0, 0, TAU); ctx.fill();
}
function palm(px, py, sc) {
  const [x, y] = S(px, py, 0);
  const h = 15 * sc;
  ctx.fillStyle = 'rgba(30,25,40,.15)';
  ctx.beginPath(); ctx.ellipse(x + 2 * sc, y, 4 * sc, 2 * sc, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#8a6a43'; ctx.lineWidth = 1.6 * sc; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 1.6 * sc, y - h * 0.5, x + 0.6 * sc, y - h); ctx.stroke();
  ctx.strokeStyle = '#2f9e5b'; ctx.lineWidth = 1.5 * sc;
  const tx = x + 0.6 * sc, ty = y - h;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(tx + Math.cos(a) * 5 * sc, ty + Math.sin(a) * 2.2 * sc - 3 * sc, tx + Math.cos(a) * 8 * sc, ty + Math.sin(a) * 3.6 * sc + 1.5 * sc);
    ctx.stroke();
  }
}
function tree(px, py, sc) {
  const [x, y] = S(px, py, 0);
  ctx.fillStyle = 'rgba(30,25,40,.14)'; ctx.beginPath(); ctx.ellipse(x + 2 * sc, y, 4.5 * sc, 2.2 * sc, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#7a5a3a'; ctx.fillRect(x - 0.8 * sc, y - 5 * sc, 1.6 * sc, 5 * sc);
  ctx.fillStyle = '#4bb36b'; ctx.beginPath(); ctx.arc(x, y - 8 * sc, 4.2 * sc, 0, TAU); ctx.fill();
  ctx.fillStyle = '#69c987'; ctx.beginPath(); ctx.arc(x - 1.2 * sc, y - 9.2 * sc, 2.4 * sc, 0, TAU); ctx.fill();
}

/* ---------- tiles ---------- */
const TILE_MAX_Z = 16, TILE_MIN_Z = 9;
const tiles = new Map();
let tileSeq = 0;
function tileURL(z, x, y, alt) {
  if (alt) return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
}
/* Esri's Light Gray Base is monochrome: water 204, land ~235, roads ~255. Re-ink it into an illustrated palette. */
const LUT = (() => {
  const water = [140, 204, 226], deep = [96, 170, 204], land = [246, 240, 224], road = [255, 253, 247], line = [200, 190, 170];
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const out = new Uint8Array(256 * 3);
  for (let l = 0; l < 256; l++) {
    let c;
    if (l < 150) c = mix(line, deep, 0.5);
    else if (l <= 204) c = mix(mix(line, water, 0.75), water, clamp((l - 175) / 29, 0, 1));
    else if (l <= 234) c = mix(water, land, (l - 204) / 30);
    else c = mix(land, road, clamp((l - 234) / 20, 0, 1));
    out.set(c.map(Math.round), l * 3);
  }
  return out;
})();
function colorize(img) {
  try {
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth || 256; cv.height = img.naturalHeight || 256;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, cv.width, cv.height), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const l = (p[i] + p[i + 1] + p[i + 2]) / 3 | 0, j = l * 3;
      p[i] = LUT[j]; p[i + 1] = LUT[j + 1]; p[i + 2] = LUT[j + 2];
    }
    c.putImageData(d, 0, 0);
    return cv;
  } catch { return img; }
}
function getTile(z, x, y, load = true) {
  const key = `${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (!t && load) {
    t = { img: new Image(), draw: null, ok: false, err: false, alt: false, used: 0 };
    t.img.crossOrigin = 'anonymous';
    t.img.onload = () => { t.draw = t.alt ? t.img : colorize(t.img); t.ok = true; state.tilesOk++; };
    t.img.onerror = () => {
      if (!t.alt) { t.alt = true; t.img.src = tileURL(z, x, y, true); } else { t.err = true; state.tilesFail++; }
    };
    t.img.src = tileURL(z, x, y, false);
    tiles.set(key, t);
    if (tiles.size > 700) {
      const old = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 200);
      for (const [k] of old) tiles.delete(k);
    }
  }
  if (t) t.used = ++tileSeq;
  return t;
}
function drawTile(z, tx, ty, f12, t) {
  // f12: world px per tile px at this z
  const x0 = tx * 256 * f12, y0 = ty * 256 * f12, f = f12;
  const a = 0.7071 * cam.m * f, b = 0.35355 * cam.m * f;
  const e = vw / 2 + 0.7071 * cam.m * ((x0 - cam.x) - (y0 - cam.y));
  const g = vh / 2 + 0.35355 * cam.m * ((x0 - cam.x) + (y0 - cam.y));
  ctx.setTransform(dpr * a, dpr * b, -dpr * a, dpr * b, dpr * e, dpr * g);
  ctx.drawImage(t.draw, -0.25, -0.25, 256.5, 256.5);
}
function drawTileFromAncestor(z, tx, ty) {
  for (let up = 1; up <= 4 && z - up >= TILE_MIN_Z - 2; up++) {
    const az = z - up, ax = tx >> up, ay = ty >> up;
    const t = tiles.get(`${az}/${ax}/${ay}`);
    if (t && t.ok) {
      const n = 1 << up, sz = 256 / n;
      const sx = (tx - ax * n) * sz, sy = (ty - ay * n) * sz;
      const f12 = 2 ** (12 - z);
      const x0 = tx * 256 * f12, y0 = ty * 256 * f12;
      const a = 0.7071 * cam.m * f12, b = 0.35355 * cam.m * f12;
      const e = vw / 2 + 0.7071 * cam.m * ((x0 - cam.x) - (y0 - cam.y));
      const g = vh / 2 + 0.35355 * cam.m * ((x0 - cam.x) + (y0 - cam.y));
      ctx.setTransform(dpr * a, dpr * b, -dpr * a, dpr * b, dpr * e, dpr * g);
      ctx.drawImage(t.draw, sx, sy, sz, sz, -0.25, -0.25, 256.5, 256.5);
      return true;
    }
  }
  return false;
}

/* ---------- time of day ---------- */
function solarElevation(date = new Date()) {
  const rad = Math.PI / 180, lat = 34.05, lon = -118.25;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = (date - start) / 86400000;
  const decl = -23.44 * Math.cos(rad * (360 / 365) * (n + 10));
  const hrs = date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15;
  const H = 15 * (hrs - 12);
  return Math.asin(Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(H * rad)) / rad;
}
const sky = { night: 0, golden: 0 };
function updateSky() {
  let elev = solarElevation();
  if (state.timeMode === 'day') elev = 60;
  else if (state.timeMode === 'golden') elev = 2;
  else if (state.timeMode === 'night') elev = -40;
  const night = clamp((-elev + 2) / 10, 0, 1);
  const golden = clamp(1 - Math.abs(elev - 3) / 9, 0, 1) * (1 - night);
  sky.night += (night - sky.night) * 0.05; sky.golden += (golden - sky.golden) * 0.05;
}

/* ---------- weather model ---------- */
const WX = { cloud: 0, rain: 0, fog: 0, storm: false, snow: false, known: false };
function classifyWeather(w) {
  const out = { cloud: 0, rain: 0, fog: 0, storm: false, snow: false, known: false };
  if (!w || w.available === false) return out;
  const text = String(w.condition || '').toLowerCase();
  const code = Number(w.code);
  out.known = Number.isFinite(code) || !!text;
  if (Number.isFinite(w.cloudCover)) out.cloud = clamp(w.cloudCover / 100, 0, 1);
  else if (/overcast/.test(text)) out.cloud = 0.9; else if (/partly/.test(text)) out.cloud = 0.4; else if (/clear/.test(text)) out.cloud = 0.1;
  if (/drizzle/.test(text)) out.rain = 0.3;
  else if (/heavy|violent/.test(text) && /rain|shower/.test(text)) out.rain = 1;
  else if (/rain|shower/.test(text)) out.rain = /light/.test(text) ? 0.35 : 0.65;
  if (/thunder/.test(text)) { out.storm = true; out.rain = Math.max(out.rain, 0.9); out.cloud = Math.max(out.cloud, 0.9); }
  if (/snow/.test(text)) { out.snow = true; out.rain = 0.6; }
  if (/fog|rime/.test(text)) out.fog = 0.6;
  if (!out.rain && Number(w.precipIn) > 0.005) out.rain = clamp(Number(w.precipIn) * 12, 0.25, 1);
  return out;
}
const wxIcon = (w, night) => {
  const c = classifyWeather(w);
  if (c.storm) return '⛈'; if (c.snow) return '🌨'; if (c.rain > 0.5) return '🌧'; if (c.rain) return '🌦';
  if (c.fog) return '🌫'; if (c.cloud > 0.75) return '☁️'; if (c.cloud > 0.3) return night ? '☁️' : '⛅';
  return night ? '🌙' : '☀️';
};
const compass = (d) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((d % 360) + 360) % 360) / 22.5) % 16];

/* clouds & rain state */
const clouds = Array.from({ length: 16 }, (_, i) => ({
  x: B.x0 + ((i * 0.6180339) % 1) * (B.x1 - B.x0), y: B.y0 + ((i * 0.3819660 + 0.17) % 1) * (B.y1 - B.y0),
  s: 0.7 + ((i * 0.37) % 1) * 0.9, thr: (i + 1) / 17, seed: i,
}));
const drops = Array.from({ length: 420 }, () => ({ x: Math.random(), y: Math.random(), v: 0.7 + Math.random() * 0.6 }));
let flash = 0, nextFlash = 4;

/* ---------- landmarks (illustrated) ---------- */
const rnd = (seed) => { let s = seed * 9301 + 49297; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; };
const LANDMARKS = [
  { id: 'hollywood-sign', name: 'Hollywood Sign', lat: 34.1341, lon: -118.3215, kind: 'sign', desc: 'Nine white letters on Mount Lee, first built in 1923 as a real-estate ad.' },
  { id: 'griffith', name: 'Griffith Observatory', lat: 34.1184, lon: -118.3004, kind: 'observatory', desc: 'Art-deco observatory on the south slope of Mount Hollywood, with free public telescopes.' },
  { id: 'dtla', name: 'Downtown LA', lat: 34.0510, lon: -118.2540, kind: 'dtla', desc: 'Skyline of Wilshire Grand Center and U.S. Bank Tower, the city\u2019s tallest buildings.' },
  { id: 'cityhall', name: 'LA City Hall', lat: 34.0537, lon: -118.2428, kind: 'cityhall', desc: 'The 1928 pyramid-topped tower that stood in for the Daily Planet.' },
  { id: 'dodger', name: 'Dodger Stadium', lat: 34.0739, lon: -118.2400, kind: 'stadium', color: '#4a7fd6', desc: 'Home of the Dodgers since 1962, tucked into Chavez Ravine.' },
  { id: 'capitol', name: 'Capitol Records', lat: 34.1033, lon: -118.3262, kind: 'capitol', desc: 'The stack-of-records tower on Vine Street, opened 1956.' },
  { id: 'getty', name: 'Getty Center', lat: 34.0780, lon: -118.4741, kind: 'getty', desc: 'Travertine-clad hilltop museum overlooking the Westside.' },
  { id: 'pier', name: 'Santa Monica Pier', lat: 34.0095, lon: -118.4977, kind: 'pier', desc: 'Pacific Park\u2019s solar Ferris wheel and the end of Route 66.' },
  { id: 'lax', name: 'LAX Theme Building', lat: 33.9425, lon: -118.4081, kind: 'lax', desc: 'The flying-saucer Theme Building at Los Angeles International Airport.' },
  { id: 'sofi', name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, kind: 'stadium', color: '#9aa5b5', desc: 'Translucent-canopy stadium in Inglewood, home of the Rams and Chargers.' },
  { id: 'rosebowl', name: 'Rose Bowl', lat: 34.1613, lon: -118.1676, kind: 'stadium', color: '#d9a35b', desc: 'Pasadena\u2019s 1922 stadium, the \u201cGranddaddy of Them All\u201d.' },
  { id: 'queenmary', name: 'Queen Mary', lat: 33.7527, lon: -118.1904, kind: 'ship', desc: 'Retired 1936 ocean liner moored in Long Beach.' },
  { id: 'universal', name: 'Universal Studios', lat: 34.1381, lon: -118.3534, kind: 'globe', desc: 'Working movie studio and theme park below the Hollywood Hills.' },
  { id: 'venice', name: 'Venice Beach', lat: 33.9850, lon: -118.4695, kind: 'beach', desc: 'Boardwalk, skate park and Muscle Beach.' },
];
for (const l of LANDMARKS) { l.x = lon2x(l.lon); l.y = lat2y(l.lat); }
const DISTRICTS = [
  ['Hollywood', 34.0980, -118.3300], ['Pasadena', 34.1480, -118.1450], ['Santa Monica', 34.0195, -118.4912],
  ['Beverly Hills', 34.0736, -118.4004], ['Long Beach', 33.7700, -118.1937], ['Burbank', 34.1808, -118.3090],
  ['Inglewood', 33.9617, -118.3531], ['Culver City', 34.0211, -118.3965], ['Glendale', 34.1425, -118.2551],
  ['Torrance', 33.8358, -118.3406], ['Pacific Ocean', 33.9, -118.62], ['San Fernando Valley', 34.2, -118.5],
  ['East LA', 34.0239, -118.1720], ['Compton', 33.8958, -118.2201], ['Malibu Coast', 34.03, -118.7],
].map(([name, lat, lon]) => ({ name, x: lon2x(lon), y: lat2y(lat) }));

function drawLandmark(l, ls, night) {
  const px = l.x, py = l.y, r = rnd(l.id.length * 31 + l.id.charCodeAt(0));
  const at = (ox, oy) => [px + (ox * ls) / cam.m, py + (oy * ls) / cam.m];
  const bx = (ox, oy, w, d, h, c, z = 0) => { const [x, y] = at(ox, oy); box(x, y, w * ls, d * ls, h * ls, 0, c, z * ls); };
  ellipseShadow(px, py, 22 * ls, 0.12);
  switch (l.kind) {
    case 'sign': {
      const word = 'HOLLYWOOD';
      for (let i = 0; i < word.length; i++) {
        const [x, y] = at(-18 + i * 4.5, i * -0.9);
        box(x, y, 3.0 * ls, 1.2 * ls, 5.5 * ls, 0, '#fafafa', 0);
        box(x, y, 1.2 * ls, 1.25 * ls, 3 * ls, 0, i % 2 ? '#e8e8e8' : '#dcdcdc', 1.2 * ls);
      }
      break;
    }
    case 'observatory': {
      bx(0, 0, 18, 9, 6, '#f4efe1'); bx(-10, 0, 6, 8, 8, '#efe9d8'); bx(10, 0, 6, 8, 8, '#efe9d8');
      const [x, y] = at(0, 0); dome(x, y, 6 * ls, '#3fae8a', 6 * ls);
      const [x2, y2] = at(-10, 0); dome(x2, y2, 3 * ls, '#3fae8a', 8 * ls);
      const [x3, y3] = at(10, 0); dome(x3, y3, 3 * ls, '#3fae8a', 8 * ls);
      break;
    }
    case 'dtla': {
      const towers = [[-14, 4, 5, 5, 17, '#b9c6d6'], [-8, -6, 6, 5, 24, '#9fb1c6'], [-3, 7, 5, 6, 20, '#c8d1dc'], [4, 3, 6, 6, 28, '#8ea3bc'],
        [10, -5, 5, 5, 16, '#b2bfcf'], [14, 6, 5, 5, 22, '#a3b3c7'], [-18, -3, 5, 4, 12, '#cfd5dd'], [0, -1, 5, 5, 14, '#d6dbe1'], [17, -1, 4, 5, 11, '#c6ccd6']];
      towers.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
      for (const [ox, oy, w, d, h, c] of towers) bx(ox, oy, w, d, h, c);
      // Wilshire Grand + US Bank
      bx(-10, 10, 6, 6, 40, '#7fa2c7'); const [sx, sy] = at(-10, 10); box(sx, sy, 0.8 * ls, 0.8 * ls, 12 * ls, 0, '#d9e2ec', 40 * ls);
      bx(-4, -9, 6, 6, 34, '#9bb0c9'); bx(-4, -9, 4, 4, 5, '#c9d8ea', 34);
      break;
    }
    case 'cityhall': {
      bx(0, 0, 14, 10, 7, '#efe8d8'); bx(0, 0, 6, 6, 18, '#f4eee0', 7);
      const [x, y] = at(0, 0); pyramid(x, y, 6.5 * ls, 6 * ls, '#d9c9a0', 25 * ls);
      break;
    }
    case 'stadium': {
      const [x, y] = at(0, 0);
      cyl(x, y, 18 * ls, 6 * ls, l.color || '#bbb');
      ctx.fillStyle = '#6dc07b'; const [sx, sy] = S(x, y, 6 * ls);
      ctx.beginPath(); ctx.ellipse(sx, sy, 12 * ls, 6 * ls, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = ls; ctx.beginPath(); ctx.ellipse(sx, sy, 7 * ls, 3.5 * ls, 0, 0, TAU); ctx.stroke();
      break;
    }
    case 'capitol': {
      const [x, y] = at(0, 0);
      for (let i = 0; i < 6; i++) cyl(x, y, (5.2 - i * 0.05) * ls, 2.2 * ls, i % 2 ? '#e9e6df' : '#f7f4ec', i * 2.4 * ls);
      cyl(x, y, 1 * ls, 5 * ls, '#c44', 14.4 * ls);
      break;
    }
    case 'getty': {
      bx(-9, -3, 12, 8, 6, '#efe3c8'); bx(6, 4, 10, 8, 8, '#e8dab8'); bx(-3, 9, 14, 5, 4, '#f4ead3'); bx(12, -6, 6, 6, 5, '#e2d3ae');
      break;
    }
    case 'pier': {
      // pier deck extends west/south into the sea
      box(px, py, 26 * ls, 3 * ls, 1.2 * ls, Math.PI, '#c9a46b', 0, 13 * ls, -1 * ls);
      const [x, y] = at(-4, 14);
      const [sx, sy] = S(x, y, 0);
      const R = 11 * ls, hy = sy - R - 3 * ls;
      ctx.strokeStyle = '#6b5a45'; ctx.lineWidth = 1.2 * ls;
      ctx.beginPath(); ctx.moveTo(sx - R * 0.5, sy); ctx.lineTo(sx, hy); ctx.lineTo(sx + R * 0.5, sy); ctx.stroke();
      ctx.strokeStyle = '#ff7a50'; ctx.lineWidth = 1.6 * ls;
      ctx.beginPath(); ctx.arc(sx, hy, R, 0, TAU); ctx.stroke();
      ctx.lineWidth = 0.7 * ls; ctx.strokeStyle = '#ffd6c4';
      const rot = performance.now() / 6000;
      for (let i = 0; i < 8; i++) {
        const an = rot + (i / 8) * TAU;
        ctx.beginPath(); ctx.moveTo(sx, hy); ctx.lineTo(sx + Math.cos(an) * R, hy + Math.sin(an) * R); ctx.stroke();
        ctx.fillStyle = ['#f4b73f', '#3b82f6', '#14b8a6', '#e4572e'][i % 4];
        ctx.beginPath(); ctx.arc(sx + Math.cos(an) * R, hy + Math.sin(an) * R, 1.6 * ls, 0, TAU); ctx.fill();
      }
      bx(2, 2, 6, 5, 4, '#e8d6b0'); bx(-6, 22, 7, 5, 4, '#ffe0b8');
      break;
    }
    case 'lax': {
      const [x, y] = at(0, 0);
      cyl(x, y, 1.2 * ls, 12 * ls, '#eee'); cyl(x, y, 7 * ls, 1.6 * ls, '#fafafa', 12 * ls, 5 * ls);
      ctx.strokeStyle = '#fafafa'; ctx.lineWidth = 1.2 * ls;
      const [sx, sy] = S(x, y, 0);
      ctx.beginPath(); ctx.moveTo(sx - 5 * ls, sy); ctx.quadraticCurveTo(sx - 4 * ls, sy - 10 * ls, sx, sy - 12 * ls); ctx.moveTo(sx + 5 * ls, sy); ctx.quadraticCurveTo(sx + 4 * ls, sy - 10 * ls, sx, sy - 12 * ls); ctx.stroke();
      bx(14, 10, 18, 5, 4, '#dfe3ea'); bx(-14, -10, 14, 5, 3, '#d5dae2');
      break;
    }
    case 'ship': {
      const [x, y] = at(0, 0);
      box(x, y, 36 * ls, 7 * ls, 5 * ls, Math.PI * 0.5, '#1f2a44');
      box(x, y, 34 * ls, 6.5 * ls, 1.6 * ls, Math.PI * 0.5, '#f4f0e6', 5 * ls);
      box(x, y, 24 * ls, 5 * ls, 3 * ls, Math.PI * 0.5, '#f7f4ec', 6.6 * ls);
      for (let i = -1; i <= 1; i++) { const [fx, fy] = at(0, i * 7); cyl(fx, fy, 1.6 * ls, 7 * ls, '#d6492f', 9.6 * ls); }
      break;
    }
    case 'globe': {
      const [x, y] = at(0, 0);
      cyl(x, y, 3 * ls, 2 * ls, '#555'); dome(x, y, 6 * ls, '#4f8cff', 2 * ls);
      const [sx, sy] = S(x, y, 2 * ls); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 0.8 * ls;
      ctx.beginPath(); ctx.ellipse(sx, sy, 6 * ls, 2 * ls, 0, Math.PI, TAU); ctx.stroke();
      bx(-14, 6, 12, 6, 5, '#d8cbb0'); bx(12, 8, 10, 7, 4, '#e8d9bb');
      break;
    }
    case 'beach': {
      bx(-6, 0, 3, 6, 4, '#ff8a5b'); bx(0, 4, 3, 4, 3, '#4fc3d8'); bx(6, -2, 3, 5, 5, '#f4b73f');
      break;
    }
  }
  if (['stadium', 'observatory', 'sign', 'cityhall', 'getty', 'beach', 'capitol'].includes(l.kind) || l.id === 'universal') {
    for (let i = 0; i < 4; i++) {
      const [x, y] = at((r() - 0.5) * 50, (r() - 0.5) * 50);
      if (l.kind !== 'sign') (i % 2 ? tree : palm)(x, y, ls * 0.75);
    }
  }
  if (night > 0.2) {
    const [gx, gy] = S(px, py, 8 * ls);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 30 * ls);
    g.addColorStop(0, `rgba(255,200,110,${0.35 * night})`); g.addColorStop(1, 'rgba(255,200,110,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, 30 * ls, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ---------- live entities ---------- */
const POLL_MS = 10000;
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
function ingest(kind, list) {
  const map = state.entities[kind];
  const seen = new Set();
  const now = performance.now();
  for (const v of Array.isArray(list) ? list : []) {
    const lat = Number(v.lat), lon = Number(v.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || v.id == null) continue;
    const x = lon2x(lon), y = lat2y(lat), id = String(v.id);
    seen.add(id);
    const brg = Number.isFinite(Number(v.bearing)) && v.bearing !== null ? Number(v.bearing) : null;
    let e = map.get(id);
    if (!e) {
      e = { id, kind, x, y, b: brg ?? 0, fx: x, fy: y, fb: brg ?? 0, tx: x, ty: y, tb: brg ?? 0, t0: now, data: v, hasB: brg !== null };
      map.set(id, e);
    } else {
      e.fx = e.x; e.fy = e.y; e.fb = e.b; e.tx = x; e.ty = y;
      if (brg !== null) { e.tb = e.fb + angDiff(e.fb, brg); e.hasB = true; }
      e.t0 = now; e.data = v;
    }
    e.live = true;
  }
  for (const id of [...map.keys()]) if (!seen.has(id)) { if (state.selected?.ent === map.get(id)) state.selected = null; map.delete(id); }
}
function animateEntities(now) {
  for (const map of Object.values(state.entities)) {
    for (const e of map.values()) {
      const t = clamp((now - e.t0) / 3500, 0, 1), k = t * t * (3 - 2 * t);
      e.x = lerp(e.fx, e.tx, k); e.y = lerp(e.fy, e.ty, k); e.b = lerp(e.fb, e.tb, k);
    }
  }
}
async function poll() {
  state.lastTry = Date.now();
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch('/api/live', { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    state.live = d; state.lastOk = Date.now(); state.failing = false;
    state.statuses = d.status || {}; state.weather = d.weather || null;
    ingest('buses', d.buses); ingest('planes', d.planes); ingest('boats', d.boats);
    Object.assign(WX, classifyWeather(state.weather));
    renderLayers(); renderWeather();
  } catch (err) {
    state.failing = true; state.failMsg = err.name === 'AbortError' ? 'timed out' : err.message;
  } finally { clearTimeout(to); renderConn(); }
}

function layerState(key) {
  // returns {cls,label,msg,count}
  const s = state.statuses[key];
  const arr = state.entities[key];
  const count = arr ? [...arr.values()].filter((e) => inSlab(e.x, e.y)).length : null;
  const total = arr ? arr.size : null;
  if (!state.live) return { cls: state.failing ? 'off' : 'wait', label: state.failing ? 'OFFLINE' : '…', msg: state.failing ? 'Backend unreachable' : 'Connecting', count: null };
  if (state.failing) return { cls: 'off', label: 'STALE', msg: `Backend unreachable (${state.failMsg}); showing last data`, count, total };
  if (!s) return { cls: 'wait', label: '…', msg: 'No status reported', count, total };
  if (s.state === 'ok') return { cls: 'live', label: 'LIVE', msg: `${s.source || 'Live'}${s.updatedAt ? ' · updated ' + ago(Date.parse(s.updatedAt)) : ''}`, count, total };
  if (s.state === 'connecting') return { cls: 'wait', label: 'CONNECTING', msg: s.message || 'Connecting', count, total };
  return { cls: 'off', label: 'UNAVAILABLE', msg: s.message || 'Unavailable', count: 0, total: 0 };
}
function ago(ts) {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

/* ---------- UI: layers ---------- */
const layerRows = {};
function buildLayers() {
  const ul = $('#layerList');
  for (const l of LAYERS) {
    const input = el('input', { type: 'checkbox', id: 'lay-' + l.key });
    input.checked = on[l.key];
    input.addEventListener('change', () => {
      on[l.key] = input.checked;
      try { store?.setItem('smallla.layers', JSON.stringify(on)); } catch {}
      if (state.selected && state.selected.layer === l.key && !input.checked) closeInfo();
      if (l.key === 'robotaxis') renderTaxi();
    });
    const badge = el('span', { class: 'badge' });
    const count = el('span', { class: 'l-count' });
    const sub = el('span', { class: 'l-sub' }, l.sub);
    const name = el('span', { class: 'l-name' }, l.name, badge);
    const row = el('label', { class: 'layer', style: `--c:${l.color}` }, input, el('span', { class: 'sw' }), name, count, sub);
    ul.append(el('li', {}, row));
    layerRows[l.key] = { badge, count, sub, row, def: l.sub };
  }
}
function renderLayers() {
  for (const l of LAYERS) {
    const r = layerRows[l.key];
    if (l.kind === 'live') {
      const st = layerState(l.key);
      r.badge.className = 'badge ' + st.cls; r.badge.textContent = st.label;
      r.count.textContent = st.count == null ? '' : String(st.count);
      if (st.count != null && st.total > st.count) r.count.title = `${st.total - st.count} more outside the map area`;
      r.sub.textContent = st.cls === 'live' ? `${l.sub}` : st.msg;
      r.row.title = st.msg;
      r.row.classList.toggle('warn', st.cls === 'off');
    } else if (l.kind === 'sim') {
      r.badge.className = 'badge sim'; r.badge.textContent = 'SIM';
      const n = l.key === 'robotaxis' ? fleet.length : cars.length;
      const down = state.routing === 'down';
      r.count.textContent = down && l.key === 'traffic' ? 'n/a' : String(n);
      r.sub.textContent = down ? 'Road routing unavailable — cannot simulate driving' : state.routing === 'unknown' ? 'Fetching real road geometry…' : l.sub;
    } else if (l.kind === 'art') { r.badge.className = 'badge art'; r.badge.textContent = 'ART'; r.count.textContent = String(LANDMARKS.length); }
  }
}
function renderConn() {
  const c = $('#conn'), t = $('#connText');
  if (state.failing) {
    c.className = 'conn bad';
    t.textContent = state.lastOk ? `Offline (${state.failMsg}) · last data ${ago(state.lastOk)}` : `Backend unreachable (${state.failMsg})`;
    showBanner(state.lastOk ? 'Live feed interrupted — showing last known positions.' : 'Can\u2019t reach the Small LA backend. Nothing live to show yet.', true);
  } else if (state.lastOk) {
    c.className = 'conn ok'; t.textContent = `Live · updated ${ago(state.lastOk)}`; showBanner('');
  } else { c.className = 'conn wait'; t.textContent = 'Connecting…'; }
}
function showBanner(msg, err) {
  const b = $('#banner'); if (!msg) { b.hidden = true; return; }
  b.hidden = false; b.textContent = msg; b.className = 'banner' + (err ? ' err' : '');
}

/* ---------- UI: weather ---------- */
function isNight() { return sky.night > 0.5; }
function renderWeather() {
  const body = $('#wxBody'), mini = $('#wxMini');
  const w = state.weather, st = state.statuses.weather;
  body.textContent = '';
  if (!state.live) { body.append(el('p', { class: 'muted' }, state.failing ? 'Weather unavailable — backend unreachable.' : 'Loading weather…')); mini.textContent = ''; return; }
  if (!w || w.available === false || st?.state !== 'ok') {
    body.append(el('p', { class: 'muted' }, `Weather unavailable${st?.message ? ': ' + st.message.replace(/^Weather unavailable:\s*/, '') : ''}. No weather effects are shown — we won\u2019t guess.`));
    mini.textContent = 'unavailable'; return;
  }
  const f = (v, u = '', d = 0) => (Number.isFinite(v) ? `${v.toFixed(d)}${u}` : '—');
  mini.textContent = `${wxIcon(w, isNight())} ${f(w.tempF, '°F')}`;
  body.append(
    el('div', { class: 'wx-main' }, el('div', { class: 'wx-ico' }, wxIcon(w, isNight())),
      el('div', {}, el('div', { class: 'wx-temp' }, f(w.tempF, '°')), el('div', { class: 'wx-cond' }, `${w.condition || ''}${Number.isFinite(w.feelsLikeF) ? ` · feels ${f(w.feelsLikeF, '°')}` : ''}`))),
    el('div', { class: 'wx-grid' },
      el('div', {}, 'Wind', el('b', {}, Number.isFinite(w.windMph) ? `${f(w.windMph, ' mph')} ${Number.isFinite(w.windDirDeg) ? compass(w.windDirDeg) : ''}` : '—')),
      el('div', {}, 'Humidity', el('b', {}, f(w.humidity, '%'))),
      el('div', {}, 'Clouds', el('b', {}, f(w.cloudCover, '%')))),
    el('div', { class: 'kv' }, el('span', {}, 'Source'), el('b', {}, 'Open-Meteo · LIVE')),
  );
  for (const a of (w.alerts || []).slice(0, 2)) body.append(el('div', { class: 'alert' }, el('b', {}, a.event || 'Alert'), a.headline || ''));
}

/* ---------- OSRM routing ---------- */
const routeCache = new Map();
async function osrm(a, b) { // a,b: [wx,wy]
  const ll = ([x, y]) => `${x2lon(x).toFixed(5)},${y2lat(y).toFixed(5)}`;
  const key = `${ll(a)};${ll(b)}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const p = (async () => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const r = j.routes?.[0];
      if (!r) throw new Error(j.code || 'no route');
      const pts = r.geometry.coordinates.map(([lo, la]) => [lon2x(lo), lat2y(la)]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      if (cum[cum.length - 1] < 0.5) throw new Error('degenerate route');
      state.routing = 'ok';
      return { pts, cum, len: cum[cum.length - 1], meters: r.distance, seconds: r.duration };
    } finally { clearTimeout(to); }
  })();
  routeCache.set(key, p);
  p.catch(() => routeCache.delete(key));
  return p;
}
function posAt(route, s, dir = 1) {
  const { pts, cum } = route;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const [x0, y0] = pts[lo], [x1, y1] = pts[hi], seg = cum[hi] - cum[lo] || 1, t = clamp((s - cum[lo]) / seg, 0, 1);
  const dx = (x1 - x0) * dir, dy = (y1 - y0) * dir;
  return [lerp(x0, x1, t), lerp(y0, y1, t), Math.atan2(dx, -dy)];
}

/* ---------- simulated traffic + robotaxi fleet ---------- */
const TIMELAPSE = 20; // drawn speed = real speed x this
const mpsToWps = (mps) => (mps * TIMELAPSE) / MPP;
const cars = [], fleet = [];
const CAR_COLORS = ['#f2c14e', '#8fb8de', '#e8a0a0', '#b5d99c', '#d9d9d9', '#c9a7eb', '#f29e6b'];
const TAXI_COLOR = '#14b8a6';
const pairs = [
  ['dtla', 'pier'], ['dtla', 'lax'], ['hollywood-sign', 'dtla'], ['capitol', 'getty'], ['dodger', 'rosebowl'],
  ['lax', 'queenmary'], ['universal', 'venice'], ['sofi', 'dtla'], ['griffith', 'sofi'], ['cityhall', 'queenmary'],
];
const lm = (id) => LANDMARKS.find((l) => l.id === id);
async function initSim() {
  const results = await Promise.allSettled(pairs.map(async ([a, b], i) => {
    await new Promise((r) => setTimeout(r, i * 250));
    return osrm([lm(a).x, lm(a).y], [lm(b).x, lm(b).y]);
  }));
  const routes = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!routes.length) { state.routing = 'down'; renderLayers(); renderTaxi(); return; }
  state.routing = 'ok';
  const rr = rnd(7);
  routes.forEach((route, i) => {
    for (let k = 0; k < 7; k++) {
      cars.push({ route, s: rr() * route.len, dir: rr() < 0.5 ? 1 : -1, v: mpsToWps(8 + rr() * 8), color: CAR_COLORS[(i * 3 + k) % CAR_COLORS.length], id: `car-${i}-${k}`, x: 0, y: 0, b: 0, mode: 'loop' });
    }
  });
  // fleet: taxis each roam a route (starting from an existing route, offset)
  routes.slice(0, 8).forEach((route, i) => {
    fleet.push({ id: `RT-${String(i + 1).padStart(2, '0')}`, route, s: rr() * route.len, dir: rr() < 0.5 ? 1 : -1, v: mpsToWps(11), state: 'idle', mode: 'loop', x: 0, y: 0, b: 0, color: TAXI_COLOR });
  });
  renderLayers(); renderTaxi();
}
function stepSim(dt) {
  for (const c of cars) stepAlong(c, dt);
  for (const t of fleet) {
    if (t.state === 'boarding') { t.wait -= dt; if (t.wait <= 0) startLeg(t, 'riding'); continue; }
    if (t.state === 'parked' || t.state === 'reserved') continue;
    stepAlong(t, dt);
  }
}
function stepAlong(e, dt) {
  e.s += e.dir * e.v * dt;
  if (e.mode === 'loop') {
    if (e.s > e.route.len) { e.s = e.route.len; e.dir = -1; } else if (e.s < 0) { e.s = 0; e.dir = 1; }
  } else if (e.s >= e.route.len) { e.s = e.route.len; e.mode = 'done'; legDone(e); }
  const [x, y, b] = posAt(e.route, clamp(e.s, 0, e.route.len), e.dir);
  e.x = x; e.y = y; e.b = b;
}

/* ride */
const ride = { status: 'idle', pickup: null, dest: null, taxi: null, rideData: null, error: '' };
const defaultPick = { pickup: 'griffith', dest: 'pier' };
function startLeg(t, st) {
  t.state = st; t.mode = 'once'; t.dir = 1; t.s = 0;
  t.route = st === 'toPickup' ? ride.legA : ride.legB; t.v = mpsToWps(st === 'toPickup' ? 14 : 12);
  renderTaxi();
}
function legDone(t) {
  if (t.state === 'toPickup') {
    t.state = 'boarding'; t.wait = 1.6; t.mode = 'done'; ride.status = 'boarding'; renderTaxi();
  } else if (t.state === 'riding') {
    ride.status = 'arrived'; t.state = 'parked'; renderTaxi();
    setTimeout(() => releaseTaxi(t), 6000);
  }
}
async function releaseTaxi(t) {
  // after a trip, taxi resumes roaming from its drop-off back to a random landmark
  if (t.state !== 'parked') return;
  const here = [t.x, t.y];
  const cands = LANDMARKS.filter((l) => Math.hypot(l.x - here[0], l.y - here[1]) > 40);
  const l = cands[Math.floor(Math.random() * cands.length)];
  try {
    const route = await osrm(here, [l.x, l.y]);
    Object.assign(t, { route, s: 0, dir: 1, mode: 'loop', state: 'idle', v: mpsToWps(11) });
  } catch { /* stays parked; honest: routing is down */ }
  if (ride.taxi === t && ride.status === 'arrived') { /* keep the arrival card until the user dismisses it */ }
}
const nearestIdle = (x, y) => fleet.filter((t) => t.state === 'idle').sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
async function requestRide(pickup, dest, withTaxi) {
  if (ride.status !== 'idle' && ride.status !== 'arrived' && ride.status !== 'error') return;
  const taxi = withTaxi || nearestIdle(pickup.x, pickup.y);
  if (!taxi || taxi.state !== 'idle') { setRide({ status: 'error', error: 'No idle robotaxi is available right now.' }); return; }
  Object.assign(ride, { status: 'dispatching', pickup, dest, taxi, error: '' });
  taxi.state = 'reserved'; renderTaxi();
  try {
    let legA;
    if (withTaxi && Math.hypot(pickup.x - taxi.x, pickup.y - taxi.y) < 1) legA = null;
    else legA = await osrm([taxi.x, taxi.y], [pickup.x, pickup.y]);
    const legB = await osrm(legA ? legA.pts[legA.pts.length - 1] : [taxi.x, taxi.y], [dest.x, dest.y]);
    ride.legA = legA; ride.legB = legB;
    ride.realMin = ((legB.seconds + (legA?.seconds || 0)) / 60);
    ride.meters = legB.meters; ride.startedAt = performance.now();
    follow = taxi;
    if (legA) { ride.status = 'toPickup'; startLeg(taxi, 'toPickup'); }
    else { ride.status = 'boarding'; taxi.state = 'boarding'; taxi.wait = 1.2; taxi.mode = 'done'; }
    renderTaxi();
  } catch (e) {
    taxi.state = 'idle';
    setRide({ status: 'error', error: `Couldn\u2019t route that trip (${e.message}). The routing service may be unreachable or the point isn\u2019t near a drivable road.` });
  }
}
function setRide(o) { Object.assign(ride, o); renderTaxi(); }
function resetRide(cancel) {
  if (cancel && ride.taxi && ['reserved', 'toPickup', 'boarding', 'riding'].includes(ride.taxi.state)) {
    const t = ride.taxi; t.state = 'parked'; releaseTaxi(t);
  }
  follow = null;
  Object.assign(ride, { status: 'idle', pickup: null, dest: null, taxi: null, error: '', fromTaxi: null });
  if (sel.pickup === 'taxi') sel.pickup = defaultPick.pickup;
  renderTaxi();
}

/* ride UI */
const pins = { pickup: null, dest: null }; // custom dropped pins {x,y,name}
const sel = { pickup: defaultPick.pickup, dest: defaultPick.dest };
function placeOf(which) {
  const v = sel[which];
  if (v === 'taxi' && ride.fromTaxi) return { x: ride.fromTaxi.x, y: ride.fromTaxi.y, name: `${ride.fromTaxi.id}\u2019s location` };
  if (v === 'pin') return pins[which];
  const l = lm(v); return l ? { x: l.x, y: l.y, name: l.name } : null;
}
function placeSelect(which, label) {
  const s = el('select', { id: 'sel-' + which, 'aria-label': label });
  const add = (v, t) => s.append(el('option', { value: v }, t));
  if (which === 'pickup' && ride.fromTaxi) add('taxi', `${ride.fromTaxi.id}\u2019s location`);
  if (pins[which]) add('pin', `Dropped pin (${y2lat(pins[which].y).toFixed(3)}, ${x2lon(pins[which].x).toFixed(3)})`);
  for (const l of LANDMARKS) add(l.id, l.name);
  add('pick', 'Choose on map…');
  s.value = [...s.options].some((o) => o.value === sel[which]) ? sel[which] : LANDMARKS[0].id;
  s.addEventListener('change', () => {
    if (s.value === 'pick') { s.value = sel[which]; beginPick(which); return; }
    sel[which] = s.value; renderTaxi();
  });
  return s;
}
const fmtMin = (m) => (m < 1 ? '<1 min' : `${Math.round(m)} min`);
function renderTaxi() {
  const body = $('#taxiBody'); if (!body) return;
  const active = document.activeElement?.id;
  body.textContent = '';
  const idleN = fleet.filter((t) => t.state === 'idle').length;
  if (!on.robotaxis) { body.append(el('p', { class: 'muted' }, 'Robotaxi layer is off. Turn it on in Layers to hail a ride.')); return; }
  if (state.routing === 'down' && !fleet.length) {
    body.append(el('p', { class: 'muted' }, 'The road-routing service (OSRM) is unreachable, so the simulated fleet can\u2019t drive. Nothing is faked — try again later.'),
      el('button', { class: 'btn small', onclick: () => { state.routing = 'unknown'; initSim(); renderLayers(); } }, 'Retry'));
    return;
  }
  if (!fleet.length) { body.append(el('p', { class: 'muted' }, 'Deploying fleet on real road routes…')); return; }
  const note = el('p', { class: 'muted', style: 'margin:8px 0 0;font-size:11.5px' }, `Simulated fleet driving real streets, time-lapsed ×${TIMELAPSE}. Not a real service.`);
  const st = ride.status;
  if (st === 'idle') {
    body.append(
      el('label', { for: 'sel-pickup' }, 'Pickup'), placeSelect('pickup', 'Pickup location'),
      el('label', { for: 'sel-dest' }, 'Destination'), placeSelect('dest', 'Destination'),
    );
    const pk = placeOf('pickup'), ds = placeOf('dest');
    const btn = el('button', { class: 'btn', id: 'hail', onclick: () => requestRide(placeOf('pickup'), placeOf('dest'), sel.pickup === 'taxi' ? ride.fromTaxi : undefined) }, idleN ? `Hail a robotaxi (${idleN} free)` : 'No robotaxis free');
    if (!pk || !ds || !idleN || (pk.x === ds.x && pk.y === ds.y)) btn.disabled = true;
    body.append(btn, note);
    if (ride.fromTaxi && sel.pickup !== 'taxi') ride.fromTaxi = null;
  } else if (st === 'error') {
    body.append(el('p', { class: 'muted' }, ride.error), el('button', { class: 'btn ghost', onclick: () => resetRide(false) }, 'OK'));
  } else {
    const steps = ['dispatching', 'toPickup', 'boarding', 'riding', 'arrived'];
    const idx = steps.indexOf(st);
    const title = { dispatching: 'Finding a route…', toPickup: `${ride.taxi.id} is on the way`, boarding: 'Boarding…', riding: `Riding to ${ride.dest.name}`, arrived: `Arrived at ${ride.dest.name}` }[st];
    body.append(
      el('div', { class: 'ride-title' }, title),
      el('div', { class: 'steps' }, [0, 1, 2, 3].map((i) => el('i', { class: i < Math.min(idx, 4) + (st === 'arrived' ? 1 : 0) ? 'on' : '' }))),
      el('div', { class: 'bar' }, el('div', { id: 'rideBar' })),
      el('div', { class: 'kv', id: 'rideKv1' }), el('div', { class: 'kv', id: 'rideKv2' }),
    );
    if (st === 'arrived') body.append(el('button', { class: 'btn', onclick: () => resetRide(false) }, 'Done'));
    else body.append(el('button', { class: 'btn ghost', onclick: () => resetRide(true) }, 'Cancel ride'));
    body.append(note);
    updateRideProgress();
  }
  if (active && $('#' + active)) $('#' + active).focus({ preventScroll: true });
}
function updateRideProgress() {
  const bar = $('#rideBar'), k1 = $('#rideKv1'), k2 = $('#rideKv2'); if (!bar) return;
  const t = ride.taxi; if (!t) return;
  const setKV = (n, a, b) => { n.textContent = ''; n.append(el('span', {}, a), el('b', {}, b)); };
  if (ride.status === 'toPickup' && ride.legA) {
    bar.style.width = `${(t.s / ride.legA.len) * 100}%`;
    const remM = ride.legA.meters * (1 - t.s / ride.legA.len);
    setKV(k1, 'Pickup in', `~${fmtMin(remM / 11 / 60)} real-time`); setKV(k2, 'Pickup', ride.pickup.name);
  } else if (ride.status === 'riding') {
    bar.style.width = `${(t.s / ride.legB.len) * 100}%`;
    const remM = ride.legB.meters * (1 - t.s / ride.legB.len);
    setKV(k1, 'Remaining', `${(remM / 1609.34).toFixed(1)} mi · ~${fmtMin(remM / 11 / 60)}`); setKV(k2, 'Trip', `${(ride.meters / 1609.34).toFixed(1)} mi · ${fmtMin(ride.realMin)} real-time`);
  } else if (ride.status === 'arrived') {
    bar.style.width = '100%'; setKV(k1, 'Trip', `${(ride.meters / 1609.34).toFixed(1)} mi`); setKV(k2, 'Fare', 'Free — it\u2019s a toy');
  } else { bar.style.width = '4%'; setKV(k1, '', ''); setKV(k2, '', ''); }
}
// state transitions that mirror into ride.status from taxi state
function syncRideStatus() {
  const t = ride.taxi; if (!t) return;
  if (t.state === 'riding' && ride.status !== 'riding') { ride.status = 'riding'; renderTaxi(); }
}

/* picking on map */
function beginPick(which) {
  state.pick = which; canvas.classList.add('picking');
  const h = $('#hint'); h.hidden = false; h.textContent = `Click the map to set ${which === 'pickup' ? 'pickup' : 'destination'} · Esc to cancel`;
}
function endPick() { state.pick = null; canvas.classList.remove('picking'); $('#hint').hidden = true; }

/* ---------- info card ---------- */
function openInfo(sel_) {
  state.selected = sel_;
  const card = $('#info'); card.hidden = false; card.textContent = '';
  const close = el('button', { class: 'x', 'aria-label': 'Close', onclick: closeInfo }, '×');
  const mk = (title, sub, badge, ...rest) => card.append(close, el('h3', {}, title), el('div', { class: 'sub' }, sub, ' ', badge), ...rest);
  const badge = (c, t) => el('span', { class: 'badge ' + c }, t);
  if (sel_.layer === 'landmarks') {
    const l = sel_.ent;
    mk(l.name, `${y2lat(l.y).toFixed(4)}, ${x2lon(l.x).toFixed(4)}`, badge('art', 'ILLUSTRATED'), el('p', {}, l.desc));
  } else if (sel_.layer === 'robotaxis') {
    const t = sel_.ent;
    const free = t.state === 'idle' && ride.status === 'idle';
    mk(`Robotaxi ${t.id}`, 'Simulated vehicle', badge('sim', 'SIMULATED'),
      el('p', {}, free ? 'Idle and roaming. Take this one for a spin:' : `Status: ${t.state === 'idle' ? 'roaming' : t.state}.`),
      free ? el('button', { class: 'btn', onclick: () => rideThisTaxi(t) }, 'Ride this robotaxi') : null);
  } else if (sel_.layer === 'traffic') {
    mk('Simulated car', 'Drives a real road route', badge('sim', 'SIMULATED'), el('p', {}, 'Ambient traffic for atmosphere — not a real vehicle.'));
  } else {
    const e = sel_.ent, d = e.data;
    const nice = { buses: 'Metro bus', planes: 'Aircraft', boats: 'Vessel' }[sel_.layer];
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push(el('div', { class: 'kv' }, el('span', {}, k), el('b', {}, String(v)))); };
    add('ID', d.id);
    if (sel_.layer === 'buses') { add('Route', d.route); add('Speed', Number.isFinite(d.speedMps) ? `${(d.speedMps * 2.237).toFixed(0)} mph` : null); }
    if (sel_.layer === 'planes') {
      add('Type', d.type); add('Altitude', d.onGround ? 'On ground' : Number.isFinite(d.altitudeFt) ? `${Math.round(d.altitudeFt).toLocaleString()} ft` : null);
      add('Speed', Number.isFinite(d.speedKts) ? `${Math.round(d.speedKts)} kt` : null);
    }
    if (sel_.layer === 'boats') add('Speed', Number.isFinite(d.speedKts) ? `${d.speedKts} kt` : null);
    add('Heading', e.hasB ? `${Math.round(((e.tb % 360) + 360) % 360)}° ${compass(e.tb)}` : 'unknown');
    add('Position', `${y2lat(e.ty).toFixed(4)}, ${x2lon(e.tx).toFixed(4)}`);
    const upd = d.updated ?? state.statuses[sel_.layer]?.updatedAt;
    if (upd) add('Updated', ago(typeof upd === 'number' ? (upd < 1e12 ? upd * 1000 : upd) : Date.parse(upd)));
    mk(d.label || d.id, nice, badge('live', 'LIVE DATA'), ...rows);
  }
}
function closeInfo() { state.selected = null; $('#info').hidden = true; }
function rideThisTaxi(t) {
  ride.fromTaxi = t; sel.pickup = 'taxi';
  if (sel.dest === 'pin' && !pins.dest) sel.dest = defaultPick.dest;
  closeInfo(); $('#taxiPanel').classList.remove('collapsed'); renderTaxi();
  const hail = $('#hail'); const pk = placeOf('pickup'), ds = placeOf('dest');
  if (pk && ds && Math.hypot(pk.x - ds.x, pk.y - ds.y) > 1) requestRide(pk, ds, t);
}

/* ---------- main render ---------- */
const hits = [];
let placed = [];
function pill(text, x, y, opts = {}) {
  ctx.font = `${opts.bold ? 700 : 600} ${opts.size || 11}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10, h = (opts.size || 11) + 7;
  const r = [x - w / 2, y - h, w, h];
  if (!opts.force) {
    for (const p of placed) if (r[0] < p[0] + p[2] && r[0] + r[2] > p[0] && r[1] < p[1] + p[3] && r[1] + r[3] > p[1]) return false;
  }
  placed.push(r);
  ctx.fillStyle = opts.bg || 'rgba(255,252,244,.92)';
  ctx.beginPath(); ctx.roundRect(r[0], r[1], r[2], r[3], h / 2); ctx.fill();
  if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.fillStyle = opts.fg || '#2b2a33'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, r[1] + h / 2 + 0.5);
  return true;
}
function onScreen(x, y, pad = 60) { return x > -pad && x < vw + pad && y > -pad && y < vh + pad; }

function drawBackdrop() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, vh);
  const mix = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));
  let top = [158, 214, 238], bot = [236, 246, 245];
  const n = sky.night, gd = sky.golden;
  top = mix(top, [255, 168, 120], gd * 0.7); bot = mix(bot, [255, 226, 190], gd * 0.8);
  top = mix(top, [20, 28, 64], n); bot = mix(bot, [58, 70, 120], n);
  const grey = clamp(WX.cloud * 0.6 + WX.rain * 0.3 + WX.fog * 0.3, 0, 0.85);
  top = mix(top, [140, 150, 162], grey * (1 - n * 0.6)); bot = mix(bot, [196, 202, 208], grey * (1 - n * 0.6));
  g.addColorStop(0, `rgb(${top})`); g.addColorStop(1, `rgb(${bot})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
  if (n > 0.3) { // stars
    ctx.fillStyle = `rgba(255,255,255,${(n - 0.3) * 0.8})`;
    for (let i = 0; i < 70; i++) { const x = ((i * 97.3) % 1) * vw + ((i * 37) % vw) * 0; ctx.fillRect(((i * 211.7) % vw), ((i * 67.9) % (vh * 0.5)), 1.4, 1.4); }
  }
}
function slabPoly(h = 0) { return [S(B.x0, B.y0, h), S(B.x1, B.y0, h), S(B.x1, B.y1, h), S(B.x0, B.y1, h)]; }
function drawSlab() {
  const T = 22 * clamp(cam.m, 0.5, 2.5);
  const top = slabPoly(0), bot = slabPoly(T);
  // ground shadow
  ctx.fillStyle = 'rgba(40,40,70,.16)';
  ctx.beginPath(); top.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x + 10, y + T + 10)); ctx.closePath(); ctx.fill();
  const side = (i, j, c1, c2) => {
    const g = ctx.createLinearGradient(0, top[i][1], 0, bot[i][1] + 30);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(...top[i]); ctx.lineTo(...top[j]); ctx.lineTo(...bot[j]); ctx.lineTo(...bot[i]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(top[i][0], top[i][1] + T * 0.45); ctx.lineTo(top[j][0], top[j][1] + T * 0.45); ctx.stroke();
  };
  side(3, 2, '#c9a273', '#8c6a45'); // south-west face
  side(2, 1, '#b48b5c', '#6f5238'); // south-east face
  // land base colour
  ctx.fillStyle = '#ece6d8';
  ctx.beginPath(); top.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.fill();
}
function drawTiles() {
  const poly = slabPoly(0);
  ctx.save();
  ctx.beginPath(); poly.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x * dpr, y * dpr)); ctx.closePath();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath(); poly.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x * dpr, y * dpr)); ctx.closePath(); ctx.clip();
  const z = clamp(Math.floor(12 + Math.log2(cam.m * Math.min(1.5, dpr) * 0.8) + 0.35), TILE_MIN_Z, TILE_MAX_Z);
  const f12 = 2 ** (12 - z), tw = 256 * f12;
  const corners = [[0, 0], [vw, 0], [vw, vh], [0, vh]].map(([x, y]) => screenToWorld(x, y));
  const minx = clamp(Math.min(...corners.map((c) => c[0])), B.x0, B.x1), maxx = clamp(Math.max(...corners.map((c) => c[0])), B.x0, B.x1);
  const miny = clamp(Math.min(...corners.map((c) => c[1])), B.y0, B.y1), maxy = clamp(Math.max(...corners.map((c) => c[1])), B.y0, B.y1);
  const tx0 = Math.floor(minx / tw), tx1 = Math.floor(maxx / tw), ty0 = Math.floor(miny / tw), ty1 = Math.floor(maxy / tw);
  const list = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    // skip tiles that don't touch the screen
    const pts = [S(tx * tw, ty * tw), S((tx + 1) * tw, ty * tw), S((tx + 1) * tw, (ty + 1) * tw), S(tx * tw, (ty + 1) * tw)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (Math.max(...xs) < -4 || Math.min(...xs) > vw + 4 || Math.max(...ys) < -4 || Math.min(...ys) > vh + 4) continue;
    list.push([tx, ty]);
  }
  if (list.length > 300) list.length = 300;
  // low zoom parent first for coverage
  for (const [tx, ty] of list) {
    const t = getTile(z, tx, ty);
    if (t.ok) drawTile(z, tx, ty, f12, t);
    else if (!drawTileFromAncestor(z, tx, ty)) {
      // prefetch a coarse ancestor so something appears
      getTile(Math.max(TILE_MIN_Z - 2, z - 3), tx >> 3, ty >> 3);
    }
  }
  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // warm illustrated grade
  ctx.save();
  ctx.beginPath(); poly.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.clip();
  ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,196,140,.14)'; ctx.fillRect(0, 0, vw, vh);
  ctx.restore();
  // edge
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); poly.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.stroke();
}

function drawVehicle(kind, e, vs, night) {
  if (kind === 'buses') vs *= clamp(cam.m * 1.1, 0.45, 1);
  else if (kind === 'traffic') vs *= clamp(cam.m * 1.3, 0.6, 1);
  const b = ((e.b % 360) + 360) % 360 * (Math.PI / 180);
  const p = [e.x, e.y];
  if (kind === 'buses') {
    ellipseShadow(e.x, e.y, 6 * vs, 0.2);
    box(e.x, e.y, 12 * vs, 4.2 * vs, 4.2 * vs, b, '#e4572e', 1 * vs);
    box(e.x, e.y, 10 * vs, 4.3 * vs, 1.2 * vs, b, '#2b3a55', 2.4 * vs);
    box(e.x, e.y, 12 * vs, 4.2 * vs, 0.7 * vs, b, '#ffffff', 4.3 * vs);
  } else if (kind === 'boats') {
    const [x, y] = S(e.x, e.y, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1.5 * vs; ctx.lineCap = 'round';
    const [wx, wy] = off(e.x, e.y, -9 * vs, 0, b, 1); const [sx, sy] = S(wx, wy, 0);
    const [w2x, w2y] = off(e.x, e.y, -20 * vs, -3 * vs, b, 1); const [s2x, s2y] = S(w2x, w2y, 0);
    const [w3x, w3y] = off(e.x, e.y, -20 * vs, 3 * vs, b, 1); const [s3x, s3y] = S(w3x, w3y, 0);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(s2x, s2y); ctx.moveTo(sx, sy); ctx.lineTo(s3x, s3y); ctx.stroke();
    ellipseShadow(e.x, e.y, 6 * vs, 0.2);
    box(e.x, e.y, 14 * vs, 5 * vs, 2.6 * vs, b, '#1f6f8b', 0);
    box(e.x, e.y, 13 * vs, 4.4 * vs, 0.8 * vs, b, '#f4f0e6', 2.6 * vs);
    box(e.x, e.y, 5 * vs, 3.4 * vs, 3 * vs, b, '#ffffff', 3.4 * vs, -1.5 * vs, 0);
  } else if (kind === 'robotaxis' || kind === 'traffic') {
    const isT = kind === 'robotaxis';
    const k = isT ? 1.15 : 0.9;
    ellipseShadow(e.x, e.y, 4 * vs * k, 0.2);
    box(e.x, e.y, 7 * vs * k, 3.4 * vs * k, 1.9 * vs * k, b, e.color, 0.4 * vs);
    box(e.x, e.y, 3.8 * vs * k, 2.9 * vs * k, 1.3 * vs * k, b, isT ? '#e9fffb' : '#f2f2f2', 2.3 * vs * k, -0.4 * vs * k, 0);
    if (isT) {
      box(e.x, e.y, 1.2 * vs, 1.2 * vs, 1.4 * vs, b, '#1f2937', 3.6 * vs * k);
      if (e.state === 'riding' || e.state === 'toPickup' || e.state === 'boarding' || e.state === 'reserved') {
        const [x, y] = S(e.x, e.y, 6 * vs);
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
        ctx.strokeStyle = `rgba(20,184,166,${0.9 - pulse * 0.5})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y + 5 * vs, (9 + pulse * 5) * vs, (4.5 + pulse * 2.5) * vs, 0, 0, TAU); ctx.stroke();
      }
    }
  }
  if (night > 0.25) {
    const [x, y] = S(e.x, e.y, 2 * vs), [hx, hy] = off(e.x, e.y, 5 * vs, 0, b, 1), [sx, sy] = S(hx, hy, 2 * vs);
    ctx.globalCompositeOperation = 'lighter';
    const R = (kind === 'buses' ? 11 : 8) * vs;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
    g.addColorStop(0, `rgba(255,236,170,${0.7 * night})`); g.addColorStop(1, 'rgba(255,236,170,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}
function drawPlane(e, vs) {
  const b = ((e.b % 360) + 360) % 360 * (Math.PI / 180);
  const d = e.data;
  const onGround = d.onGround;
  const alt = onGround ? 0 : clamp(Number.isFinite(d.altitudeFt) ? d.altitudeFt / 380 : 40, 6, 60);
  const z = alt * vs;
  ellipseShadow(e.x, e.y, 6 * vs, onGround ? 0.2 : 0.16);
  if (!onGround) { // altitude tether
    const [gx, gy] = S(e.x, e.y, 0), [ax, ay] = S(e.x, e.y, z);
    ctx.strokeStyle = 'rgba(59,130,246,.35)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(ax, ay); ctx.stroke(); ctx.setLineDash([]);
  }
  const white = '#f6f7fb';
  box(e.x, e.y, 15 * vs, 2.4 * vs, 2.2 * vs, b, white, z);
  box(e.x, e.y, 3 * vs, 16 * vs, 0.7 * vs, b, '#dfe5ef', z + 0.6 * vs, 0.5 * vs, 0);
  box(e.x, e.y, 2.4 * vs, 6 * vs, 0.6 * vs, b, '#cfd8e6', z + 0.8 * vs, -6.2 * vs, 0);
  box(e.x, e.y, 3 * vs, 0.7 * vs, 3 * vs, b, '#3b82f6', z + 1.5 * vs, -6 * vs, 0);
  box(e.x, e.y, 2.6 * vs, 1.8 * vs, 1 * vs, b, '#334155', z + 1.4 * vs, 6 * vs, 0);
}

function render(now, dt) {
  K1 = 0.7071 * cam.m; K2 = 0.35355 * cam.m;
  placed = []; hits.length = 0;
  drawBackdrop();
  drawSlab();
  drawTiles();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const night = on.weatherfx ? sky.night : 0;
  const vs = clamp(0.95 * Math.sqrt(cam.m), 0.55, 2.4), ls = clamp(1.05 * Math.pow(cam.m, 0.6), 0.65, 3.4);

  // route overlay for active ride
  if (ride.taxi && ride.legB && on.robotaxis) {
    const drawRoute = (r, color) => {
      if (!r) return;
      ctx.strokeStyle = color; ctx.lineWidth = 3.2; ctx.setLineDash([7, 6]); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); r.pts.forEach(([x, y], i) => { const [sx, sy] = S(x, y, 0.5); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.stroke(); ctx.setLineDash([]);
    };
    if (ride.status !== 'riding') drawRoute(ride.legA, 'rgba(244,183,63,.9)');
    drawRoute(ride.legB, 'rgba(20,184,166,.9)');
  }

  // collect items for depth sorting
  const items = [];
  const push = (wx, wy, fn, hit) => { const [sx, sy] = S(wx, wy, 0); if (onScreen(sx, sy, 120)) items.push([sy, fn, hit && { x: sx, y: sy, ...hit }]); };
  if (on.landmarks) for (const l of LANDMARKS) push(l.x, l.y, () => drawLandmark(l, ls, night), { r: 22 * ls, layer: 'landmarks', ent: l, dy: -10 * ls });
  // decorative palms along coast & hills near landmarks
  const entHit = (layer, e, r) => ({ r, layer, ent: e, dy: -4 * vs });
  if (on.traffic) for (const c of cars) if (inSlab(c.x, c.y)) push(c.x, c.y, () => drawVehicle('traffic', c, vs, night), entHit('traffic', c, 8 * vs));
  if (on.robotaxis) for (const t of fleet) push(t.x, t.y, () => drawVehicle('robotaxis', t, vs, night), entHit('robotaxis', t, 10 * vs));
  if (on.buses) for (const e of state.entities.buses.values()) if (inSlab(e.x, e.y)) push(e.x, e.y, () => drawVehicle('buses', e, vs, night), entHit('buses', e, 9 * vs));
  if (on.boats) for (const e of state.entities.boats.values()) if (inSlab(e.x, e.y)) push(e.x, e.y, () => drawVehicle('boats', e, vs, night), entHit('boats', e, 10 * vs));
  items.sort((a, b) => a[0] - b[0]);
  for (const [, fn, hit] of items) { fn(); if (hit) hits.push(hit); }

  // pickup/dest pins
  if (ride.pickup && ['dispatching', 'toPickup', 'boarding'].includes(ride.status)) drawPin(ride.pickup, '#f4b73f', 'Pickup', true);
  if (ride.dest && ['dispatching', 'toPickup', 'boarding', 'riding'].includes(ride.status)) drawPin(ride.dest, '#14b8a6', 'Destination', false);

  // planes on top (they fly)
  if (on.planes) {
    const pl = [...state.entities.planes.values()].filter((e) => inSlab(e.x, e.y));
    pl.sort((a, b) => a.y + a.x - (b.y + b.x));
    for (const e of pl) {
      const [sx, sy] = S(e.x, e.y, 0);
      if (!onScreen(sx, sy, 80)) continue;
      drawPlane(e, vs);
      const d = e.data, alt = d.onGround ? 0 : clamp(Number.isFinite(d.altitudeFt) ? d.altitudeFt / 380 : 40, 6, 60);
      hits.push({ x: sx, y: sy - alt * vs, r: 11 * vs, layer: 'planes', ent: e, dy: 0 });
    }
  }

  // clouds & weather
  if (on.weatherfx) drawClouds(now, vs);

  // grading overlays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (on.weatherfx) {
    if (sky.golden > 0.02) { ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = `rgba(255,150,80,${0.55 * sky.golden})`; ctx.fillRect(0, 0, vw, vh); ctx.globalCompositeOperation = 'source-over'; }
    if (sky.night > 0.02) {
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(${Math.round(lerp(255, 120, sky.night))},${Math.round(lerp(255, 132, sky.night))},${Math.round(lerp(255, 190, sky.night))},1)`; ctx.fillRect(0, 0, vw, vh); ctx.globalCompositeOperation = 'source-over';
    }
    if (WX.cloud > 0.5) { ctx.globalCompositeOperation = 'multiply'; const v = Math.round(255 - (WX.cloud - 0.5) * 36 - WX.rain * 20); ctx.fillStyle = `rgb(${v},${v},${v + 3})`; ctx.fillRect(0, 0, vw, vh); ctx.globalCompositeOperation = 'source-over'; }
    if (WX.fog > 0) { ctx.fillStyle = `rgba(235,240,245,${WX.fog * 0.45})`; ctx.fillRect(0, 0, vw, vh); }
    if (WX.rain > 0) drawRain(dt);
    if (WX.storm) {
      nextFlash -= dt; if (nextFlash <= 0) { flash = 1; nextFlash = 5 + Math.random() * 9; }
      if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.45})`; ctx.fillRect(0, 0, vw, vh); flash = Math.max(0, flash - dt * 3.5); }
    }
  }

  // labels
  ctx.textAlign = 'center';
  if (on.labels) drawLabels(vs, ls);
  if (state.selected) drawSelection(vs);
}
function drawPin(p, color, text, bounce) {
  const [x, y] = S(p.x, p.y, 0);
  const bob = bounce ? Math.sin(performance.now() / 300) * 3 : 0;
  ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(x, y, 7, 3.5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  const hy = y - 26 + bob;
  ctx.beginPath(); ctx.moveTo(x, y - 1); ctx.bezierCurveTo(x - 14, hy + 4, x - 11, hy - 11, x, hy - 11); ctx.bezierCurveTo(x + 11, hy - 11, x + 14, hy + 4, x, y - 1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, hy - 3, 3.5, 0, TAU); ctx.fill();
  pill(text, x, hy - 14, { size: 10, bold: true, force: true });
}
function drawClouds(now, vs) {
  const cover = WX.known ? WX.cloud : 0;
  const wind = state.weather && Number.isFinite(state.weather.windDirDeg) ? ((state.weather.windDirDeg + 180) * Math.PI) / 180 : Math.PI * 1.5;
  const spd = 0.6 + (state.weather?.windMph || 5) * 0.08;
  const W = B.x1 - B.x0, H = B.y1 - B.y0;
  for (const c of clouds) {
    c.x += Math.sin(wind) * spd * 0.016 * 60 * 0.016; c.y += -Math.cos(wind) * spd * 0.016 * 60 * 0.016;
    if (c.x > B.x1 + 100) c.x = B.x0 - 100; if (c.x < B.x0 - 100) c.x = B.x1 + 100;
    if (c.y > B.y1 + 100) c.y = B.y0 - 100; if (c.y < B.y0 - 100) c.y = B.y1 + 100;
    if (c.thr > cover + 0.05) continue;
    const [sx, sy] = S(c.x, c.y, 0), [cx, cy] = S(c.x, c.y, 90 * vs);
    if (!onScreen(sx, sy, 200)) continue;
    const sc = c.s * (0.8 + vs * 0.6) * (14);
    const dark = clamp(WX.cloud * 0.45 + WX.rain * 0.3, 0, 0.7);
    ctx.fillStyle = `rgba(30,35,60,${0.05 + dark * 0.05})`;
    ctx.beginPath(); ctx.ellipse(sx, sy, sc * 1.8, sc * 0.9, 0, 0, TAU); ctx.fill();
    const base = Math.round(255 - dark * 110), a = 0.78;
    ctx.fillStyle = `rgba(${base},${base},${base + 4},${a})`;
    const r = rnd(c.seed + 3);
    for (let i = 0; i < 6; i++) { const ox = (i - 2.5) * sc * 0.55, oy = (r() - 0.5) * sc * 0.3, rr = sc * (0.5 + r() * 0.35); ctx.beginPath(); ctx.ellipse(cx + ox, cy + oy, rr, rr * 0.55, 0, 0, TAU); ctx.fill(); }
  }
}
function drawRain(dt) {
  const n = Math.round(drops.length * WX.rain);
  ctx.strokeStyle = WX.snow ? 'rgba(255,255,255,.85)' : 'rgba(180,205,235,.6)'; ctx.lineWidth = WX.snow ? 2.2 : 1.1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const d = drops[i];
    d.y += dt * (WX.snow ? 0.12 : 1.1) * d.v; d.x -= dt * (WX.snow ? 0.02 : 0.18) * d.v;
    if (d.y > 1) { d.y = -0.05; d.x = Math.random() * 1.2; } if (d.x < -0.1) d.x += 1.2;
    const x = d.x * vw, y = d.y * vh;
    if (WX.snow) { ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); } else { ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 11 * d.v); }
  }
  ctx.stroke();
}
function drawLabels(vs, ls) {
  const sel_ = state.selected, hov = state.hover;
  // districts
  const fade = clamp(1.6 - cam.m * 0.8, 0, 1);
  if (fade > 0.05) {
    ctx.font = `700 ${clamp(12 + cam.m * 2, 12, 17)}px ui-rounded, system-ui, sans-serif`;
    for (const d of DISTRICTS) {
      const [x, y] = S(d.x, d.y, 0); if (!onScreen(x, y)) continue;
      const w = ctx.measureText(d.name.toUpperCase()).width + 6, h = 18;
      if (placed.some((p) => x - w / 2 < p[0] + p[2] && x + w / 2 > p[0] && y - h < p[1] + p[3] && y > p[1])) continue;
      placed.push([x - w / 2, y - h, w, h]);
      ctx.lineWidth = 3.5; ctx.strokeStyle = `rgba(255,255,255,${0.85 * fade})`; ctx.fillStyle = `rgba(70,60,80,${0.75 * fade})`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeText(d.name.toUpperCase(), x, y); ctx.fillText(d.name.toUpperCase(), x, y);
    }
  }
  if (on.landmarks) for (const l of LANDMARKS) {
    const [x, y] = S(l.x, l.y, 0); if (!onScreen(x, y)) continue;
    pill(l.name, x, y - 28 * ls, { size: 11, bold: true, bg: 'rgba(255,244,214,.95)', stroke: '#f4b73f' });
  }
  const rich = cam.m > 2.6;
  const wantLabel = (layer, e) => (sel_ && sel_.ent === e) || (hov && hov.ent === e);
  for (const h of hits) {
    if (h.layer === 'landmarks') continue;
    const e = h.ent;
    let text = null, color = '#fff';
    if (h.layer === 'planes') { text = e.data.label; }
    else if (h.layer === 'buses') text = e.data.route ? `Bus ${e.data.route}` : e.data.label;
    else if (h.layer === 'boats') text = e.data.label;
    else if (h.layer === 'robotaxis') text = e.id;
    if (!text) continue;
    const force = wantLabel(h.layer, e);
    if (!force && !(rich || h.layer === 'planes' && cam.m > 0.6 || h.layer === 'robotaxis' && cam.m > 0.7)) continue;
    const stroke = { buses: '#e4572e', planes: '#3b82f6', boats: '#0ea5b7', robotaxis: '#14b8a6' }[h.layer];
    pill(String(text), h.x, h.y - 10 * vs, { size: 10, force, stroke, bold: force });
  }
}
function drawSelection(vs) {
  const s = state.selected, e = s.ent;
  let wx = e.x, wy = e.y, h = 0;
  if (s.layer === 'landmarks') h = 8;
  const [x, y] = S(wx, wy, 0);
  const t = performance.now() / 500;
  ctx.strokeStyle = '#ff7a50'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(x, y, (14 + Math.sin(t) * 2) * Math.max(vs, 0.8), (7 + Math.sin(t)) * Math.max(vs, 0.8), 0, 0, TAU); ctx.stroke();
}

/* ---------- loop ---------- */
let last = performance.now(), lastUI = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  // camera easing
  const k = 1 - Math.exp(-dt * 12);
  if (follow && ride.status !== 'idle' && ride.status !== 'arrived') { tgt.x = follow.x; tgt.y = follow.y; if (tgt.m < 2.2 && ride.status === 'riding') tgt.m = Math.min(MAX_M, lerp(tgt.m, 2.4, 0.02)); }
  cam.x = lerp(cam.x, tgt.x, k); cam.y = lerp(cam.y, tgt.y, k); cam.m = Math.exp(lerp(Math.log(cam.m), Math.log(tgt.m), k));
  updateSky();
  animateEntities(now);
  stepSim(dt);
  syncRideStatus();
  try { render(now, dt); } catch (err) { console.error(err); }
  if (now - lastUI > 400) { lastUI = now; updateRideProgress(); if (state.lastOk && !state.failing) { renderConnTime(); } }
  requestAnimationFrame(frame);
}
function renderConnTime() { $('#connText').textContent = `Live · updated ${ago(state.lastOk)}`; }

/* ---------- input ---------- */
const ptrs = new Map();
let drag = null, pinch = null;
function hitTest(x, y) {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (Math.hypot(x - h.x, y - (h.y + (h.dy || 0))) <= h.r + 4) return h;
  }
  return null;
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, moved: 0, cx: tgt.x, cy: tgt.y };
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: tgt.m }; drag = null;
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) { const h = hitTest(e.clientX, e.clientY); state.hover = h; canvas.classList.toggle('hover', !!h && !state.pick); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomAt((pinch.m * d / pinch.d) / tgt.m, mx, my);
    cam.m = tgt.m; cam.x = tgt.x; cam.y = tgt.y;
  } else if (drag) {
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 5) {
      canvas.classList.add('dragging'); follow = null;
      const a = dx / (0.7071 * cam.m), b = dy / (0.35355 * cam.m);
      tgt.x -= (a + b) / 2; tgt.y -= (b - a) / 2; clampCam(tgt); cam.x = tgt.x; cam.y = tgt.y;
    }
  }
});
function endPtr(e) {
  const had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (ptrs.size < 2) pinch = null;
  if (had && drag && drag.moved <= 5 && e.type === 'pointerup') handleClick(e.clientX, e.clientY);
  if (ptrs.size === 0) drag = null;
}
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(Math.exp(-dy * 0.0016 * (e.ctrlKey ? 3 : 1)), e.clientX, e.clientY);
}, { passive: false });
canvas.addEventListener('dblclick', (e) => zoomAt(1.8, e.clientX, e.clientY));
function handleClick(x, y) {
  if (state.pick) {
    const [wx, wy] = screenToWorld(x, y);
    if (!inSlab(wx, wy)) return;
    const which = state.pick;
    pins[which] = { x: wx, y: wy, name: `Pin (${y2lat(wy).toFixed(3)}, ${x2lon(wx).toFixed(3)})` };
    sel[which] = 'pin'; endPick(); renderTaxi(); return;
  }
  const h = hitTest(x, y);
  if (h) { openInfo({ layer: h.layer, ent: h.ent }); } else if (state.selected) closeInfo();
}
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('select,input,textarea')) return;
  const step = 90 / cam.m;
  const pan = (dx, dy) => { follow = null; const a = (dx * 80) / (0.7071 * cam.m), b = (dy * 80) / (0.35355 * cam.m); tgt.x += (a + b) / 2; tgt.y += (b - a) / 2; clampCam(tgt); };
  if (e.key === 'ArrowLeft') pan(-1, 0); else if (e.key === 'ArrowRight') pan(1, 0);
  else if (e.key === 'ArrowUp') pan(0, -1); else if (e.key === 'ArrowDown') pan(0, 1);
  else if (e.key === '+' || e.key === '=') zoomAt(1.4); else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.4);
  else if (e.key === 'Escape') { if (state.pick) endPick(); else closeInfo(); }
  else return;
  e.preventDefault();
});
$('#zIn').onclick = () => zoomAt(1.5); $('#zOut').onclick = () => zoomAt(1 / 1.5);
$('#zReset').onclick = () => { follow = null; flyTo((B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2); tgt.m = fitM(); };
const TIME_MODES = [['auto', '⏲', 'Time of day: automatic (real LA time)'], ['day', '☀', 'Time of day: midday'], ['golden', '🌇', 'Time of day: golden hour'], ['night', '🌙', 'Time of day: night']];
$('#zTime').onclick = () => {
  const i = (TIME_MODES.findIndex((m) => m[0] === state.timeMode) + 1) % TIME_MODES.length;
  state.timeMode = TIME_MODES[i][0]; $('#zTime').textContent = TIME_MODES[i][1]; $('#zTime').title = TIME_MODES[i][2]; $('#zTime').setAttribute('aria-label', TIME_MODES[i][2]);
  showBanner(TIME_MODES[i][2]); setTimeout(() => { if (!state.failing) showBanner(''); }, 1800);
};
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  const p = document.getElementById(b.dataset.toggle); const c = p.classList.toggle('collapsed'); b.setAttribute('aria-expanded', String(!c));
}));
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - state.lastTry > 3000) poll(); });

/* ---------- boot ---------- */
buildLayers(); resize();
if (window.innerWidth <= 720) document.querySelectorAll('.panel').forEach((p) => { p.classList.add('collapsed'); p.querySelector('.panel-head').setAttribute('aria-expanded', 'false'); });
renderLayers(); renderWeather(); renderTaxi(); renderConn();
poll(); setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
setInterval(() => { if (state.live) renderLayers(); }, 5000);
initSim();
setTimeout(() => { if (state.tilesOk === 0 && state.tilesFail > 3) showBanner('Map tiles couldn\u2019t be loaded — showing the illustrated layers on a blank base.', true); }, 8000);
requestAnimationFrame(frame);
})();
