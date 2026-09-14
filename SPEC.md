# CityGrow — 仕様書 (implementation contract)

A browser toy: a **Cities: Skylines–style city seen from a 3/4 overhead camera that grows by itself**.
The player does not build anything — they watch, move the camera, change sim speed and toggle options.

Quality bar: it should *look* like a miniature city game (soft sunlight, shadows, zoning colors, roads with
markings, cars, towers rising downtown, glowing windows at night), run at 60 fps on a MacBook, show visible
growth within the first 10 seconds, and fill most of the map in ~10–15 minutes at 1x.

---------------------------------------------------------------------------------------------------------

## 0. Tech & ground rules

- Plain ES modules, **no build step, no npm deps**. Three.js **r170** via importmap in `index.html`:
  `import * as THREE from 'three'` and `import { X } from 'three/addons/...'`.
- Serve: `python3 -m http.server 8123` from project root → http://localhost:8123
- **Sim layer is pure JS** (`src/config.js`, `src/core/*`, `src/sim/*`): no `three`, no DOM, no `Math.random`
  (use the seeded rng → same seed = same city). Must run under Node ≥ 20 (`node tests/sim.test.mjs`).
- Render/UI layer may use `Math.random` only for purely cosmetic things; prefer `hash2()` for stable per-cell variety.
- UI text is **Japanese**. Code comments: short, sparse, Japanese or English.
- Do **not** modify files you do not own (table below). If a contract seems wrong, work around it locally and
  report it in your final summary.

### File ownership

| File | Owner | Status |
|---|---|---|
| `index.html`, `src/main.js`, `src/config.js`, `src/core/events.js`, `src/core/rng.js`, `src/sim/world.js`, `SPEC.md` | foundation | **written — read them, don't change** |
| `src/sim/terrain-gen.js`, `src/sim/city.js`, `tests/sim.test.mjs` | sim | todo |
| `src/render/stage.js`, `src/render/terrain.js` | stage | todo |
| `src/render/roads.js`, `src/render/traffic.js` | roads | todo |
| `src/render/buildings.js` | buildings | todo |
| `src/ui/hud.js`, `style.css` | hud | todo |

---------------------------------------------------------------------------------------------------------

## 1. Coordinates & shared constants (`src/config.js`)

- Grid `GRID × GRID` cells (160). Cell `(x, z)`, `x` = column (east +), `z` = row (south +). `N` = −z.
- One cell = `CELL` world units (4). World origin at map center. Three.js: **Y up**.
  `cellToWorld(x, z)` → center of the cell. Map spans `[-GRID*CELL/2, +GRID*CELL/2]` on X and Z.
- `DIRS[i]` = N, E, S, W with `bit` 1, 2, 4, 8 (used for road connectivity masks).
- `rotationToAngle(r)`: building `rotation` r (0..3) means its **front faces `DIRS[r]`**.
  Build geometry with the front facing local **+Z**, then `rotation.y = rotationToAngle(r)`.
- Enums: `TILE {WATER, LAND}`, `ZONE {NONE, RES, COM, IND, PARK}`, `ROAD {NONE, STREET, AVENUE, HIGHWAY}`.
- `ZONE_COLORS` (Cities-style: residential green, commercial blue, industrial yellow, park green).

### Vertical layout (world Y)

| Thing | Y |
|---|---|
| Water surface plane | −0.6 |
| Terrain bottom under water cells | −1.8 |
| Land ground (every LAND cell is perfectly flat) | 0.00 |
| Zone overlay quads | 0.03 |
| Road tiles (also on bridges) | 0.06 |
| Cars (bottom) | 0.07 |
| Building base | 0.00 (they sit on the lot, overlay hidden under them) |

---------------------------------------------------------------------------------------------------------

## 2. World data model (`src/sim/world.js` — written)

Flat typed arrays indexed by `world.idx(x, z) = z * size + x`:

| Array | Type | Meaning |
|---|---|---|
| `terrain` | Uint8 | `TILE.*` |
| `road` | Uint8 | `ROAD.*` (0 = none). Road on a WATER cell = **bridge**. |
| `zone` | Uint8 | `ZONE.*` — lot zoning (a road cell is always `ZONE.NONE`) |
| `building` | Int32 | building id or −1 |
| `trees` | Uint8 | 0..3 trees on the cell (cosmetic forest) |
| `landValue` | Float32 | 0..1 (sim-maintained) |

Helpers: `inBounds`, `isWater`, `isLand`, `isRoad`, `roadMask(x,z)` (bits of neighbouring road cells —
**any two orthogonally adjacent road cells are connected**), `isVacantLot`, `forEachNeighbor`.

---------------------------------------------------------------------------------------------------------

## 3. Simulation (`src/sim/city.js`, `src/sim/terrain-gen.js`) — owner: sim

### 3.1 API (exact)

```js
// src/sim/terrain-gen.js
export function generateTerrain(world, seed) // fills world.terrain & world.trees; returns { center: {x, z} }

// src/sim/city.js
export class City {
  constructor({ seed })  // creates rng, events (Emitter), world (+terrain via generateTerrain).
                         // NO roads/zones/buildings yet, NO events emitted in the constructor.
  seed; rng; events; world;
  buildings;             // Map<number, Building>
  stats;                 // see 3.3 — same object mutated in place
  start();               // places highway + initial avenues from the center, emits events. Called once.
  update(simDt);         // simDt = real dt × speed (seconds). Accumulates and runs
                         // floor(acc × CONFIG.TICKS_PER_SECOND) ticks, max CONFIG.MAX_TICKS_PER_UPDATE per call.
  tick();
}
```

### 3.2 Building record (plain object, mutated in place on upgrade)

```js
{
  id,            // unique int, increasing
  x, z,          // cell
  zone,          // ZONE.RES | COM | IND | PARK
  level,         // 1..5  (IND max 3, PARK always 1)
  height,        // world units, top of main mass (PARK: 0)
  w, d,          // footprint width/depth as fraction of CELL (0.55..0.95); w along local X, d along local Z
  rotation,      // 0..3, front faces DIRS[rotation] — toward an adjacent road
  variant,       // int 0..999, stable random used by renderers for style/color choices
  createdTick,
}
```

Level table (capacities used for stats; heights in world units, pick uniformly in range, bias up by landValue):

| zone | L1 | L2 | L3 | L4 | L5 |
|---|---|---|---|---|---|
| RES residents | 4 | 15 | 45 | 120 | 280 |
| RES height | 2.5–3.5 | 5–8 | 10–16 | 20–34 | 38–64 |
| COM jobs | 5 | 18 | 50 | 130 | 320 |
| COM height | 3.5–5.5 | 7–11 | 16–26 | 30–48 | 52–90 |
| IND jobs | 20 | 45 | 90 | – | – |
| IND height | 4–6 | 6–9 | 8–12 | – | – |

Footprint: L1 houses small (0.55–0.75), mid (0.7–0.9), towers (0.6–0.85, towers are slimmer), industrial wide (0.8–0.95).

### 3.3 `city.stats` (mutated in place every tick)

```js
{
  tick,
  date: { year, month, day },          // month 1..12, day 1..30; starts CONFIG.START_YEAR/4/1
  population, jobs,
  buildings,                           // count (excluding parks)
  parks, roads,                        // counts (roads = road cells)
  zoneCounts: { res, com, ind },       // buildings per zone
  vacantLots,
  demand: { res, com, ind },           // 0..1 each (RCI bars)
  center: { x, z },                    // cell, city center
  radius,                              // current growth radius in cells
  tallest,                             // max building height (world units)
}
```

### 3.4 Events (`city.events`, an `Emitter`) — **state is already updated when an event fires**

| name | payload | notes |
|---|---|---|
| `road:add` | `{ x, z, type }` | new road cell (or type upgrade of an existing one). Neighbour connectivity changes too. |
| `zone:set` | `{ x, z, zone }` | lot zoned / rezoned / cleared (`ZONE.NONE`) |
| `trees:remove` | `{ x, z }` | `world.trees` of that cell already 0 |
| `building:add` | `{ building }` | new building (construction starts) |
| `building:upgrade` | `{ building, prevLevel }` | same id; level/height/w/d/variant may have changed |
| `building:remove` | `{ building }` | renderers must support it even if the sim rarely uses it |
| `log` | `{ text, kind }` | Japanese message for the HUD feed. kind: `'info' \| 'milestone'` |

Events can fire **hundreds of times per frame** at 8x. Renderers must batch (mark dirty, rebuild in `update`).

### 3.5 Growth design (guidance — tune freely, but keep the feel)

**Terrain** (`generateTerrain`): fbm noise (`createNoise2D`, `fbm`). One meandering **river** crossing the map
(noise-perturbed polyline, width 3–6 cells) plus a few lakes / maybe a coastline on one side. Roughly 15–25 %
water. Forests: fbm field → `trees` 1..3 on ~35 % of land. `center`: land cell near the map middle with no water
within radius 6. Deterministic from seed.

**Roads** — agent-based "road builders" on the 4-dir grid:
- Builder `{x, z, dir, type, stepsSinceBranch, remaining}`.
- `start()`: a HIGHWAY from the center to the nearest (or a random) map edge (bridges allowed, any length),
  and AVENUE builders from the center in the other directions.
- Step into `n = p + dir`:
  - out of bounds → stop. `n` is road → it just connected, stop.
  - `n` has a building → stop (never demolish).
  - either **perpendicular side neighbour** of `n` is road → stop (prevents ugly side-by-side parallel roads).
  - `n` is WATER → AVENUE/HIGHWAY may bridge if land is reached within ≤ 7 cells straight ahead (place the whole
    bridge), STREET stops.
  - `n` is outside the current growth radius → **defer** (keep the builder in a waiting list; revisit later).
  - otherwise place road (clear zone/trees on that cell with events), advance.
- Branching: AVENUE spawns perpendicular STREETs on both sides every `BLOCK` cells (≈5, varies by district noise
  4–7) with high probability; every ~4 blocks a perpendicular AVENUE instead. STREETs branch perpendicular STREETs
  every BLOCK cells with lower probability and have limited length (8–30). This yields city blocks.
- Pace: road steps per tick are demand-driven — few steps while plenty of vacant lots exist, more when vacant lots
  run low. The growth radius grows with population (e.g. `10 + sqrt(population) * k`, capped at map), so the city
  expands outward in rings instead of spraying roads across the map on day 1.

**Zoning**: when a road cell is placed, buildable land cells within distance ≤ 2 of it (not road, not zoned,
no building) get zoned. Type rule of thumb:
- COM: near the center (inner ~25 % of radius) and along AVENUEs with some probability; small COM clusters at
  AVENUE intersections in outer areas.
- IND: one or two industrial districts — low land value areas near the HIGHWAY and away from the center/water
  (use a noise field or a sector); never right next to the downtown.
- PARK: occasional (≈2–4 %), more likely near water and in forested cells.
- RES: everything else.

**Buildings**: each tick, sample a few random vacant lots (keep a vacant-lot set; never full-scan the grid per
tick) and build with probability based on `demand[zone]` and land value. Remove trees on the lot. Rotation faces
an adjacent road (prefer higher road class). **Upgrades**: each tick sample a few random buildings; if land value
and demand allow, level up (height grows). Tall towers only where land value is high (downtown, waterfront).

**Land value** (recompute every ~20 ticks, full grid OK): high near center, bonus near water & parks, penalty near
industry, small bonus along avenues.

**Demand** (RCI): residential demand rises when jobs > workers (≈ population × 0.5), commercial when population
outgrows commercial jobs, industrial when total jobs lag. Start with high R demand so houses appear immediately.

**Logs** (Japanese), e.g. `人口 1,000人 突破！` (milestones 500/1k/5k/10k/50k/100k/250k), `初の高層ビルが完成しました`,
`新しい橋が架けられました`, `工業地区の整備が始まりました`, yearly `2027年 になりました`. Not spammy (max ~1 per few sec).

### 3.6 Pacing targets (verify with `tests/sim.test.mjs`, 1x = 10 ticks/s)

| sim time | expectation |
|---|---|
| 10 s (100 ticks) | ≥ 15 buildings, roads visibly spreading |
| 60 s (600 ticks) | population 1,500 – 6,000 |
| 5 min (3,000 ticks) | population 20k – 70k, some L4+ towers exist |
| 15 min (9,000 ticks) | ≥ 50 % of reachable buildable land developed, population ≥ 100k |
| perf | mean tick < 1.5 ms at 9,000 ticks (Node, M-series Mac) |

---------------------------------------------------------------------------------------------------------

## 4. Rendering

### 4.1 `Stage` (`src/render/stage.js`) — owner: stage

```js
export class Stage {
  constructor(container)   // WebGLRenderer (antialias, shadows PCFSoft, ACESFilmic, sRGB), appended to container
  scene; camera; renderer; controls;       // PerspectiveCamera + MapControls (three/addons/controls/MapControls.js)
  cinematic;                               // boolean property (get/set)
  onUserCamera;                            // callback, set by main: called once when a user interaction turns cinematic off
  update(dt, { timeOfDay, focus: {x, z}, focusRadius })
      // → returns { night, daylight, sunDirection }  (night 0=day..1=deep night; daylight 0..1;
      //   sunDirection: THREE.Vector3 unit vector pointing toward the sun/moon)
  render();                                // uses EffectComposer + UnrealBloomPass (bloom stronger at night) + OutputPass
}
```

- `timeOfDay` ∈ [0,1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
- Sky: gradient background (dome or shader), day blue → dusk orange/pink → night deep navy with subtle stars.
  Fog color follows the sky. Hemisphere + directional sun (warm) / moon (cool, dim).
- **Shadows**: directional light shadow camera follows the camera target; half-extent ∝ camera distance
  (clamped ~40..450), mapSize 4096, tuned bias (no acne, no peter-panning on 2.5-unit houses).
- **Controls**: MapControls — left drag pan, right drag rotate, wheel zoom; clamp polar angle
  (~0.15π .. 0.45π), distance 25..900, keep target inside the map. Damping on.
- **Cinematic mode** (default on): target eases to `focus`, distance eases to ≈ `clamp(focusRadius*2.4, 70, 750)`,
  slow azimuth orbit (~0.04 rad/s), pleasant polar angle (~55° from vertical). Any user pointer/wheel interaction
  on the canvas turns it off (`cinematic=false`, then call `onUserCamera`).
- Resize handling, pixel ratio `min(devicePixelRatio, 2)`.

### 4.2 Views — common shape

```js
export class TerrainView  { constructor(scene, city); update(env); }  // src/render/terrain.js  — owner: stage
export class RoadView     { constructor(scene, city); update(env); }  // src/render/roads.js    — owner: roads
export class TrafficView  { constructor(scene, city); update(env); }  // src/render/traffic.js  — owner: roads
export class BuildingView { constructor(scene, city); update(env); }  // src/render/buildings.js — owner: buildings
```

- Views are constructed **before** `city.start()`, but must still build from the current world state in the
  constructor (don't assume an empty world), then subscribe to `city.events`.
- `env` (built by `main.js` every frame):
  `{ dt, simDt, speed, timeOfDay, night, daylight, sunDirection, camera }`
  — `dt` real seconds (≤0.1), `simDt = dt × speed` (0 when paused).

**TerrainView**: heightfield mesh (GRID+1)² vertices; a vertex is lowered to −1.8 only if **all** adjacent cells are
water (so land cells stay perfectly flat and shores slope inside water cells). Vertex colors: grass with subtle noise
variation, sandy/darker shore band. Water: a map-sized plane at −0.6, slightly transparent, gentle animated
shimmer (cheap shader or normal wobble), reflects sky tint, darker at night. Outer ground skirt beyond the map edge so
the world doesn't end in a void (fog hides the far edge). Trees: InstancedMesh (low-poly cone/sphere canopy + trunk,
color variation), up to `trees[i]` per cell with stable jitter; `trees:remove` hides that cell's instances.
**Zone overlays**: translucent tinted quads (ZONE_COLORS, α≈0.35, thin darker border/grid look) on zoned cells
**without** a building; update on `zone:set` / `building:add` / `building:remove` (batched).

**RoadView**: tiles per road cell chosen from `roadMask` (dead end / straight / corner / T / cross, rotated) with
canvas-generated textures: asphalt, sidewalk/curb edges where there is no connection, lane markings
(STREET: white dashed center; AVENUE: wider look with double yellow center; HIGHWAY: darker, multiple dashed lanes,
guardrail edge). Bridges (road on WATER): deck slab under the tile + pillars down to −1.8. Street lamps optional
(tiny emissive instances along avenues at night). Suggested approach: on dirty, fully rebuild all road instance
matrices (≤ ~10k cells) at most ~5×/s. `road:add` affects the cell and its 4 neighbours.

**TrafficView**: InstancedMesh cars (simple low-poly car shape, bright varied colors, capacity ~2000). Each car walks
the road graph cell→cell (random turn, avoid U-turns except dead ends), **left-hand traffic** (Japan) with a lane
offset from the road center line, smooth turning, speed ∝ `env.simDt` (stop when paused). Car count ≈
`clamp(population / 20, 8, 1800)` limited by road cells × 0.35; spawn gradually, despawn gracefully. Headlight/taillight
glow at night (emissive, bloom picks it up).

**BuildingView**: one InstancedMesh per archetype (plus extra meshes for roofs/chimneys etc.). Archetypes derived from
`(zone, level)`:
- RES L1 house (box + gable roof, warm roof colors) · RES L2 low apartment · RES L3 apartment block · RES L4–5 tower
- COM L1–2 shop (flat roof, storefront band) · COM L3 mid-rise office · COM L4–5 glass skyscraper (crown/antenna on tall ones)
- IND L1–3 factory (sawtooth or flat roof) + chimney/silo variants, muted yellow/grey/brown
- PARK: lawn square with path + a few round trees
- Facade color from `variant` + zone palette. Unit geometries scaled per instance (`w*CELL, height, d*CELL`), rotated by
  `rotationToAngle(rotation)`, placed at `cellToWorld(x,z)`.
- **Procedural windows** via `material.onBeforeCompile`: compute world position/normal per fragment (instanceMatrix
  aware), window grid on vertical faces only (no windows on roofs), darker glass by day; at night a stable-random
  subset of windows emits warm light scaled by a `uNight` uniform (bloom makes them glow). Glass skyscrapers: denser,
  cooler windows.
- **Construction animation**: on add/upgrade the building rises (scale Y 0→1 with a little ease-out overshoot) over
  ~1.2 s, progress += `min(env.simDt, env.dt*2) / 1.2` (freezes when paused). Upgrades: re-rise from old height to new
  (or from 0) in the new archetype.
- Persistent instance slots with **swap-remove**; only animating instances update matrices each frame.
- castShadow + receiveShadow on buildings; trees castShadow.

### 4.3 Performance rules (all render modules)

- InstancedMesh for anything repeated. Never one `Mesh` per building/tree/car/road cell.
- `frustumCulled = false` on InstancedMeshes (their bounding spheres go stale as instances change).
- No allocations in per-frame loops (reuse Matrix4/Vector3/Quaternion/Color). Batch event work into `update()`.
- Grow capacity by reallocating a bigger InstancedMesh when full (don't silently drop instances).

---------------------------------------------------------------------------------------------------------

## 5. HUD (`src/ui/hud.js`, `style.css`) — owner: hud

```js
export class Hud {
  constructor(rootEl, { onSpeed(index), onToggleCinematic(), onToggleDayCycle(), onNewCity() })
  update(stats, ui)   // ui: { speedIndex, cinematic, dayCycle, timeOfDay, seed, fps }. Called every frame —
                      // throttle DOM writes (~8×/s) and only write changed text.
  log(text, kind)     // push to the event feed (kind 'info' | 'milestone')
}
```

- Builds its DOM inside `#hud` (which is `position:fixed; inset:0; pointer-events:none` — re-enable pointer events
  on panels only, so the canvas stays draggable).
- Top-left panel: city name (deterministic from seed, e.g. 「青葉台市」「桜ヶ丘市」), rank by population
  (<300 集落, <1,500 村, <8,000 町, <40,000 市, <150,000 大都市, else メガロポリス), date `2026年 4月 1日`,
  clock icon/time from `timeOfDay` (e.g. `06:30`), population (formatted with commas), jobs, buildings, tallest height.
- Top-right: speed buttons (⏸ / ▶ / ▶▶ / ▶▶▶ → indices 0..3), toggles: 🎥 シネマティック, 🌗 昼夜サイクル, 🎲 新しい街.
  Active state styling reflects `ui`.
- Bottom-left: RCI demand bars (R green, C blue, I yellow; vertical bars like Cities: Skylines).
- Bottom-right: event log feed (last ~6, newest on top, fade in; milestones highlighted).
- Bottom-center: small hint `左ドラッグ: 移動 ・ 右ドラッグ: 回転 ・ ホイール: ズーム ・ Space: 一時停止`.
- Keyboard: Space = pause/resume (resume to last non-zero speed), 1/2/3 = speeds, C = cinematic, N = day cycle.
- Style: dark translucent glass panels (backdrop-filter blur), rounded, crisp typography
  (system-ui / "Hiragino Sans"), tabular numbers, subtle shadows. Unobtrusive — the city is the star.
  Responsive: panels shrink on narrow screens.

---------------------------------------------------------------------------------------------------------

## 6. Wiring (`src/main.js` — written)

`City` → `Stage` → views (Terrain, Road, Building, Traffic) → `Hud` → `city.start()` → rAF loop:
`city.update(simDt)` → advance timeOfDay → `stage.update(...)` → `view.update(env)` for each view →
`hud.update(stats, ui)` → `stage.render()`. Errors are shown in `#fatal`. Debug handles: `window.__city`,
`window.__stage`.
