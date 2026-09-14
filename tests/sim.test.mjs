// シミュレーション検証: node tests/sim.test.mjs  （MAP=all で全シードの地図、SEEDS=1,2,3 でシード指定）
import { City } from '../src/sim/city.js';
import { CONFIG, TILE, ZONE, ROAD, DIRS } from '../src/config.js';

const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [12345, 777, 2026];
const CHECKPOINTS = [100, 600, 3000, 9000];
const TICKS = 9000;
const EVENT_NAMES = ['road:add', 'zone:set', 'trees:remove', 'building:add', 'building:upgrade', 'building:remove', 'log'];
const CAP = {
  [ZONE.RES]: [4, 15, 45, 120, 280],
  [ZONE.COM]: [5, 18, 50, 130, 320],
  [ZONE.IND]: [20, 45, 90],
};

const HEIGHT = {
  [ZONE.RES]: [[2.5, 3.5], [5, 8], [10, 16], [20, 34], [38, 64]],
  [ZONE.COM]: [[3.5, 5.5], [7, 11], [16, 26], [30, 48], [52, 90]],
  [ZONE.IND]: [[4, 6], [6, 9], [8, 12]],
};

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL: ${msg}`);
};
const check = (cond, msg) => {
  if (!cond) fail(msg);
  return cond;
};

function snapshot(city) {
  const s = city.stats;
  const hist = [0, 0, 0, 0, 0];
  for (const b of city.buildings.values()) if (b.zone !== ZONE.PARK) hist[b.level - 1]++;
  return {
    tick: s.tick,
    date: `${s.date.year}/${s.date.month}/${s.date.day}`,
    pop: s.population,
    jobs: s.jobs,
    bld: s.buildings,
    parks: s.parks,
    roads: s.roads,
    vacant: s.vacantLots,
    dR: s.demand.res.toFixed(2),
    dC: s.demand.com.toFixed(2),
    dI: s.demand.ind.toFixed(2),
    radius: s.radius.toFixed(1),
    tallest: s.tallest.toFixed(1),
    zc: `${s.zoneCounts.res}/${s.zoneCounts.com}/${s.zoneCounts.ind}`,
    levels: hist.join('/'),
  };
}

function checkInvariants(city, label) {
  const w = city.world;
  const N = w.size;
  const s = city.stats;
  let errs = 0;
  const e = (msg) => {
    if (errs++ < 8) fail(`[${label}] ${msg}`);
  };

  let buildingCells = 0;
  let vacant = 0;
  let roads = 0;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, z);
      if (w.road[i] !== ROAD.NONE) {
        roads++;
        if (w.building[i] !== -1) e(`road on building cell (${x},${z})`);
        if (w.zone[i] !== ZONE.NONE) e(`zone on road cell (${x},${z})`);
        if (w.trees[i] !== 0) e(`trees on road cell (${x},${z})`);
      }
      if (w.building[i] !== -1) {
        buildingCells++;
        const b = city.buildings.get(w.building[i]);
        if (!b) e(`world.building id ${w.building[i]} not in map`);
        else if (b.x !== x || b.z !== z) e(`building ${b.id} position mismatch`);
        if (w.trees[i] !== 0) e(`trees under building (${x},${z})`);
      }
      if (w.zone[i] !== ZONE.NONE && w.terrain[i] !== TILE.LAND) e(`zone on water (${x},${z})`);
      if (w.isZonedVacant(x, z)) vacant++;
      // 2x2 の道路ブロック（平行道路の隣接）
      if (x < N - 1 && z < N - 1 && w.road[i] && w.road[i + 1] && w.road[i + N] && w.road[i + N + 1]) {
        e(`2x2 road square at (${x},${z})`);
      }
    }
  }
  check(roads === s.roads, `[${label}] stats.roads ${s.roads} != ${roads}`);
  check(vacant === s.vacantLots, `[${label}] stats.vacantLots ${s.vacantLots} != ${vacant}`);
  check(buildingCells === city.buildings.size, `[${label}] building cells ${buildingCells} != map size ${city.buildings.size}`);

  let pop = 0;
  let jobs = 0;
  let nb = 0;
  let parks = 0;
  let tallest = 0;
  const zc = { res: 0, com: 0, ind: 0 };
  let lastId = 0;
  for (const b of city.buildings.values()) {
    const i = w.idx(b.x, b.z);
    if (w.building[i] !== b.id) e(`building ${b.id}: world.building mismatch`);
    if (w.zone[i] !== b.zone) e(`building ${b.id}: zone ${w.zone[i]} != ${b.zone}`);
    if (w.roadMask(b.x, b.z) === 0) e(`building ${b.id} at (${b.x},${b.z}) not adjacent to road`);
    const fd = DIRS[b.rotation];
    if (!w.isRoad(b.x + fd.dx, b.z + fd.dz)) e(`building ${b.id} rotation ${b.rotation} does not face a road`);
    if (b.id <= lastId) e(`building ids not increasing`);
    lastId = b.id;
    if (!(b.w >= 0.55 && b.w <= 0.95 && b.d >= 0.55 && b.d <= 0.95)) e(`building ${b.id} footprint ${b.w}x${b.d}`);
    if (!(b.variant >= 0 && b.variant <= 999 && Number.isInteger(b.variant))) e(`building ${b.id} variant ${b.variant}`);
    if (b.zone !== ZONE.PARK && HEIGHT[b.zone]) {
      const [lo, hi] = HEIGHT[b.zone][b.level - 1] || [0, 0];
      if (!(b.height >= lo - 1e-9 && b.height <= hi + 1e-9)) e(`building ${b.id} zone ${b.zone} L${b.level} height ${b.height} outside ${lo}..${hi}`);
    }
    if (b.zone === ZONE.PARK) {
      parks++;
      if (b.level !== 1 || b.height !== 0) e(`park ${b.id} level/height`);
      continue;
    }
    nb++;
    const cap = CAP[b.zone];
    if (b.level < 1 || b.level > cap.length) e(`building ${b.id} level ${b.level} out of range for zone ${b.zone}`);
    if (b.zone === ZONE.RES) {
      pop += cap[b.level - 1];
      zc.res++;
    } else {
      jobs += cap[b.level - 1];
      if (b.zone === ZONE.COM) zc.com++;
      else zc.ind++;
    }
    if (b.height > tallest) tallest = b.height;
  }
  check(pop === s.population, `[${label}] population ${s.population} != ${pop}`);
  check(jobs === s.jobs, `[${label}] jobs ${s.jobs} != ${jobs}`);
  check(nb === s.buildings, `[${label}] buildings ${s.buildings} != ${nb}`);
  check(parks === s.parks, `[${label}] parks ${s.parks} != ${parks}`);
  check(Math.abs(tallest - s.tallest) < 1e-9, `[${label}] tallest ${s.tallest} != ${tallest}`);
  check(zc.res === s.zoneCounts.res && zc.com === s.zoneCounts.com && zc.ind === s.zoneCounts.ind, `[${label}] zoneCounts`);
  for (const k of ['res', 'com', 'ind']) {
    check(s.demand[k] >= 0 && s.demand[k] <= 1, `[${label}] demand.${k} out of range`);
  }

  // 道路網の連結性（中心から BFS）
  const seen = new Uint8Array(N * N);
  const stack = [w.idx(s.center.x, s.center.z)];
  seen[stack[0]] = 1;
  let reached = 0;
  while (stack.length) {
    const i = stack.pop();
    reached++;
    const x = i % N;
    const z = (i / N) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const nz = z + d.dz;
      if (!w.inBounds(nx, nz)) continue;
      const j = w.idx(nx, nz);
      if (!seen[j] && w.road[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  check(reached === roads, `[${label}] road network disconnected: reached ${reached}/${roads}`);
  return errs === 0;
}

function asciiMap(city, size = 80) {
  const w = city.world;
  const c = city.stats.center;
  const x0 = Math.max(0, Math.min(w.size - size, c.x - size / 2));
  const z0 = Math.max(0, Math.min(w.size - size, c.z - size / 2));
  const lines = [];
  for (let z = z0; z < z0 + size; z++) {
    let line = '';
    for (let x = x0; x < x0 + size; x++) {
      const i = w.idx(x, z);
      const r = w.road[i];
      let ch;
      if (r) ch = w.terrain[i] === TILE.WATER ? '=' : r === ROAD.HIGHWAY ? '#' : r === ROAD.AVENUE ? '+' : '.';
      else if (w.terrain[i] === TILE.WATER) ch = '~';
      else if (w.building[i] !== -1) {
        const b = city.buildings.get(w.building[i]);
        const z1 = b.zone;
        if (z1 === ZONE.PARK) ch = 'p';
        else {
          const hi = b.level >= 3;
          ch = z1 === ZONE.RES ? (hi ? 'R' : 'r') : z1 === ZONE.COM ? (hi ? 'C' : 'c') : hi ? 'I' : 'i';
          if (b.level >= 4) ch = z1 === ZONE.RES ? 'H' : 'T';
        }
      } else if (w.zone[i] !== ZONE.NONE) ch = '_';
      else if (w.trees[i]) ch = '"';
      else ch = ' ';
      line += ch;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function coarseMap(city) {
  const w = city.world;
  const lines = [];
  for (let z = 0; z < w.size; z += 2) {
    let line = '';
    for (let x = 0; x < w.size; x += 2) {
      let water = 0;
      let road = 0;
      let bld = 0;
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = w.idx(x + dx, z + dz);
        if (w.terrain[i] === TILE.WATER && !w.road[i]) water++;
        if (w.road[i]) road++;
        if (w.building[i] !== -1) bld++;
      }
      line += water >= 3 ? '~' : bld >= 2 ? '#' : bld + road >= 2 ? '+' : road ? '.' : water ? '~' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function developedStats(city) {
  const w = city.world;
  const N = w.size;
  let zonedOrBuilt = 0;
  let built = 0;
  let frontage = 0;
  let frontageBuilt = 0;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, z);
      if (w.building[i] !== -1) built++;
      if (w.zone[i] !== ZONE.NONE) zonedOrBuilt++;
      if (w.terrain[i] === TILE.LAND && !w.road[i] && w.roadMask(x, z) && !(w.zone[i] === ZONE.NONE && w.building[i] === -1 && onlyHighway(w, x, z))) {
        frontage++;
        if (w.building[i] !== -1) frontageBuilt++;
      }
    }
  }
  // 見た目の品質指標: 行き止まり、1セル幅の区画、道路の無い孤立区画
  let deadEnds = 0;
  let slivers = 0;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, z);
      if (w.road[i]) {
        const m = w.roadMask(x, z);
        if (m === 1 || m === 2 || m === 4 || m === 8) {
          const edge = x === 0 || z === 0 || x === N - 1 || z === N - 1;
          if (!edge) deadEnds++;
        }
      } else if (w.terrain[i] === TILE.LAND && (w.zone[i] !== ZONE.NONE || w.building[i] !== -1)) {
        const m = w.roadMask(x, z);
        if ((m & 5) === 5 || (m & 10) === 10) slivers++;
      }
    }
  }
  return { lotsBuilt: built / Math.max(1, zonedOrBuilt), landBuilt: reachableLandBuilt(city), frontageBuilt: frontageBuilt / Math.max(1, frontage), built, zonedOrBuilt, deadEnds, slivers };
}

// SPEC 3.6「到達可能な建築可能地の開発率」: 分母 = 中心から陸路（≤ MAX_BRIDGE の水面は橋で渡れる）で到達できる
// 計画道路以外の陸地セル、分子 = そのうち建物のあるセル。道路が届かず区画化されない土地も分母に入る。
const MAX_BRIDGE = 7;
function reachableLandBuilt(city) {
  const w = city.world;
  const N = w.size;
  const plan = city._plan;
  const seen = new Uint8Array(N * N);
  const stack = [w.idx(city.stats.center.x, city.stats.center.z)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % N;
    const z = (i / N) | 0;
    for (const d of DIRS) {
      let nx = x + d.dx;
      let nz = z + d.dz;
      for (let k = 0; k < MAX_BRIDGE && w.inBounds(nx, nz) && w.terrain[w.idx(nx, nz)] === TILE.WATER; k++) {
        nx += d.dx;
        nz += d.dz;
      }
      if (!w.inBounds(nx, nz)) continue;
      const j = w.idx(nx, nz);
      if (w.terrain[j] === TILE.LAND && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  let land = 0;
  let built = 0;
  for (let i = 0; i < N * N; i++) {
    if (!seen[i] || (plan && plan[i] !== ROAD.NONE)) continue;
    land++;
    if (w.building[i] !== -1) built++;
  }
  return built / Math.max(1, land);
}

function onlyHighway(w, x, z) {
  for (const d of DIRS) {
    const nx = x + d.dx;
    const nz = z + d.dz;
    if (w.inBounds(nx, nz)) {
      const r = w.road[w.idx(nx, nz)];
      if (r && r !== ROAD.HIGHWAY) return false;
    }
  }
  return true;
}

function worldHash(city) {
  const w = city.world;
  let h = 2166136261;
  for (const arr of [w.road, w.zone, w.trees]) {
    for (let i = 0; i < arr.length; i++) h = Math.imul(h ^ arr[i], 16777619);
  }
  for (let i = 0; i < w.building.length; i++) h = Math.imul(h ^ w.building[i], 16777619);
  for (const b of city.buildings.values()) {
    h = Math.imul(h ^ b.level, 16777619);
    h = Math.imul(h ^ Math.round(b.height * 1000), 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------
// 高さプロファイル（スカイラインの勾配・タワーの出現ペース）
// ---------------------------------------------------------------------------------------------

const PROFILE_TICKS = [600, 1500, 3000, 9000];
const BAND = 5;
const TALLEST_POPS = [1000, 2000, 5000, 8000, 10000, 15000, 20000, 30000, 40000, 60000, 100000];

function heightProfile(city) {
  const c = city.stats.center;
  const levels = [0, 0, 0, 0, 0];
  const bands = [];
  let worstRatio = 0;
  let slender = 0;
  let towers = 0;
  for (const b of city.buildings.values()) {
    if (b.zone === ZONE.PARK) continue;
    levels[b.level - 1]++;
    const d = Math.hypot(b.x - c.x, b.z - c.z);
    const k = Math.floor(d / BAND);
    const e = bands[k] || (bands[k] = { n: 0, sum: 0, max: 0, tall: 0 });
    e.n++;
    e.sum += b.height;
    if (b.height > e.max) e.max = b.height;
    if (b.height >= 20) e.tall++;
    if (b.level >= 4) {
      towers++;
      const r = b.height / (Math.min(b.w, b.d) * CONFIG.CELL);
      if (r > worstRatio) worstRatio = r;
      if (r > 20) slender++;
    }
  }
  return { levels, bands, worstRatio, slender, towers };
}

function printProfile(seed, tick, pop, p) {
  console.log(`  [seed ${seed} t${tick}] pop ${pop}  levels L1..L5 ${p.levels.join('/')}  towers(L4+) ${p.towers}  worst h/w ${p.worstRatio.toFixed(1)} (>20: ${p.slender})`);
  const cells = [];
  for (let k = 0; k < p.bands.length; k++) {
    const e = p.bands[k];
    if (!e || e.n === 0) continue;
    cells.push(`${String(k * BAND).padStart(2)}-${String((k + 1) * BAND).padEnd(3)} n${String(e.n).padStart(4)} mean${(e.sum / e.n).toFixed(1).padStart(5)} max${e.max.toFixed(0).padStart(3)} ≥20:${String(e.tall).padStart(3)}`);
  }
  for (let i = 0; i < cells.length; i += 3) console.log('    ' + cells.slice(i, i + 3).join('  |  '));
}

// 都心（半径 r 以内）の高さのばらつき
function coreStats(city, r) {
  const c = city.stats.center;
  const hs = [];
  let parks = 0;
  for (const b of city.buildings.values()) {
    if (Math.hypot(b.x - c.x, b.z - c.z) > r) continue;
    if (b.zone === ZONE.PARK) parks++;
    else hs.push(b.height);
  }
  const n = hs.length || 1;
  const mean = hs.reduce((a, h) => a + h, 0) / n;
  const sd = Math.sqrt(hs.reduce((a, h) => a + (h - mean) * (h - mean), 0) / n);
  return { n: hs.length, mean, sd, cv: sd / (mean || 1), lowFrac: hs.filter((h) => h < 20).length / n, parks };
}

function run(seed, { printMap = false, quiet = false } = {}) {
  const city = new City({ seed });
  const counts = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0]));
  // タワー出現ペースの記録
  const hp = { firstL4: null, firstL5: null, tallest2k: 0, tallest8k: 0, over16at8k: 0, capViolations: [], profiles: [], tallestAt: {}, rebuilds: 0 };
  const onLevel = (b) => {
    if (b.zone !== ZONE.RES && b.zone !== ZONE.COM) return;
    if (b.level >= 4 && !hp.firstL4) hp.firstL4 = { pop: city.stats.population, tick: city.stats.tick };
    if (b.level >= 5 && !hp.firstL5) hp.firstL5 = { pop: city.stats.population, tick: city.stats.tick };
  };
  city.events.on('building:add', (p) => onLevel(p.building));
  city.events.on('building:remove', (p) => {
    if (p.building.level >= 4) hp.rebuilds++;
  });
  city.events.on('building:upgrade', (p) => onLevel(p.building));
  let preStartEvents = 0;
  const logs = [];
  let payloadErrors = 0;
  const perr = (msg) => {
    if (payloadErrors++ < 5) fail(`[seed ${seed}] ${msg}`);
  };
  for (const name of EVENT_NAMES) {
    city.events.on(name, (p) => {
      counts[name]++;
      if (!city._started) preStartEvents++;
      const w = city.world;
      switch (name) {
        case 'road:add':
          if (w.road[w.idx(p.x, p.z)] !== p.type) perr(`road:add state not updated`);
          break;
        case 'zone:set':
          if (w.zone[w.idx(p.x, p.z)] !== p.zone) perr(`zone:set state not updated`);
          break;
        case 'trees:remove':
          if (w.trees[w.idx(p.x, p.z)] !== 0) perr(`trees:remove state not updated`);
          break;
        case 'building:add':
          if (w.building[w.idx(p.building.x, p.building.z)] !== p.building.id) perr(`building:add state not updated`);
          break;
        case 'building:upgrade':
          if (!(p.building.level === p.prevLevel + 1)) perr(`building:upgrade prevLevel mismatch`);
          break;
        case 'log':
          if (typeof p.text !== 'string' || (p.kind !== 'info' && p.kind !== 'milestone')) perr(`bad log payload`);
          logs.push({ tick: city.stats.tick, ...p });
          break;
      }
    });
  }
  check(preStartEvents === 0 && city.stats.roads === 0, `[seed ${seed}] constructor must not create roads/events`);
  city.start();
  const snaps = [];
  let tickMs = 0;
  let lateMs = 0;
  let worst = 0;
  let maxEvents = 0;
  const totalEvents = () => EVENT_NAMES.reduce((a, n) => a + counts[n], 0);
  for (let t = 1; t <= TICKS; t++) {
    const ev0 = totalEvents();
    const t0 = performance.now();
    city.tick();
    maxEvents = Math.max(maxEvents, totalEvents() - ev0);
    const dt = performance.now() - t0;
    tickMs += dt;
    if (t > TICKS - 1000) lateMs += dt;
    if (dt > worst) worst = dt;
    if (CHECKPOINTS.includes(t)) snaps.push(snapshot(city));
    {
      const pop = city.stats.population;
      if (pop < 2000) hp.tallest2k = Math.max(hp.tallest2k, city.stats.tallest);
      for (const m of TALLEST_POPS) if (pop >= m && hp.tallestAt[m] === undefined) hp.tallestAt[m] = city.stats.tallest;
      if (pop < 8000) {
        hp.tallest8k = Math.max(hp.tallest8k, city.stats.tallest);
        if (t % 5 === 0) {
          let over = 0;
          for (const b of city.buildings.values()) if (b.height > 16) over++;
          hp.over16at8k = Math.max(hp.over16at8k, over);
        }
      }
      if (t % 50 === 0) {
        const lv = [0, 0, 0, 0, 0, 0];
        for (const b of city.buildings.values()) if (b.zone === ZONE.RES || b.zone === ZONE.COM) lv[b.level]++;
        if (lv[5] > pop / 1500 + 1 || lv[4] > pop / 800 + 1) hp.capViolations.push(`t${t} pop ${pop} L4 ${lv[4]} L5 ${lv[5]}`);
      }
      if (PROFILE_TICKS.includes(t)) hp.profiles.push({ tick: t, pop, ...heightProfile(city) });
    }
    if (t === 3000) {
      checkInvariants(city, `seed ${seed} t3000`);
      if (printMap) {
        console.log(`\n--- seed ${seed}: central 80x80 at tick 3000 ---`);
        console.log('legend: # highway  + avenue  . street  = bridge  ~ water  _ zoned vacant  " trees');
        console.log('        r/c/i L1-2  R/C/I L3  H res L4-5  T com L4-5  p park');
        console.log(asciiMap(city));
      }
    }
  }
  checkInvariants(city, `seed ${seed} t9000`);
  const dev = developedStats(city);
  return { city, snaps, counts, logs, hp, meanMs: tickMs / TICKS, lateMs: lateMs / 1000, worst, dev, maxEvents, hash: worldHash(city) };
}

function table(rows) {
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padStart(widths[i])).join(' ');
  console.log(fmt(keys));
  for (const r of rows) console.log(fmt(keys.map((k) => r[k])));
}

// ---------------------------------------------------------------------------------------------

console.log(`CityGrow sim test — GRID ${CONFIG.GRID}, ${TICKS} ticks, seeds ${SEEDS.join(', ')}`);

// update() の tick 数
{
  const c = new City({ seed: 1 });
  c.start();
  const n1 = c.update(1.0);
  check(n1 === 10 && c.stats.tick === 10, `update(1.0) ran ${n1} ticks (expected 10)`);
  const n2 = c.update(100);
  check(n2 === CONFIG.MAX_TICKS_PER_UPDATE, `update(100) ran ${n2} ticks (expected ${CONFIG.MAX_TICKS_PER_UPDATE})`);
  let total = 0;
  for (let i = 0; i < 60; i++) total += c.update(1 / 60);
  check(total >= 9 && total <= 11, `60 x update(1/60) ran ${total} ticks (expected ~10)`);
  check(c.update(0) === 0, 'update(0) must not tick');
}

const results = [];
for (const seed of SEEDS) {
  const r = run(seed, { printMap: seed === SEEDS[0] || process.env.MAP === 'all' });
  results.push({ seed, ...r });
}

for (const r of results) {
  console.log(`\n=== seed ${r.seed} ===`);
  table(r.snaps);
  console.log(
    `mean tick ${r.meanMs.toFixed(3)} ms (last 1000: ${r.lateMs.toFixed(3)} ms, worst ${r.worst.toFixed(2)} ms)  ` +
      `land built ${(r.dev.landBuilt * 100).toFixed(1)}%  lots built ${(r.dev.lotsBuilt * 100).toFixed(1)}%  frontage built ${(r.dev.frontageBuilt * 100).toFixed(1)}%  ` +
      `dead-ends ${r.dev.deadEnds}  1-wide lots ${r.dev.slivers}`,
  );
  console.log('events:', Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join('  '), ` (max ${r.maxEvents}/tick)`);
  console.log(`logs (${r.logs.length}):`, r.logs.slice(0, 40).map((l) => `[${l.tick}${l.kind === 'milestone' ? '*' : ''}] ${l.text}`).join(' | '));

  // ペース目標
  const at = (t) => r.snaps.find((s) => s.tick === t);
  const s100 = at(100);
  const s600 = at(600);
  const s3000 = at(3000);
  const s9000 = at(9000);
  const lv = (s) => s.levels.split('/').map(Number);
  check(s100.bld >= 15, `[seed ${r.seed}] pacing 100 ticks: buildings ${s100.bld} < 15`);
  check(s600.pop >= 1500 && s600.pop <= 6000, `[seed ${r.seed}] pacing 600 ticks: population ${s600.pop} not in 1500..6000`);
  check(s3000.pop >= 20000 && s3000.pop <= 70000, `[seed ${r.seed}] pacing 3000 ticks: population ${s3000.pop} not in 20k..70k`);
  check(lv(s3000)[3] + lv(s3000)[4] > 0, `[seed ${r.seed}] pacing 3000 ticks: no L4+ towers`);
  check(s9000.pop >= 100000, `[seed ${r.seed}] pacing 9000 ticks: population ${s9000.pop} < 100k`);
  check(r.dev.landBuilt >= 0.5, `[seed ${r.seed}] pacing 9000 ticks: reachable buildable land developed ${(r.dev.landBuilt * 100).toFixed(1)}% < 50%`);
  if (r.meanMs >= 1.5) console.log(`  WARN: mean tick ${r.meanMs.toFixed(3)} ms >= 1.5 ms`);
  // ログがうるさすぎないか
  let minGap = Infinity;
  for (let i = 1; i < r.logs.length; i++) {
    if (r.logs[i].kind === 'info') minGap = Math.min(minGap, r.logs[i].tick - r.logs[i - 1].tick);
  }
  check(r.logs.length / (TICKS / 10) < 0.25, `[seed ${r.seed}] too many logs: ${r.logs.length}`);

  // 高さプロファイル
  const hp = r.hp;
  const f = (e) => (e ? `pop ${e.pop} @t${e.tick}` : 'none');
  console.log(
    `height pacing: tallest while pop<2k ${hp.tallest2k.toFixed(1)}  pop<8k ${hp.tallest8k.toFixed(1)} (max ${hp.over16at8k} above 16)  ` +
      `first L4 ${f(hp.firstL4)}  first L5 ${f(hp.firstL5)}`,
  );
  console.log(`  tallest by population: ${TALLEST_POPS.map((m) => `${m >= 1000 ? m / 1000 + 'k' : m}:${hp.tallestAt[m] === undefined ? '-' : hp.tallestAt[m].toFixed(0)}`).join(' ')}  (tower rebuilds ${hp.rebuilds})`);
  for (const p of hp.profiles) printProfile(r.seed, p.tick, p.pop, p);
  const core = coreStats(r.city, 12);
  console.log(`  core r<=12 at t9000: ${core.n} bldgs, mean ${core.mean.toFixed(1)} sd ${core.sd.toFixed(1)} cv ${core.cv.toFixed(2)}, <20 units ${(core.lowFrac * 100).toFixed(0)}%, parks/plazas ${core.parks}`);
  check(hp.tallest2k <= 12.5, `[seed ${r.seed}] height: tallest ${hp.tallest2k.toFixed(1)} > 12 while pop < 2,000`);
  check(hp.tallest8k <= 26.5, `[seed ${r.seed}] height: tallest ${hp.tallest8k.toFixed(1)} > 26 while pop < 8,000`);
  check(hp.tallestAt[15000] === undefined || hp.tallestAt[15000] <= 45, `[seed ${r.seed}] height: tallest ${hp.tallestAt[15000]} > 45 at pop 15,000`);
  check(hp.over16at8k <= 12, `[seed ${r.seed}] height: ${hp.over16at8k} buildings above 16 while pop < 8,000 (want a handful)`);
  check(hp.firstL4 && hp.firstL4.pop >= 7000 && hp.firstL4.pop <= 15000, `[seed ${r.seed}] height: first L4 at ${f(hp.firstL4)} (want ~10k)`);
  check(hp.firstL5 && hp.firstL5.pop >= 25000 && hp.firstL5.pop <= 45000, `[seed ${r.seed}] height: first L5 at ${f(hp.firstL5)} (want ~30-40k)`);
  check(hp.capViolations.length === 0, `[seed ${r.seed}] height: tower count caps exceeded: ${hp.capViolations.slice(0, 3).join(', ')}`);
  const late = hp.profiles.find((p) => p.tick === 9000);
  const mean = (k) => (late.bands[k] && late.bands[k].n ? late.bands[k].sum / late.bands[k].n : 0);
  check(late.worstRatio <= 25, `[seed ${r.seed}] height: needle tower h/w ${late.worstRatio.toFixed(1)} > 25`);
  check(late.slender <= Math.max(3, late.towers * 0.05), `[seed ${r.seed}] height: ${late.slender}/${late.towers} towers with h/w > 20`);
  check(mean(0) > mean(1) && mean(1) > mean(2) && mean(2) > mean(3) && mean(3) > mean(5), `[seed ${r.seed}] height: skyline not falling off with distance (${[0, 1, 2, 3, 4, 5].map((k) => mean(k).toFixed(1)).join(' > ')})`);
  let tallIn = 0;
  let tallAll = 0;
  const top = [];
  for (const b of r.city.buildings.values()) {
    if (b.zone === ZONE.PARK) continue;
    const d = Math.hypot(b.x - r.city.stats.center.x, b.z - r.city.stats.center.z);
    if (b.height >= 30) {
      tallAll++;
      if (d <= 15) tallIn++;
    }
    top.push({ h: b.height, d });
  }
  top.sort((a, b) => b.h - a.h);
  const top10 = top.slice(0, 10);
  check(tallIn >= tallAll * 0.6, `[seed ${r.seed}] height: only ${tallIn}/${tallAll} buildings >= 30 units within 15 cells of center`);
  check(top10.filter((t) => t.d <= 12).length >= 7, `[seed ${r.seed}] height: tallest 10 not near the middle (d = ${top10.map((t) => t.d.toFixed(0)).join(',')})`);
  check(core.cv >= 0.35 && core.lowFrac >= 0.2, `[seed ${r.seed}] height: core too uniform (cv ${core.cv.toFixed(2)}, <20 units ${(core.lowFrac * 100).toFixed(0)}%)`);
}

// 決定論
{
  const again = run(SEEDS[0], { printMap: false });
  const a = results[0];
  check(JSON.stringify(again.snaps) === JSON.stringify(a.snaps), `determinism: stats differ for seed ${SEEDS[0]}`);
  check(again.hash === a.hash, `determinism: world hash differs for seed ${SEEDS[0]}`);
  check(JSON.stringify(again.counts) === JSON.stringify(a.counts), `determinism: event counts differ`);
  console.log(`\ndeterminism: seed ${SEEDS[0]} world hash ${a.hash.toString(16)} / ${again.hash.toString(16)}`);
}

// building:remove
{
  const c = results[0].city;
  const id = c.buildings.keys().next().value;
  let removed = 0;
  c.events.on('building:remove', () => removed++);
  const ok = c.removeBuilding(id);
  check(ok && removed === 1 && !c.buildings.has(id), 'removeBuilding emits building:remove');
  checkInvariants(c, 'after removeBuilding');
}

// 多シードのペース確認（統計の目標値だけ。main.js はランダムなシードで街を作るため、調整済みの3シード以外でも守る）
// PACING_SEEDS=1,2,3 で指定、PACING_SEEDS=none で省略
{
  const env = process.env.PACING_SEEDS;
  const seeds = env === 'none' ? [] : env ? env.split(',').map(Number) : [5, 11, 17, 35, 47, 118, 154, 0, 3, 28, 64, 99, 203, 264, 308, 364, 1001, 4242, 31337, 99999];
  const t0 = performance.now();
  const bad = [];
  for (const seed of seeds) {
    const c = new City({ seed });
    c.start();
    const errs = [];
    for (let t = 1; t <= 9000; t++) {
      c.tick();
      const s = c.stats;
      if (t === 100 && s.buildings < 15) errs.push(`t100 buildings ${s.buildings}`);
      if (t === 600 && (s.population < 1500 || s.population > 6000)) errs.push(`t600 pop ${s.population}`);
      if (t === 3000) {
        if (s.population < 20000 || s.population > 70000) errs.push(`t3000 pop ${s.population}`);
        let towers = 0;
        for (const b of c.buildings.values()) if (b.level >= 4 && (b.zone === ZONE.RES || b.zone === ZONE.COM)) towers++;
        if (towers === 0) errs.push('t3000 no L4+');
      }
    }
    if (c.stats.population < 100000) errs.push(`t9000 pop ${c.stats.population}`);
    const land = reachableLandBuilt(c);
    if (land < 0.5) errs.push(`t9000 land built ${(land * 100).toFixed(1)}%`);
    if (errs.length) bad.push(`seed ${seed}: ${errs.join(', ')}`);
  }
  for (const b of bad) fail(`pacing sweep ${b}`);
  if (seeds.length) console.log(`pacing sweep: ${seeds.length - bad.length}/${seeds.length} seeds on target (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

if (process.env.COARSE) {
  console.log(`\n--- seed ${SEEDS[0]}: whole map (2x2 cells per char) at tick 9000 ---`);
  console.log(coarseMap(results[0].city));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
