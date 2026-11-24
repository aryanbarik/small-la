/*
 * Real OSM building footprints, extruded isometrically.
 *
 * Data:   OpenFreeMap vector tiles (https://openfreemap.org, planet tileset, OpenMapTiles schema,
 *         layer "building": render_height, render_min_height, colour, hide_3d).
 *         Underlying data (c) OpenStreetMap contributors (ODbL); schema (c) OpenMapTiles.
 *         Free, no API key. Tiles are CORS-enabled and decoded here with a tiny native
 *         protobuf/MVT reader (no dependencies).
 *
 * API:    window.createBuildingLayer({ ctx, S, screenToWorld, getCamera, getViewport, bounds, worldSize, dpr })
 *           -> { draw(), stats() }
 *         draw() is cheap per frame: the extruded geometry is rasterised into an offscreen
 *         canvas (with a margin around the viewport) and that bitmap is blitted, translated and
 *         scaled to follow the camera. The bitmap is rebuilt (throttled) when the camera leaves
 *         its margin / drifts in scale, when tiles arrive, and immediately once the camera rests.
 *
 * World space is the app's z12 pixel space (worldSize = 256 * 2^12).
 */
(function () {
  'use strict';

  const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
  const MAX_CONCURRENT = 6;
  const MAX_CACHE_TILES = 300;
  const MAX_TILES_PER_FRAME = 160;    // tiles considered per rebuild (nearest to screen centre first)
  const MAX_BUILDINGS_PER_FRAME = 26000;
  const MIN_M = 1.6;                  // below this zoom the layer is hidden (buildings are sub-pixel)
  const FADE_M = 0.5;                 // fade/grow-in range above MIN_M
  const Z13_UNTIL_M = 3.0;            // z13 tiles below this zoom, z14 above
  const HEIGHT_EXAGG = 2.4;           // miniature-diorama vertical exaggeration
  const DEFAULT_HEIGHT_M = 7;
  const RETRY_BASE_MS = 4000;
  const RETRY_MAX_MS = 120000;
  const FETCH_TIMEOUT_MS = 15000;

  /* ---------------- MVT decoding (building layer only) ---------------- */

  function decodeBuildingTile(buf, tz, tx, ty, worldSize) {
    const u8 = new Uint8Array(buf);
    const out = [];
    let pos = 0;
    const end0 = u8.length;

    function varint() {
      let r = 0, mul = 1, b;
      do {
        b = u8[pos++];
        r += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80 && pos < end0);
      return r;
    }
    function skip(wt) {
      if (wt === 0) varint();
      else if (wt === 1) pos += 8;
      else if (wt === 2) pos += varint();
      else if (wt === 5) pos += 4;
      else throw new Error('bad wire type');
    }

    const tileW = worldSize / (1 << tz);
    const ox = tx * tileW, oy = ty * tileW;

    while (pos < end0) {
      const tag = varint(), f = tag >>> 3, wt = tag & 7;
      if (f === 3 && wt === 2) {
        const len = varint(), lend = pos + len;
        const layer = readLayer(lend);
        if (layer) for (const b of layer) out.push(b);
        pos = lend;
      } else skip(wt);
    }
    return out;

    function readLayer(lend) {
      // first pass: gather name, keys, values, feature ranges
      let name = '', extent = 4096;
      const keys = [], vals = [], feats = [];
      while (pos < lend) {
        const tag = varint(), f = tag >>> 3, wt = tag & 7;
        if (f === 1 && wt === 2) {
          const l = varint();
          name = String.fromCharCode.apply(null, u8.subarray(pos, pos + l));
          pos += l;
        } else if (f === 2 && wt === 2) {
          const l = varint(); feats.push([pos, pos + l]); pos += l;
        } else if (f === 3 && wt === 2) {
          const l = varint();
          keys.push(new TextDecoder().decode(u8.subarray(pos, pos + l)));
          pos += l;
        } else if (f === 4 && wt === 2) {
          const l = varint(); vals.push(readValue(pos + l)); 
        } else if (f === 5 && wt === 0) extent = varint();
        else skip(wt);
      }
      if (name !== 'building') return null;
      const res = [];
      for (const [s, e] of feats) readFeature(s, e, keys, vals, extent, res);
      return res;
    }

    function readValue(vend) {
      let v = null;
      while (pos < vend) {
        const tag = varint(), f = tag >>> 3, wt = tag & 7;
        if (f === 1 && wt === 2) {
          const l = varint();
          v = new TextDecoder().decode(u8.subarray(pos, pos + l));
          pos += l;
        } else if (f === 2 && wt === 5) {
          v = new DataView(u8.buffer, u8.byteOffset + pos, 4).getFloat32(0, true); pos += 4;
        } else if (f === 3 && wt === 1) {
          v = new DataView(u8.buffer, u8.byteOffset + pos, 8).getFloat64(0, true); pos += 8;
        } else if ((f === 4 || f === 5) && wt === 0) {
          v = varint();
        } else if (f === 6 && wt === 0) {
          const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2;
        } else if (f === 7 && wt === 0) {
          v = !!varint();
        } else skip(wt);
      }
      pos = vend;
      return v;
    }

    function readFeature(s, e, keys, vals, extent, res) {
      pos = s;
      let tags = null, type = 0, gs = 0, ge = 0;
      while (pos < e) {
        const tag = varint(), f = tag >>> 3, wt = tag & 7;
        if (f === 2 && wt === 2) {
          const l = varint(), te = pos + l; tags = [];
          while (pos < te) tags.push(varint());
        } else if (f === 3 && wt === 0) type = varint();
        else if (f === 4 && wt === 2) { const l = varint(); gs = pos; ge = pos + l; pos = ge; }
        else skip(wt);
      }
      if (type !== 3 || !tags) return;
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
      if (props.hide_3d === true) return; // parts supply the 3D shape

      // geometry -> rings (tile units)
      pos = gs;
      const rings = [];
      let cur = null, x = 0, y = 0;
      while (pos < ge) {
        const ci = varint(), cmd = ci & 7, cnt = ci >>> 3;
        if (cmd === 1 || cmd === 2) {
          for (let i = 0; i < cnt; i++) {
            let dx = varint(), dy = varint();
            dx = dx % 2 ? -(dx + 1) / 2 : dx / 2;
            dy = dy % 2 ? -(dy + 1) / 2 : dy / 2;
            x += dx; y += dy;
            if (cmd === 1) { cur = []; rings.push(cur); }
            if (cur) cur.push(x, y);
          }
        } else if (cmd === 7) cur = null;
        else break;
      }
      pos = e;

      // group into polygons: exterior (area>0 in y-down) followed by holes
      const polys = [];
      for (const r of rings) {
        if (r.length < 6) continue;
        let a = 0;
        for (let i = 0, n = r.length; i < n; i += 2) {
          const j = (i + 2) % n;
          a += r[i] * r[j + 1] - r[j] * r[i + 1];
        }
        if (a === 0) continue;
        if (a > 0) polys.push({ outer: r, holes: [] });
        else if (polys.length) polys[polys.length - 1].holes.push(r);
      }
      const sc = tileW / extent;
      let hM = +props.render_height;
      if (!(hM > 0)) hM = DEFAULT_HEIGHT_M;
      let mhM = +props.render_min_height;
      if (!(mhM > 0) || mhM >= hM) mhM = 0;
      for (const p of polys) {
        const n = p.outer.length / 2;
        const pts = new Float32Array(p.outer.length);
        const skipEdge = new Uint8Array(n);
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i < n; i++) {
          const px = p.outer[2 * i], py = p.outer[2 * i + 1];
          const wx = ox + px * sc, wy = oy + py * sc;
          pts[2 * i] = wx; pts[2 * i + 1] = wy;
          if (wx < minx) minx = wx; if (wx > maxx) maxx = wx;
          if (wy < miny) miny = wy; if (wy > maxy) maxy = wy;
          const j = (i + 1) % n;
          const qx = p.outer[2 * j], qy = p.outer[2 * j + 1];
          // edges produced by tile clipping lie on / beyond the tile border: no wall there
          if (px === qx && (px <= 0 || px >= extent)) skipEdge[i] = 1;
          else if (py === qy && (py <= 0 || py >= extent)) skipEdge[i] = 1;
        }
        const holes = p.holes.map((h) => {
          const a = new Float32Array(h.length);
          for (let i = 0; i < h.length; i += 2) { a[i] = ox + h[i] * sc; a[i + 1] = oy + h[i + 1] * sc; }
          return a;
        });
        const seed = hash2(Math.round(minx * 64), Math.round(miny * 64));
        res.push({
          pts, skipEdge, holes, h: hM, mh: mhM,
          minx, miny, maxx, maxy, key: (minx + maxx + miny + maxy) * 0.5,
          pal: palette(props.colour, hM, seed),
        });
      }
    }
  }

  /* ---------------- colour ---------------- */

  const NAMED = {
    white: '#f2eee6', grey: '#b9b6b0', gray: '#b9b6b0', red: '#c4694f', brown: '#a98466', beige: '#e3d3b4',
    yellow: '#e6cf86', tan: '#d2b48c', black: '#6d6a68', blue: '#8fb0c8', green: '#9db98c', orange: '#dc9a62',
    pink: '#e3aaa6', cream: '#efe4c8', silver: '#c7c9cc', darkgray: '#8b8986', lightgray: '#d0cec9',
  };
  // warm, slightly desaturated LA stucco / concrete / glass tones
  const BASES = [
    [236, 226, 208], [228, 214, 190], [240, 232, 218], [222, 205, 182], [214, 206, 196],
    [232, 200, 178], [205, 214, 220], [226, 220, 205], [219, 190, 168], [208, 208, 204],
  ];
  function hash2(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function parseColour(c) {
    if (typeof c !== 'string') return null;
    c = c.trim().toLowerCase();
    if (NAMED[c]) c = NAMED[c];
    let m = /^#([0-9a-f]{6})$/.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    m = /^#([0-9a-f]{3})$/.exec(c);
    if (m) { const s = m[1]; return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]; }
    return null;
  }
  const rgb = (c, k, a) => {
    const r = Math.max(0, Math.min(255, Math.round(c[0] * k)));
    const g = Math.max(0, Math.min(255, Math.round(c[1] * k)));
    const b = Math.max(0, Math.min(255, Math.round(c[2] * k)));
    return a == null ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
  };
  function palette(colour, hM, seed) {
    let base = parseColour(colour);
    const tone = BASES[Math.floor(seed * BASES.length) % BASES.length];
    if (base) base = base.map((v, i) => Math.round(v * 0.55 + tone[i] * 0.45));
    else base = tone;
    if (hM > 60 && !colour) base = [base[0] * 0.9 + 18, base[1] * 0.92 + 22, base[2] * 0.95 + 28]; // glassier towers
    const v = 0.96 + seed * 0.08;
    const roof = [base[0] * v, base[1] * v, base[2] * v];
    return {
      roof: rgb(roof, 1.04),
      edge: rgb(roof, 0.72, 0.55),
      // east-facing -> south-facing shades (light from the upper left of the screen)
      walls: [rgb(base, 0.80), rgb(base, 0.74), rgb(base, 0.67), rgb(base, 0.60)],
      line: rgb(base, 0.5, 0.28),
      glass: hM > 25,
    };
  }

  /* ---------------- tile source ---------------- */

  const cache = new Map();   // key -> {state, bld, last, fail, retryAt, ctl}
  let template = null, metaState = 'idle', metaRetryAt = 0, metaFails = 0;
  let inflight = 0;
  let wanted = [];           // ordered keys to keep/fetch (current rebuild)
  let dataVer = 0;           // bumped whenever tile data/meta changes; invalidates the raster cache
  const decodeQ = [];        // fetched tiles waiting for (time-sliced) MVT decoding
  let decodeHead = 0;

  function loadMeta() {
    if (metaState === 'loading' || metaState === 'ok') return;
    if (performance.now() < metaRetryAt) return;
    metaState = 'loading';
    fetchWithTimeout(TILEJSON_URL, 10000)
      .then((r) => { if (!r.ok) throw new Error('tilejson ' + r.status); return r.json(); })
      .then((j) => {
        const t = j && j.tiles && j.tiles[0];
        if (!t) throw new Error('tilejson without tiles');
        template = t; metaState = 'ok'; metaFails = 0; dataVer++;
      })
      .catch(() => {
        metaState = 'idle'; metaFails++;
        metaRetryAt = performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** metaFails);
      });
  }

  function fetchWithTimeout(url, ms, ctl) {
    const c = ctl || new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal, credentials: 'omit', mode: 'cors' }).finally(() => clearTimeout(t));
  }

  function startTile(key, e, z, x, y, worldSize) {
    e.state = 'loading'; inflight++;
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    e.ctl = new AbortController();
    fetchWithTimeout(url, FETCH_TIMEOUT_MS, e.ctl)
      .then((r) => {
        if (r.status === 404 || r.status === 204) return null;
        if (!r.ok) throw new Error('tile ' + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!buf || !buf.byteLength) { e.bld = []; e.state = 'ok'; e.fail = 0; dataVer++; return; }
        e.state = 'decoding';
        decodeQ.push({ e, buf, z, x, y, worldSize });
      })
      .catch(() => {
        e.state = 'error'; e.fail = (e.fail || 0) + 1;
        e.retryAt = performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** e.fail);
      })
      .finally(() => { inflight--; e.ctl = null; pump(); });
  }

  let pumpWorldSize = 0;
  function pump() {
    if (metaState !== 'ok') return;
    const now = performance.now();
    for (const key of wanted) {
      if (inflight >= MAX_CONCURRENT) break;
      let e = cache.get(key);
      const [z, x, y] = key.split('/').map(Number);
      if (!e) { e = { state: 'new', bld: null, last: now, fail: 0, retryAt: 0, ctl: null }; cache.set(key, e); }
      if (e.state === 'new' || (e.state === 'error' && now >= e.retryAt)) startTile(key, e, z, x, y, pumpWorldSize);
    }
  }

  // Decode fetched tiles a few ms per frame so tile arrival never causes a long frame.
  function drainDecode(budgetMs) {
    const t0 = performance.now();
    while (decodeHead < decodeQ.length) {
      const j = decodeQ[decodeHead++];
      try {
        j.e.bld = decodeBuildingTile(j.buf, j.z, j.x, j.y, j.worldSize);
        j.e.state = 'ok'; j.e.fail = 0;
      } catch (_) {
        j.e.state = 'error'; j.e.fail = (j.e.fail || 0) + 1;
        j.e.retryAt = performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** j.e.fail);
      }
      j.buf = null;
      dataVer++;
      if (performance.now() - t0 > budgetMs) break;
    }
    if (decodeHead >= decodeQ.length) { decodeQ.length = 0; decodeHead = 0; }
  }

  function evict() {
    if (cache.size <= MAX_CACHE_TILES) return;
    const keep = new Set(wanted);
    const arr = [...cache.entries()].filter(([k, e]) => !keep.has(k) && e.state !== 'loading' && e.state !== 'decoding').sort((a, b) => a[1].last - b[1].last);
    for (let i = 0; i < arr.length && cache.size > MAX_CACHE_TILES; i++) cache.delete(arr[i][0]);
  }

  /* ---------------- layer ---------------- */

  window.createBuildingLayer = function createBuildingLayer(opts) {
    const { S, screenToWorld, getCamera, getViewport, bounds, worldSize } = opts;
    const mainCtx = opts.ctx;
    const MPP = (40075016.686 / worldSize) * Math.cos((34.05 * Math.PI) / 180);
    pumpWorldSize = worldSize;

    let lastStats = { tiles: 0, loaded: 0, buildings: 0, drawn: 0, zoom: 0 };

    // Offscreen raster of the static building layer. Coordinates inside it are CSS px of a
    // W x H box whose top-left is screen (-offX, -offY) at the moment it was rendered
    // (camera x,y,m); world point (x,y) sat at (offX + vw/2 + K1(dx-dy), offY + vh/2 + K2(dx+dy)).
    const cv = document.createElement('canvas');
    const rc = cv.getContext('2d');
    const raster = {
      valid: false, count: 0, x: 0, y: 0, m: 1, K1: 1, K2: 1, offX: 0, offY: 0, W: 0, H: 0,
      vw: 0, vh: 0, dpr: 1, dataVer: -1, time: 0, reqZ: 0, z: 0, switchStart: 0, renderMs: 30,
    };
    let prevCam = { x: NaN, y: NaN, m: NaN };
    let lastPump = 0;

    function viewport() {
      const v = typeof getViewport === 'function' ? getViewport() : getViewport;
      if (Array.isArray(v)) return { w: v[0], h: v[1] };
      return { w: v.w ?? v.width ?? v.vw ?? window.innerWidth, h: v.h ?? v.height ?? v.vh ?? window.innerHeight };
    }

    function visibleTiles(z, vw, vh, padSide, padTop, padBottom) {
      const tw = worldSize / (1 << z);
      const cs = [[-padSide, -padTop], [vw + padSide, -padTop], [vw + padSide, vh + padBottom], [-padSide, vh + padBottom]]
        .map(([x, y]) => screenToWorld(x, y));
      const clampv = (v, a, b) => Math.max(a, Math.min(b, v));
      const minx = clampv(Math.min(...cs.map((c) => c[0])), bounds.x0, bounds.x1);
      const maxx = clampv(Math.max(...cs.map((c) => c[0])), bounds.x0, bounds.x1);
      const miny = clampv(Math.min(...cs.map((c) => c[1])), bounds.y0, bounds.y1);
      const maxy = clampv(Math.max(...cs.map((c) => c[1])), bounds.y0, bounds.y1);
      const [cx, cy] = screenToWorld(vw / 2, vh / 2);
      const list = [];
      // precise parallelogram test: tile corners in viewport space
      for (let ty = Math.floor(miny / tw); ty <= Math.floor(maxy / tw); ty++) {
        for (let tx = Math.floor(minx / tw); tx <= Math.floor(maxx / tw); tx++) {
          const p0 = S(tx * tw, ty * tw), p1 = S((tx + 1) * tw, ty * tw), p2 = S((tx + 1) * tw, (ty + 1) * tw), p3 = S(tx * tw, (ty + 1) * tw);
          const x0 = Math.min(p0[0], p1[0], p2[0], p3[0]), x1 = Math.max(p0[0], p1[0], p2[0], p3[0]);
          const y0 = Math.min(p0[1], p1[1], p2[1], p3[1]), y1 = Math.max(p0[1], p1[1], p2[1], p3[1]);
          if (x1 < -padSide || x0 > vw + padSide || y1 < -padTop || y0 > vh + padBottom + 400) continue;
          const d = (tx + 0.5) * tw - cx, e = (ty + 0.5) * tw - cy;
          list.push([d * d + e * e, `${z}/${tx}/${ty}`]);
        }
      }
      list.sort((a, b) => a[0] - b[0]);
      if (list.length > MAX_TILES_PER_FRAME) list.length = MAX_TILES_PER_FRAME;
      return list.map((l) => l[1]);
    }

    function releaseRaster() {
      raster.valid = false; raster.count = 0; raster.dataVer = -1; raster.switchStart = 0;
      if (cv.width > 1) { cv.width = 1; cv.height = 1; }
    }

    // Screen-space placement of the raster for the current camera.
    function placement(cam, vw, vh) {
      const s = cam.m / raster.m;
      const sc = Math.abs(s - 1) < 1e-4 ? 1 : s;
      const ddx = cam.x - raster.x, ddy = cam.y - raster.y;
      const d0x = raster.K1 * (ddx - ddy), d0y = raster.K2 * (ddx + ddy);
      return {
        s, sc, d0x, d0y,
        dx: vw / 2 - sc * (vw / 2 + raster.offX + d0x),
        dy: vh / 2 - sc * (vh / 2 + raster.offY + d0y),
        dw: raster.W * sc, dh: raster.H * sc,
      };
    }

    // Render all buildings of the tiles around the current camera into the offscreen raster.
    function rebuild(now, cam, vw, vh, dpr, desiredZ) {
      const t0 = performance.now();
      const m = cam.m;

      // margin around viewport, shrunk if the backing store would get huge
      let f = 0.25;
      while (f > 0.05 && vw * (1 + 2 * f) * vh * (1 + 2 * f) * dpr * dpr > 14e6) f -= 0.05;
      if (f < 0.05) f = 0;
      const offX = Math.round(vw * f), offY = Math.round(vh * f);
      const W = vw + 2 * offX, H = vh + 2 * offY;
      const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
      else rc.setTransform(1, 0, 0, 1, 0, 0), rc.clearRect(0, 0, pw, ph);
      rc.setTransform(pw / W, 0, 0, ph / H, 0, 0);

      // tiles: switch zoom level only once the new level is mostly loaded (no pop-to-empty)
      const padSide = offX + 60, padTop = offY + 40, padBottom = offY + 260;
      let z = raster.valid ? raster.z : desiredZ;
      const desiredList = visibleTiles(desiredZ, vw, vh, padSide, padTop, padBottom);
      let renderList = desiredList;
      wanted = desiredList;
      if (z !== desiredZ) {
        if (!raster.switchStart) raster.switchStart = now;
        let ready = 0;
        for (const k of desiredList) { const e = cache.get(k); if (e && e.state === 'ok') ready++; }
        if (metaState !== 'ok' || ready >= desiredList.length * 0.7 || now - raster.switchStart > 2500) {
          z = desiredZ; raster.switchStart = 0;
        } else {
          renderList = visibleTiles(z, vw, vh, padSide, padTop, padBottom);
          wanted = desiredList.concat(renderList);
        }
      } else raster.switchStart = 0;
      pump(); lastPump = now;
      evict();

      const frameBld = [];
      let loaded = 0;
      for (const k of renderList) {
        const e = cache.get(k);
        if (!e) continue;
        e.last = now;
        if (e.state === 'ok') { loaded++; for (const b of e.bld) frameBld.push(b); }
      }
      for (const k of desiredList) { const e = cache.get(k); if (e) e.last = now; }
      // far -> near (screen y grows with x + y)
      frameBld.sort((a, b) => a.key - b.key);

      // projection coefficients taken from S so we stay in sync with the app camera
      const cx = cam.x, cy = cam.y;
      const o = S(cx, cy, 0), ex = S(cx + 1, cy, 0);
      const K1 = ex[0] - o[0], K2 = ex[1] - o[1];
      const ox = o[0] + offX, oy = o[1] + offY;

      const grow = Math.min(1, (m - MIN_M) / FADE_M);
      const hs = (m / MPP) * 0.85 * HEIGHT_EXAGG * (0.25 + 0.75 * grow);
      const minPx = m < 2.4 ? 3 : m < 4 ? 2 : 1.2;
      const detail = m >= 3.2;
      const vwp = W + 20, vhp = H + 20;

      const ctx = rc;
      ctx.save();
      ctx.lineJoin = 'round';

      // pre-cull
      const vis = [];
      for (let i = 0; i < frameBld.length; i++) {
        const b = frameBld[i];
        const ax = ox + K1 * ((b.minx - cx) - (b.maxy - cy)), bx = ox + K1 * ((b.maxx - cx) - (b.miny - cy));
        const topY = oy + K2 * ((b.minx - cx) + (b.miny - cy)) - b.h * hs;
        const botY = oy + K2 * ((b.maxx - cx) + (b.maxy - cy)) - b.mh * hs;
        if (bx < -20 || ax > vwp || botY < -20 || topY > vhp) continue;
        if ((bx - ax) + (botY - topY) < minPx * 2.2 && b.h * hs < minPx) continue;
        vis.push(b);
      }
      // Keep detail distributed across the area instead of filling the budget
      // with the farthest (topmost) buildings first.
      if (vis.length > MAX_BUILDINGS_PER_FRAME) {
        const step = vis.length / MAX_BUILDINGS_PER_FRAME;
        for (let i = 0; i < MAX_BUILDINGS_PER_FRAME; i++) vis[i] = vis[Math.floor(i * step)];
        vis.length = MAX_BUILDINGS_PER_FRAME;
      }

      // ground shadows (single path => no double darkening)
      if (m >= 2.0) {
        ctx.beginPath();
        for (const b of vis) {
          if (b.h < 9 || b.mh > 0) continue;
          const len = Math.min(b.h, 160) / MPP * 0.55; // world units
          const pts = b.pts, n = pts.length;
          for (let t = 0.5; t <= 1.0; t += 0.5) {
            const dx = len * t, dy = len * t * 0.18;
            for (let k = 0; k < n; k += 2) {
              const wx = pts[k] + dx - cx, wy = pts[k + 1] + dy - cy;
              const sx = ox + K1 * (wx - wy), sy = oy + K2 * (wx + wy);
              k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
            }
            ctx.closePath();
          }
        }
        ctx.fillStyle = 'rgba(60,50,70,0.16)';
        ctx.fill();
      }

      let drawn = 0;
      for (const b of vis) {
        const pts = b.pts, n = pts.length / 2, skipE = b.skipEdge, pal = b.pal;
        const h0 = b.mh * hs, h1 = b.h * hs;
        drawn++;

        // walls (outer ring has positive area in y-down world space; outward normal = (dy,-dx))
        let lastShade = -1;
        ctx.lineWidth = 0.6;
        for (let i = 0; i < n; i++) {
          if (skipE[i]) continue;
          const j = i + 1 === n ? 0 : i + 1;
          const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
          const dx = bx - ax, dy = by - ay;
          if (dy - dx <= 1e-9) continue; // back face
          const len = Math.hypot(dx, dy);
          if (len === 0) continue;
          const nx = dy / len, ny = -dx / len;
          // shade: 0 = facing east/right .. 3 = facing south/left
          const u = (nx - ny + 1.4142) / 2.8284; // 0..1 ; nx+ny>0 here
          const shade = Math.max(0, Math.min(3, Math.round((1 - u) * 3)));
          const pax = ox + K1 * ((ax - cx) - (ay - cy)), pay = oy + K2 * ((ax - cx) + (ay - cy));
          const pbx = ox + K1 * ((bx - cx) - (by - cy)), pby = oy + K2 * ((bx - cx) + (by - cy));
          if (shade !== lastShade) { ctx.fillStyle = pal.walls[shade]; ctx.strokeStyle = pal.line; lastShade = shade; }
          ctx.beginPath();
          ctx.moveTo(pax, pay - h0); ctx.lineTo(pbx, pby - h0); ctx.lineTo(pbx, pby - h1); ctx.lineTo(pax, pay - h1);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          if (detail && h1 - h0 > 8) {
            // floor bands / window rows
            const wallH = h1 - h0;
            const floors = Math.min(18, Math.max(1, Math.floor((b.h - b.mh) / 3.4)));
            if (floors > 1 && Math.abs(pbx - pax) + Math.abs(pby - pay) > 4) {
              ctx.strokeStyle = pal.glass ? 'rgba(210,235,250,0.32)' : pal.line;
              ctx.lineWidth = pal.glass ? 0.9 : 0.5;
              ctx.beginPath();
              for (let f2 = 1; f2 < floors; f2++) {
                const yy = (wallH * f2) / floors;
                ctx.moveTo(pax, pay - h0 - yy); ctx.lineTo(pbx, pby - h0 - yy);
              }
              ctx.stroke();
              ctx.lineWidth = 0.6;
              ctx.strokeStyle = pal.line;
            }
          }
        }

        // roof (holes via even-odd)
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const wx = pts[2 * i] - cx, wy = pts[2 * i + 1] - cy;
          const sx = ox + K1 * (wx - wy), sy = oy + K2 * (wx + wy) - h1;
          i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
        }
        ctx.closePath();
        for (const hole of b.holes) {
          for (let i = 0; i < hole.length; i += 2) {
            const wx = hole[i] - cx, wy = hole[i + 1] - cy;
            const sx = ox + K1 * (wx - wy), sy = oy + K2 * (wx + wy) - h1;
            i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
          }
          ctx.closePath();
        }
        ctx.fillStyle = pal.roof;
        ctx.fill('evenodd');
        if (detail) {
          ctx.strokeStyle = pal.edge; ctx.lineWidth = 1; ctx.stroke();
        } else {
          ctx.strokeStyle = pal.roof; ctx.lineWidth = 0.4; ctx.stroke();
        }
      }
      ctx.restore();

      Object.assign(raster, {
        valid: true, count: drawn, x: cx, y: cy, m, K1, K2, offX, offY, W, H, vw, vh, dpr,
        dataVer, time: now, reqZ: desiredZ, z,
      });
      raster.renderMs = performance.now() - t0;
      lastStats = { tiles: renderList.length, loaded, buildings: frameBld.length, drawn, zoom: z };
    }

    function draw() {
      drainDecode(5);
      const cam = getCamera();
      const m = cam.m;
      if (!(m >= MIN_M)) {
        if (wanted.length || raster.valid) { wanted = []; releaseRaster(); }
        lastStats.drawn = 0;
        prevCam = { x: NaN, y: NaN, m: NaN };
        return;
      }
      const { w: vw, h: vh } = viewport();
      const dpr = mainCtx.getTransform().a || 1;
      const desiredZ = m < Z13_UNTIL_M ? 13 : 14;
      const now = performance.now();

      loadMeta();
      if (now - lastPump > 1000) { lastPump = now; pump(); } // retry failed tiles while the camera rests

      // is the camera at rest (same place as the previous frame)?
      const k1 = 0.7071 * m, k2 = 0.35355 * m;
      const ddx = cam.x - prevCam.x, ddy = cam.y - prevCam.y;
      const rest = Math.max(Math.abs(k1 * (ddx - ddy)), Math.abs(k2 * (ddx + ddy))) < 0.25 && Math.abs(m / prevCam.m - 1) < 2e-4;
      prevCam.x = cam.x; prevCam.y = cam.y; prevCam.m = m;

      let doRebuild = false;
      if (!raster.valid || raster.vw !== vw || raster.vh !== vh || raster.dpr !== dpr) {
        doRebuild = true;
      } else {
        const p = placement(cam, vw, vh);
        const since = now - raster.time;
        const covered = p.dx <= 0.5 && p.dy <= 0.5 && p.dx + p.dw >= vw - 0.5 && p.dy + p.dh >= vh - 0.5;
        const scaleOff = Math.abs(p.s - 1);
        const motionNeeds = !covered || scaleOff > 0.08 || desiredZ !== raster.reqZ;
        const restNeeds = scaleOff > 1e-4 || Math.hypot(p.d0x, p.d0y) * p.sc > 0.35;
        const dataNeeds = dataVer !== raster.dataVer || (raster.switchStart && now - raster.switchStart > 2500);
        const interval = Math.max(120, Math.min(600, raster.renderMs * 2.5));
        const dataInterval = Math.max(250, raster.renderMs * 3);
        if (rest && (motionNeeds || restNeeds)) doRebuild = true;
        else if (motionNeeds && since >= interval) doRebuild = true;
        else if (dataNeeds && since >= dataInterval) doRebuild = true;
      }
      if (doRebuild) rebuild(now, cam, vw, vh, dpr, desiredZ);
      if (!raster.valid || !raster.count) return;

      const p = placement(cam, vw, vh);
      const grow = Math.min(1, (m - MIN_M) / FADE_M);
      let dx = p.dx, dy = p.dy;
      if (p.sc === 1) { dx = Math.round(dx * dpr) / dpr; dy = Math.round(dy * dpr) / dpr; }
      mainCtx.save();
      mainCtx.globalAlpha *= Math.min(1, 0.15 + grow);
      mainCtx.imageSmoothingEnabled = true;
      mainCtx.drawImage(cv, dx, dy, p.dw, p.dh);
      mainCtx.restore();
    }

    return { draw, stats: () => ({ ...lastStats, inflight, cached: cache.size, meta: metaState }) };
  };
})();
