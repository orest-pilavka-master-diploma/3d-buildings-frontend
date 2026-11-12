# Building shadows — 3D front end

A browser app that shows the buildings of Lviv in 3D on an OpenStreetMap basemap and draws their
**sun shadows for any date and time**. You can also add your own buildings (draw them or upload
GeoJSON), edit them, and see whether they overlap existing ones.

Built with Vite, TypeScript, [MapLibre GL JS](https://maplibre.org/) for the map,
[Three.js](https://threejs.org/) for the 3D buildings and shadows, and
[SunCalc](https://github.com/mourner/suncalc) for the sun position. No UI framework.

```
osm-to-3d-geojson  ──►  3d-buildings-backend (:8082)  ──►  this front end (Vite, :5173)
 (builds tiles)          /tiles, /search, ...               /backend/* is proxied to :8082
```

---

## Contents

1. [Requirements](#1-requirements)
2. [Quick start](#2-quick-start)
3. [Configuration](#3-configuration)
4. [Scripts](#4-scripts)
5. [Using the app](#5-using-the-app)
6. [Backend API used](#6-backend-api-used)
7. [How it works](#7-how-it-works)
8. [Tuning](#8-tuning)
9. [Project structure](#9-project-structure)
10. [Production build and deployment](#10-production-build-and-deployment)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Requirements

| Requirement | Notes |
|-------------|-------|
| Node.js 22 with npm | Tested with Node 22.22. Install the LTS from [nodejs.org](https://nodejs.org/en/download). |
| A running `3d-buildings-backend` | Default `http://localhost:8082`. See its README. |
| A browser with WebGL 2 and module Web Workers | Current Chrome, Edge or Firefox. |
| Internet access | Basemap tiles come from `tile.openstreetmap.org`. |

---

## 2. Quick start

```powershell
cd "front - Copy - Copy"
npm install
Copy-Item .env.example .env      # only the first time; edit BACKEND_ORIGIN if needed
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). The map opens over Lviv with a tilted
3D view, and the buildings near the centre load first.

For address search to work, the backend must have indexed the buildings once
(`GET http://localhost:8082/index`, see the backend README).

---

## 3. Configuration

`.env` (copy from `.env.example`, not committed to git):

| Variable | Default | Meaning |
|----------|---------|---------|
| `BACKEND_ORIGIN` | `http://localhost:8082` | Where the Vite dev server forwards `/backend/*` requests. No trailing slash. |

Restart `npm run dev` after changing `.env`.

The browser never calls the backend directly. It calls same-origin `/backend/...` URLs, and Vite
(`vite.config.ts`) proxies them to `BACKEND_ORIGIN` with the `/backend` prefix removed. So
`/backend/tiles?...` becomes `http://localhost:8082/tiles?...`. This avoids CORS problems.

---

## 4. Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development server with hot reload. |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`). |
| `npm run build` | Typecheck, then production build into `dist/`. |
| `npm run preview` | Serves `dist/` locally, with the same `/backend` proxy, to check the build. |

The build prints a warning that a chunk is larger than 500 kB (MapLibre + Three.js). That is
expected and not an error.

**If `npm` is not recognized** but `node_modules` already exists, run the tools through Node:

```powershell
node node_modules\vite\bin\vite.js                 # npm run dev
node node_modules\typescript\bin\tsc --noEmit      # npm run typecheck
node node_modules\vite\bin\vite.js build           # build
```

---

## 5. Using the app

All labels in the app are in Ukrainian; the English meaning is given in brackets.

### 5.1 Map

- **Pan:** drag. **Zoom:** mouse wheel or the `+`/`−` buttons. **Rotate/tilt:** right-drag, or
  Ctrl + drag.
- **2D / 3D button** (bottom right): switches between a flat top-down plan and the tilted 3D view.
- **Legend** under it shows the three building colours:

  | Colour | Meaning |
  |--------|---------|
  | grey-brown `#9a938a` | Будівлі з бекенду (buildings from the backend) |
  | beige `#b8a894` | Додані вручну (drawn by you) |
  | grey-green `#8f9a94` | Завантажені з файлу (uploaded from a file) |

- **Click a backend building** to see a popup with its height and address. If the height is not
  real OSM data, the popup says so: *прогнозована* (predicted by the ML model) or
  *запасне значення* (fallback value).

### 5.2 Address search — «Адреса»

Type part of an address, for example `городоцька 355`. Results appear while you type (up to 5).
The backend matches whole words, word beginnings, parts of words and small typos. Choosing a
result places a marker and flies the map there. Clicking empty map space removes the marker.

### 5.3 Date and time

| Control | Use |
|---------|-----|
| **Дата** (date) | Opens a calendar. Arrow keys move by day/week, PageUp/PageDown by 4 weeks, `Esc` closes. **Сьогодні** jumps to today. |
| **Час** (time) slider | Any minute of the day. The track shows night, twilight and daylight for the selected date; sunrise and sunset are printed under it. |
| **Час** text field | Type `18:30`, `1830`, `18.30` or `18`. `↑`/`↓` = ±1 min, PageUp/PageDown = ±1 h, hold Shift for 60× steps. Always 24-hour. |
| **▶** and **Крок/с** | Plays the day forward: 1, 5, 15 or 60 minutes of sun time per real second. |
| **Реальний час** (real time) | Follows your system clock and updates every minute. Date and time controls are disabled while it is on. |

The box at the bottom shows the sun's altitude and azimuth. After sunset the map is dimmed, there
are no shadows, and windows light up.

### 5.4 Extra options — «Додаткові функції»

- **Фасади (вікна)** (facades/windows): turns the drawn windows and doors on or off. Off gives
  plain coloured blocks. Switching does not rebuild any geometry.

### 5.5 Your own buildings — «Власні об’єкти»

Your buildings exist **only in the browser tab**. They are lost on reload unless you save them as
GeoJSON.

**Add a building — «Додати будівлю»**, then choose a shape:

| Mode | How to draw |
|------|-------------|
| **Прямокутник** (rectangle) | Click the first corner, move the mouse, click again to finish. |
| **Власна фігура** (custom shape) | Click to add points, double-click to finish, `Backspace` removes the last point. |

`Esc` cancels drawing. After drawing, enter the height in metres (default 20) and press
**Додати** (add). The outline turns red while it overlaps another building. If it overlaps, the
app asks **Додати попри це?** (add anyway?).

**Edit a building:** click it. It turns blue and the edit card opens (top right):

- drag a **white point** to move that corner;
- drag the **blue centre point** to move the whole building;
- drag the **green point**, or the building itself, to rotate it;
- change **Висота** (height) or **Поворот** (rotation, degrees) in the card;
- **Ctrl+Z** undoes the last edit of the selected building (up to 50 steps);
- **Зберегти об’єкт як GeoJSON** downloads this one building;
- **Видалити** deletes it; **Готово** (done) or a click on empty map closes the card.

Buildings that overlap anything stay red until the overlap is fixed. The card shows how many
buildings it overlaps.

**Save all — «Зберегти всі як GeoJSON»** downloads all your buildings as
`custom-buildings-<yyyyMMdd-HHmmss>.geojson`.

**Upload — «Завантажити GeoJSON»** loads buildings from a file. The file must be:

- a GeoJSON `FeatureCollection`;
- every feature a `Polygon` or `MultiPolygon` (each polygon of a MultiPolygon becomes its own
  building; holes are ignored);
- every feature with a positive number `height` (metres); optional `minHeight` or `min_height`.

If any feature breaks these rules, the **whole file is rejected** with a message naming that
feature. Files saved by the app can be uploaded again. Example:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "height": 30 },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[24.0048, 49.8310], [24.0054, 49.8310], [24.0054, 49.8314], [24.0048, 49.8314], [24.0048, 49.8310]]]
      }
    }
  ]
}
```

Saved files contain the footprint with rotation applied, plus `height`, `minHeight`, `source`,
`rotationDeg`, `twistDeg` and `taper` in `properties`.

---

## 6. Backend API used

| Request (as sent by the browser) | Used for |
|----------------------------------|----------|
| `GET /backend/tiles/info` | Data version, stored geohash level, centre of the data. Called once on start. |
| `GET /backend/tiles?geohashes=u8c5dm,u8c5dt&version=v…` | Buildings of the given geohash cells. Called by the tile workers. |
| `GET /backend/search?q=…` | Address search. |
| `GET /backend/fetch-data` | Fallback only: all buildings in one file, used when `/tiles/info` fails. |

Building properties read from the backend GeoJSON: `height` (metres; if missing, `levels × 3`,
otherwise 10 m), `min_height`, `address` and `source`.

---

## 7. How it works

### 7.1 Loading buildings

On start the app reads `/tiles/info` and places the 3D scene at the data centre. Then
`TileController` (`src/tiling/tile-controller.ts`) runs after every move, zoom, rotate or tilt
(200 ms after the movement stops):

1. It computes the ground area actually visible on screen, including tilt and rotation
   (`src/tiling/viewport.ts`), and enlarges it a little so nearby tiles preload.
2. It lists the level-6 geohash cells covering that area, nearest to the centre first, at most 200.
3. It removes tiles that are no longer needed.
4. It requests the missing tiles in batches of 2, with up to 4 requests at a time.

Each batch is handled by a **Web Worker** (`src/tiling/tile-worker.ts`, 1–3 workers depending on
CPU cores). The worker downloads the batch, parses it, triangulates the footprints and computes the
facade texture coordinates (`src/tiling/tile-build.ts`). It sends back ready-made binary arrays, so
the page stays responsive while tiles load. Each tile appears as soon as its batch is done.

If you move the map again while tiles are loading, batches that have not been requested yet are
cancelled.

### 7.2 Drawing buildings

`ThreeBuildingsLayer` (`src/three-buildings-layer.ts`) is a MapLibre custom layer that renders a
Three.js scene into the map's WebGL context.

- **One mesh per tile.** All buildings of a tile share one geometry with three parts (roofs, upper
  walls, ground floor), so a tile costs 3 draw calls however many buildings it holds. Tiles outside
  the view are skipped.
- **No idle rendering.** The layer only renders when the map repaints (movement, new tiles, sun or
  edit changes).
- **Exact placement.** Coordinates are converted to metres with MapLibre's own Web Mercator
  formulas (`src/local-frame.ts`), so buildings, edit handles and markers line up exactly at any
  distance from the scene centre.
- **Click picking** first tests tile and building bounding boxes, then only the triangles of the
  buildings the click can hit.

### 7.3 Shadows

The sun direction comes from SunCalc for the selected date/time at the scene centre. A directional
light casts shadows onto a transparent ground plane over the basemap.

The shadow map (4096 px, or less if the GPU cannot) is fitted to what is on screen rather than to
the whole city, so shadows stay sharp when zoomed in. The fitted area is widened towards the sun so
buildings just off-screen still cast shadows into the view. It is snapped to whole shadow-map
pixels to stop flickering while panning, and redrawn only when the view or the sun changes.

### 7.4 Facades

Windows and doors are not modelled; they are three small textures drawn on canvases once at start
(`src/facade-texture.ts`):

- `day`: one window per 3 m × 3 m wall section, for all floors above the ground floor;
- `groundDay`: a door for the lowest 3 m, stretched so a door appears about every 12 m;
- `nightEmissive`: an 8 × 8 grid of windows, about half of them lit warm yellow at night.

`src/facade-uv.ts` splits each wall into a ground-floor part and an upper part and maps the
textures in real metres. Each building gets a different horizontal offset, so neighbours do not
show identical lit-window patterns.

### 7.5 Overlap detection

`src/editing/collision.ts` checks your buildings against the loaded backend buildings and each
other. A quick bounding-box test skips far-away buildings, then an exact polygon intersection
(`polygon-clipping`) decides. Touching edges do not count as overlap.

### 7.6 Basemap

OpenStreetMap standard raster tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
(max zoom 19), without an API key. The attribution "© OpenStreetMap contributors" must stay
visible. The OSM servers are meant for light use only
([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)); for a public
deployment, switch `OSM_TILES` in `src/main.ts` to your own or a commercial tile server.

---

## 8. Tuning

All loading parameters are constants at the top of `src/tiling/tile-controller.ts`:

| Constant | Default | Effect |
|----------|---------|--------|
| `STATIC_LEVEL` | `6` | Geohash level of requested tiles. `null` = choose by zoom (`ZOOM_LEVEL_TABLE`). Should not be finer than the backend's stored level (`geo.tiles.stored-level`). |
| `MAX_GEOHASHES_PER_LEVEL` | `{5: 40, 6: 200}` | Maximum tiles kept at once. Also limited by the backend's `maxGeohashes`. |
| `VIEWPORT_MARGIN_PCT_BY_LEVEL` | `{5: 0.15, 6: 0.5}` | How far beyond the screen tiles are preloaded. |
| `DEBOUNCE_MS` | `200` | Wait after movement stops before loading. |
| `TILES_PER_REQUEST` | `2` | Tiles per `/tiles` request. Smaller = nearest buildings appear sooner. |
| `MAX_CONCURRENT_REQUESTS` | `4` | Parallel `/tiles` requests. |

Other settings:

| Where | Setting |
|-------|---------|
| `src/main.ts` | Start position (`INITIAL_CENTER`, `zoom: 17`, `pitch: 65`, `bearing: -55`), basemap URL (`OSM_TILES`). |
| `src/three-buildings-layer.ts` | Building colours (`BUILDING_COLORS`), shadow map size (`PREFERRED_SHADOW_MAP_SIZE`), maximum shadow length (`MAX_SHADOW_REACH`, 1500 m). |
| `src/facade-texture.ts` | Window/door size and spacing, share of lit windows at night. |
| `src/styles.css` | Colours, radii and shadows of the panels, as CSS variables at the top of the file. |

---

## 9. Project structure

```
front - Copy - Copy/
├── index.html                  # page markup: map container, left panel, add/edit cards
├── vite.config.ts              # dev/preview server with the /backend proxy
├── package.json, tsconfig.json
├── .env.example                # copy to .env
└── src/
    ├── main.ts                 # app start: map, panels, search, editing, wiring
    ├── api.ts                  # backend requests and response checks
    ├── geojson.ts              # GeoJSON helpers (height, coordinates, escaping)
    ├── local-frame.ts          # lng/lat <-> local metres, matching MapLibre exactly
    ├── three-buildings-layer.ts# Three.js custom layer: meshes, shadows, picking, day/night
    ├── facade-texture.ts       # window/door/night textures drawn on canvases
    ├── facade-uv.ts            # wall texture coordinates and ground/upper wall split
    ├── datetime-panel.ts       # calendar, time slider, playback, real-time mode
    ├── styles.css
    ├── tiling/
    │   ├── tile-controller.ts  # which tiles to load/remove, batching, worker pool
    │   ├── tile-worker.ts      # Web Worker: fetch + build tile geometry
    │   ├── tile-build.ts       # merged tile geometry, collision rings, feature bucketing
    │   ├── geohash.ts          # geohash encode/decode, cells covering a polygon
    │   └── viewport.ts         # visible ground area of a tilted, rotated camera
    ├── editing/
    │   ├── draw-controller.ts  # drawing tools and the edit handles
    │   ├── user-objects-store.ts # in-memory list of your buildings
    │   ├── add-panel.ts, edit-panel.ts
    │   ├── collision.ts        # overlap checks, rotation of footprints
    │   ├── geojson-import.ts   # upload validation
    │   └── geojson-export.ts   # download as GeoJSON
    └── types/polygon-clipping.d.ts
```

---

## 10. Production build and deployment

```powershell
npm run build
```

This writes `dist/` (the page, the JavaScript bundle, the tile worker and CSS). `dist/` is a static
site, but the app still needs `/backend/*` forwarded to the Java backend with the prefix removed.
Static hosting alone cannot do this, so put a reverse proxy in front. Example for nginx:

```nginx
server {
    listen 80;
    root /var/www/front/dist;

    location / {
        try_files $uri /index.html;
    }

    # The trailing slashes strip the /backend prefix: /backend/tiles -> /tiles
    location /backend/ {
        proxy_pass http://localhost:8082/;
    }
}
```

`npm run preview` is for checking the build locally; it and `npm run dev` are not production
servers.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Panel says **Не вдалося завантажити будівлі з бекенду** (could not load buildings) | Both `/tiles/info` and `/fetch-data` failed. Start the backend and check `BACKEND_ORIGIN` in `.env`, then restart `npm run dev`. |
| Map loads but no buildings; panel says **Завантажено плиток: N** | The backend has no tiles for this area. Check its `GEO_TILES_ROOT`, or move the map to where the data is. |
| `Tile batch failed` in the browser console | A `/tiles` request failed. The tiles are retried on the next map move. Check the backend log. |
| Search shows no results | The backend index is empty or out of date. Run `GET http://localhost:8082/index`. |
| Uploaded file rejected | The message names the feature and the rule: it must be a FeatureCollection of Polygon/MultiPolygon features, each with a positive `height`. |
| Your buildings disappeared | They are kept only in memory. Save them with **Зберегти всі як GeoJSON** before reloading. |
| `npm` is not recognized | Install Node.js LTS (it includes npm) and open a new terminal, or use the `node node_modules\...` commands in [section 4](#4-scripts). |
| Basemap tiles load slowly or show errors | The public OSM servers are rate-limited. For heavy use switch to another tile server (`OSM_TILES` in `src/main.ts`). |
