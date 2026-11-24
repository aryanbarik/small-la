'use strict';
// small-la backend: static files from public/ + GET /api/live aggregating real public feeds.
// Nothing is simulated: if a feed is down or unconfigured, its array is empty and status says why.

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || '';
const USER_AGENT = 'small-la/0.1 (hobby LA live map)';

// Map region (Greater LA). lat/lon box used to filter buses, boats, and to query aircraft.
const BOX = { south: 33.55, north: 34.45, west: -118.95, east: -117.6 };
const CENTER = { lat: 34.05, lon: -118.25 };
const PLANE_RADIUS_NM = 55;

const BUS_STALE_S = 300;
const PLANE_POLL_MS = 10_000;
const WEATHER_POLL_MS = 10 * 60_000;
const ALERTS_POLL_MS = 5 * 60_000;
const BOAT_STALE_MS = 15 * 60_000;
const DATA_STALE_MS = 60_000; // planes older than this are reported unavailable

const inBox = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) &&
  lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east;

const round = (n, d) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function bearingBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function metersBetween(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111_320;
  const dx = (lon2 - lon1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

async function getJson(url, timeoutMs = 12_000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---- feed state -----------------------------------------------------------
const status = {
  buses: { state: 'connecting', source: 'LA Metro GTFS-realtime (api.metro.net WebSocket)', message: 'Connecting', updatedAt: null, count: 0 },
  planes: { state: 'connecting', source: 'adsb.lol (fallback: OpenSky Network)', message: 'Connecting', updatedAt: null, count: 0 },
  boats: AISSTREAM_API_KEY
    ? { state: 'connecting', source: 'AISStream.io', message: 'Connecting', updatedAt: null, count: 0 }
    : { state: 'unavailable', source: 'AISStream.io', message: 'No free keyless AIS feed exists; set AISSTREAM_API_KEY (free at aisstream.io) to enable vessels', updatedAt: null, count: 0 },
  weather: { state: 'connecting', source: 'Open-Meteo (alerts: NWS api.weather.gov)', message: 'Connecting', updatedAt: null },
};
function setStatus(k, state, message, extra = {}) {
  Object.assign(status[k], { state, message }, extra);
}

// ---- buses: LA Metro websocket (no API key) ------------------------------
const busCache = new Map(); // id -> vehicle
let busSocketOpenAt = 0;
let busLastMessageAt = 0;

function ingestBus(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  const v = m && m.vehicle;
  const pos = v && v.position;
  if (!pos) return;
  const lat = Number(pos.latitude), lon = Number(pos.longitude);
  if (!inBox(lat, lon)) return;
  const ts = Number(v.timestamp);
  if (!Number.isFinite(ts)) return;
  const id = String(m.id || (v.vehicle && v.vehicle.id) || '');
  if (!id) return;
  const prev = busCache.get(id);
  if (prev && ts < prev.ts) return;
  let bearing = Number.isFinite(pos.bearing) ? Number(pos.bearing) : prev ? prev.bearing : null;
  if (prev && metersBetween(prev.lat, prev.lon, lat, lon) > 15) {
    bearing = bearingBetween(prev.lat, prev.lon, lat, lon);
  }
  const route = m.route_code || null;
  const vlabel = (v.vehicle && v.vehicle.label) || id;
  busCache.set(id, {
    id, lat, lon, bearing, ts,
    label: route ? `Line ${route} · bus ${vlabel}` : `Bus ${vlabel}`,
    route,
    speedMps: Number.isFinite(pos.speed) ? pos.speed : null,
  });
  busLastMessageAt = Date.now();
}

function connectBuses(delay = 0) {
  setTimeout(() => {
    const ws = new WebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions', { headers: { 'User-Agent': USER_AGENT } });
    let watchdog;
    const fail = (why) => {
      clearInterval(watchdog);
      setStatus('buses', 'unavailable', `LA Metro feed disconnected (${why}); retrying`);
      try { ws.terminate(); } catch {}
      connectBuses(Math.min(60_000, 5_000 + (Date.now() - busSocketOpenAt < 10_000 ? 15_000 : 0)));
    };
    ws.on('open', () => {
      busSocketOpenAt = Date.now();
      setStatus('buses', 'connecting', 'Connected, waiting for vehicles');
      watchdog = setInterval(() => {
        if (Date.now() - busLastMessageAt > 120_000 && Date.now() - busSocketOpenAt > 120_000) fail('no messages for 2 min');
      }, 30_000);
    });
    ws.on('message', (d) => ingestBus(d.toString()));
    ws.on('error', (e) => { if (ws.readyState !== WebSocket.OPEN) fail(e.message); });
    ws.on('close', (c) => { if (watchdog) fail(`closed ${c}`); });
  }, delay);
}
connectBuses();

function busSnapshot() {
  const cutoff = Date.now() / 1000 - BUS_STALE_S;
  const out = [];
  for (const [id, b] of busCache) {
    if (b.ts < cutoff) { busCache.delete(id); continue; }
    out.push({ id: b.id, lat: round(b.lat, 5), lon: round(b.lon, 5), bearing: round(b.bearing, 0), label: b.label, route: b.route, speedMps: round(b.speedMps, 1), updated: b.ts });
  }
  if (out.length) setStatus('buses', 'ok', 'Live', { updatedAt: new Date(busLastMessageAt).toISOString(), count: out.length });
  else if (status.buses.state === 'ok') setStatus('buses', 'unavailable', 'No recent bus positions', { count: 0 });
  else status.buses.count = 0;
  return out;
}

// ---- planes: adsb.lol, fallback OpenSky ----------------------------------
let planes = [];
let planesAt = 0;

async function fetchPlanesAdsbLol() {
  const j = await getJson(`https://api.adsb.lol/v2/point/${CENTER.lat}/${CENTER.lon}/${PLANE_RADIUS_NM}`);
  const list = Array.isArray(j.ac) ? j.ac : [];
  const out = [];
  for (const a of list) {
    if (!inBox(a.lat, a.lon)) continue;
    const onGround = a.alt_baro === 'ground';
    const callsign = (a.flight || '').trim();
    out.push({
      id: a.hex,
      lat: round(a.lat, 5), lon: round(a.lon, 5),
      bearing: round(a.track ?? a.true_heading ?? null, 0),
      label: callsign || a.r || a.hex,
      type: a.t || null,
      altitudeFt: onGround ? 0 : (Number.isFinite(a.alt_baro) ? a.alt_baro : null),
      speedKts: round(a.gs, 0),
      onGround,
    });
  }
  return out;
}
async function fetchPlanesOpenSky() {
  const q = `lamin=${BOX.south}&lomin=${BOX.west}&lamax=${BOX.north}&lomax=${BOX.east}`;
  const j = await getJson(`https://opensky-network.org/api/states/all?${q}`);
  const out = [];
  for (const s of j.states || []) {
    const [hex, call, , , , lon, lat, baroM, onGround, velMs, track] = s;
    if (!inBox(lat, lon)) continue;
    out.push({
      id: hex, lat: round(lat, 5), lon: round(lon, 5), bearing: round(track, 0),
      label: (call || '').trim() || hex,
      type: null,
      altitudeFt: onGround ? 0 : (Number.isFinite(baroM) ? Math.round(baroM * 3.28084) : null),
      speedKts: Number.isFinite(velMs) ? Math.round(velMs * 1.94384) : null,
      onGround: !!onGround,
    });
  }
  return out;
}
async function pollPlanes() {
  try {
    let src = 'adsb.lol';
    let list;
    try { list = await fetchPlanesAdsbLol(); }
    catch (e1) {
      src = 'OpenSky Network';
      try { list = await fetchPlanesOpenSky(); }
      catch (e2) { throw new Error(`adsb.lol: ${e1.message}; OpenSky: ${e2.message}`); }
    }
    planes = list; planesAt = Date.now();
    setStatus('planes', 'ok', `Live via ${src}`, { updatedAt: new Date(planesAt).toISOString(), count: list.length });
  } catch (e) {
    setStatus('planes', 'unavailable', `Aircraft feeds unreachable: ${e.message}`);
  }
}
pollPlanes();
setInterval(pollPlanes, PLANE_POLL_MS);

// ---- boats: AISStream (requires free key) ---------------------------------
const boatCache = new Map();
let boatSocketOpenAt = 0;

function ingestBoat(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.error) { setStatus('boats', 'unavailable', `AISStream error: ${m.error}`); return; }
  const md = m.MetaData || {};
  const pr = m.Message && (m.Message.PositionReport || m.Message.StandardClassBPositionReport || m.Message.ExtendedClassBPositionReport);
  if (!pr) return;
  const lat = Number(pr.Latitude ?? md.latitude), lon = Number(pr.Longitude ?? md.longitude);
  if (!inBox(lat, lon)) return;
  const id = String(md.MMSI || pr.UserID || '');
  if (!id) return;
  const name = (md.ShipName || '').trim();
  const prev = boatCache.get(id);
  let bearing = Number.isFinite(pr.TrueHeading) && pr.TrueHeading < 360 ? pr.TrueHeading
    : Number.isFinite(pr.Cog) && pr.Cog < 360 ? pr.Cog : prev ? prev.bearing : null;
  boatCache.set(id, { id, lat, lon, bearing, label: name || `MMSI ${id}`, speedKts: Number.isFinite(pr.Sog) && pr.Sog < 102 ? pr.Sog : null, ts: Date.now() });
}

function connectBoats(delay = 0) {
  setTimeout(() => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    let done = false;
    const fail = (why) => {
      if (done) return; done = true;
      setStatus('boats', 'unavailable', `AISStream disconnected (${why}); retrying`);
      try { ws.terminate(); } catch {}
      connectBoats(Date.now() - boatSocketOpenAt < 10_000 ? 60_000 : 5_000);
    };
    ws.on('open', () => {
      boatSocketOpenAt = Date.now();
      setStatus('boats', 'connecting', 'Connected, waiting for vessels');
      ws.send(JSON.stringify({
        APIKey: AISSTREAM_API_KEY,
        BoundingBoxes: [[[BOX.south, BOX.west], [BOX.north, BOX.east]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
      }));
    });
    ws.on('message', (d) => ingestBoat(d.toString()));
    ws.on('error', (e) => fail(e.message));
    ws.on('close', (c) => fail(`closed ${c}`));
  }, delay);
}
if (AISSTREAM_API_KEY) connectBoats();

function boatSnapshot() {
  if (!AISSTREAM_API_KEY) return [];
  const cutoff = Date.now() - BOAT_STALE_MS;
  const out = [];
  let newest = 0;
  for (const [id, b] of boatCache) {
    if (b.ts < cutoff) { boatCache.delete(id); continue; }
    newest = Math.max(newest, b.ts);
    out.push({ id: b.id, lat: round(b.lat, 5), lon: round(b.lon, 5), bearing: round(b.bearing, 0), label: b.label, speedKts: round(b.speedKts, 1) });
  }
  if (out.length) setStatus('boats', 'ok', 'Live', { updatedAt: new Date(newest).toISOString(), count: out.length });
  else {
    status.boats.count = 0;
    if (status.boats.state === 'ok') setStatus('boats', 'unavailable', 'No recent vessel positions');
    // "connecting" with empty cache is reported as-is (AIS coverage near LA can be sparse).
  }
  return out;
}

// ---- weather: Open-Meteo + NWS alerts -------------------------------------
const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};
let weather = null;
let alerts = [];

async function pollWeather() {
  try {
    const cur = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
    const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${CENTER.lat}&longitude=${CENTER.lon}&current=${cur}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FLos_Angeles`);
    const c = j.current;
    if (!c) throw new Error('no current block');
    weather = {
      tempF: c.temperature_2m, feelsLikeF: c.apparent_temperature, humidity: c.relative_humidity_2m,
      precipIn: c.precipitation, cloudCover: c.cloud_cover,
      windMph: c.wind_speed_10m, windDirDeg: c.wind_direction_10m, windGustMph: c.wind_gusts_10m,
      code: c.weather_code, condition: WMO[c.weather_code] || 'Unknown',
      isDay: c.is_day === 1, observedAt: c.time, timezone: 'America/Los_Angeles',
    };
    setStatus('weather', 'ok', 'Live', { updatedAt: new Date().toISOString() });
  } catch (e) {
    setStatus('weather', 'unavailable', `Weather unavailable: ${e.message}`);
    weather = null;
  }
}
async function pollAlerts() {
  try {
    const j = await getJson(`https://api.weather.gov/alerts/active?point=${CENTER.lat},${CENTER.lon}`);
    alerts = (j.features || []).slice(0, 5).map((f) => ({
      event: f.properties.event, severity: f.properties.severity, headline: f.properties.headline, expires: f.properties.expires,
    }));
  } catch { alerts = []; }
}
pollWeather(); pollAlerts();
setInterval(pollWeather, WEATHER_POLL_MS);
setInterval(pollAlerts, ALERTS_POLL_MS);

// ---- API -------------------------------------------------------------------
function liveSnapshot() {
  const buses = busSnapshot();
  const boats = boatSnapshot();
  const planesFresh = planes.length || planesAt ? Date.now() - planesAt < DATA_STALE_MS : false;
  if (!planesFresh && status.planes.state === 'ok') setStatus('planes', 'unavailable', 'Aircraft data is stale');
  const planeList = planesFresh ? planes : [];
  status.planes.count = planeList.length;
  return {
    generatedAt: new Date().toISOString(),
    buses,
    planes: planeList,
    boats,
    weather: weather ? { ...weather, alerts } : { available: false, alerts: [] },
    status,
    region: { center: CENTER, bounds: BOX },
  };
}

// ---- static ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.geojson': 'application/geo+json', '.map': 'application/json',
};

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
  let file = path.join(PUBLIC_DIR, pathname);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); return fs.stat(file, (e2, s2) => (e2 ? notFound(res) : send(file, s2)));}
    if (err) return notFound(res);
    send(file, st);
  });
  function send(f, s) {
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': s.size, 'Cache-Control': 'no-cache' };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  }
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/live') {
    const body = JSON.stringify(liveSnapshot());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (pathname.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`small-la listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!AISSTREAM_API_KEY) console.log('Boats disabled: set AISSTREAM_API_KEY to enable AIS vessels.');
});
