# small-la

A miniature Los Angeles browser map with live buses, aircraft, vessels and weather.

Explore the map by dragging and zooming. Toggle the layers to show live vehicles,
illustrated landmarks, and simulated traffic. The robotaxi panel lets you request a
simulated ride between landmarks or points on the map; it uses public OSRM road
routes and is not a real transportation service. Routing requires network access.

The close-up view extrudes OpenStreetMap building footprints from OpenFreeMap
vector tiles. Heights are exaggerated for legibility and estimated when missing;
the result is an illustration, not photographic or survey-accurate 3D imagery.
Buildings load as you explore and disappear when zoomed out or offline. Use the
home button to return to the full-region view.

## Run

```sh
npm install
npm start            # http://localhost:3000
```

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `AISSTREAM_API_KEY` | unset | Enables vessels (free key from https://aisstream.io) |

Requires Node 18+. The only dependency is `ws`. The server serves `public/` statically and exposes `GET /api/live`.

## API: `GET /api/live`

```json
{
  "generatedAt": "ISO time",
  "buses":  [{ "id", "lat", "lon", "bearing", "label", "route", "speedMps", "updated" }],
  "planes": [{ "id", "lat", "lon", "bearing", "label", "type", "altitudeFt", "speedKts", "onGround" }],
  "boats":  [{ "id", "lat", "lon", "bearing", "label", "speedKts" }],
  "weather": { "tempF", "feelsLikeF", "humidity", "precipIn", "cloudCover", "windMph", "windDirDeg",
               "windGustMph", "code", "condition", "isDay", "observedAt", "timezone", "alerts": [] },
  "status": { "buses|planes|boats|weather": { "state": "ok|connecting|unavailable", "message", "source", "updatedAt", "count" } },
  "region": { "center": {"lat","lon"}, "bounds": {"south","north","west","east"} }
}
```

- `bearing` is degrees clockwise from north, or `null` when unknown (e.g. a bus that has not moved since the server started).
- If a feed is down, its array is empty (weather becomes `{ "available": false, "alerts": [] }`) and `status.<feed>.state` is `unavailable` with a reason. Nothing is ever simulated.

## Data sources

| Feed | Source | Key? | Notes |
| --- | --- | --- | --- |
| Buses | LA Metro real-time WebSocket, `wss://api.metro.net/ws/LACMTA/vehicle_positions` (GTFS-realtime vehicle positions as JSON) | No | Server keeps a per-vehicle cache and drops vehicles silent for 5 min. |
| Aircraft | [adsb.lol](https://api.adsb.lol) `/v2/point` (55 nm around downtown), polled every 10 s; falls back to [OpenSky Network](https://opensky-network.org) anonymous API | No | Crowd-sourced ADS-B receivers. |
| Vessels | [AISStream.io](https://aisstream.io) WebSocket, bounding box = region | **Yes (free)** | See limitations. |
| Weather | [Open-Meteo](https://open-meteo.com) current conditions at downtown LA, every 10 min; active alerts from [NWS api.weather.gov](https://www.weather.gov/documentation/services-web-api) every 5 min | No | Open-Meteo's free tier is for non-commercial use. |

## Limitations

- **Buses:** only LA Metro buses. Metro's feed has no heading field, so `bearing` is derived from successive positions (moves over ~15 m). Municipal operators (Big Blue Bus, LADOT, Foothill, etc.) and Metro rail are not included. Metro's older `api.metro.net/LACMTA/vehicle_positions` REST endpoints and the Swiftly endpoint (`api.goswift.ly`, requires a key) are not used. The WebSocket is an undocumented-in-practice, best-effort endpoint and may change.
- **Vessels:** I found no free, keyless, real-time AIS source for the LA/Long Beach coast. Without `AISSTREAM_API_KEY`, `boats` is always `[]` and the status says so. With a key, AISStream's terrestrial coverage near ports is good but can be sparse offshore, and only vessels transmitting AIS (class A/B) appear.
- **Aircraft:** ADS-B only; aircraft without a transponder (or MLAT/blocked/privacy-filtered ones) are missing. Reported altitude is barometric. Public services may rate-limit; the OpenSky fallback is more restrictive.
- **Weather:** model-assisted point data for downtown LA, not a specific station observation, and one reading for the whole map.
- Data is held in memory only; restarting the server clears bus/vessel caches (buses refill within seconds).
