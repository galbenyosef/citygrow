import { CONFIG, TILE, ZONE, ROAD, DIRS, clamp } from '../config.js';
import { Emitter } from '../core/events.js';
import { createRng, createNoise2D, fbm, hash2, hashString } from '../core/rng.js';
import { World } from './world.js';
import { generateTerrain } from './terrain-gen.js';

// ---------------------------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------------------------

const LEVELS = {
  [ZONE.RES]: { cap: [4, 15, 45, 120, 280], h: [[2.5, 3.5], [5, 8], [10, 16], [20, 34], [38, 64]] },
  [ZONE.COM]: { cap: [5, 18, 50, 130, 320], h: [[3.5, 5.5], [7, 11], [16, 26], [30, 48], [52, 90]] },
  [ZONE.IND]: { cap: [20, 45, 90], h: [[4, 6], [6, 9], [8, 12]] },
};

const AVENUE_GAPS = [18, 21, 21, 24]; // 大通りの間隔（3の倍数 → 奥行き2セルの街区がぴったり並ぶ）
const MAX_BRIDGE = 7;
const LOG_GAP = 30; // info ログの最小間隔（tick）
const POP_MILESTONES = [500, 1000, 5000, 10000, 50000, 100000, 250000];
const RADIUS_LOGS = [
  [24, '郊外に新しい住宅地が広がり始めました'],
  [40, '街は川沿いや郊外へと大きく広がっています'],
  [58, '都市圏がマップの端まで広がりつつあります'],
];
const REDEVELOP_POP = 3000;

// スカイライン: 人口に応じた「街でいちばん高くしてよい高さ」（ワールド単位）
const TOP_POP = [0, 500, 2000, 5000, 8000, 10000, 20000, 30000, 40000, 60000, 100000, 160000];
const TOP_H = [6, 8, 11.5, 17, 24, 36, 48, 58, 65, 72, 80, 86];
const MID_POP = [0, 1500, 3000, 8000, 20000, 60000, 150000];
const MID_H = [7, 10, 12.5, 13.5, 16, 18, 20];
// 高層の出現ゲート（人口）と棟数上限（人口あたり）
const L4_POP = 8500;
const L5_POP = 28000;
const L4_PER_POP = 1 / 900;
const L5_PER_POP = 1 / 1500;
const CORE_SAMPLE_POP = 3000; // これ以上の人口で都心を追加抽選
const LOW_LOT_FRAC = 0.28;
const LOW_RISE_H = 5.5; // 郊外の低層（L1-2）の見た目の高さの基準
const REBUILD_CHANCE = 0.05;
const REBUILD_GAIN = 10;
const TOWER_SLENDER = 19; // 高さ / 幅 の目安上限（最も高い数棟だけ少し細くてよい）
const BUILDING_MILESTONES = [1000, 3000, 6000, 10000];
const PARK_MILESTONES = [50, 150, 300];
const ROAD_RANK = [0, 2, 3, 1]; // NONE, STREET, AVENUE, HIGHWAY（正面を向ける優先度）

const STEP_DONE = 0;
const STEP_OK = 1;
const STEP_DEFER = 2;

function lerpTable(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let k = 1; k < xs.length; k++) {
    if (x < xs[k]) return ys[k - 1] + ((ys[k] - ys[k - 1]) * (x - xs[k - 1])) / (xs[k] - xs[k - 1]);
  }
  return ys[ys.length - 1];
}

const smooth01 = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function formatNumber(n) {
  const s = String(Math.floor(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 静的フィールド
// ---------------------------------------------------------------------------------------------

// 最寄りの水面までのマンハッタン距離（上限 255）
function computeWaterDist(world) {
  const N = world.size;
  const dist = new Uint8Array(N * N).fill(255);
  const queue = new Int32Array(N * N);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < N * N; i++) {
    if (world.terrain[i] === TILE.WATER) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    if (d >= 255) continue;
    const x = i % N;
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < N - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (i >= N && dist[i - N] > d) { dist[i - N] = d; queue[tail++] = i - N; }
    if (i < N * N - N && dist[i + N] > d) { dist[i + N] = d; queue[tail++] = i + N; }
  }
  return dist;
}

// 高速道路の方向: 短く、水を渡る距離が少ない辺
function chooseHighwayDir(world, center, rng) {
  const N = world.size;
  let best = 0;
  let bestScore = Infinity;
  for (let d = 0; d < 4; d++) {
    const dir = DIRS[d];
    let len = 0;
    let water = 0;
    for (let x = center.x + dir.dx, z = center.z + dir.dz; x >= 0 && z >= 0 && x < N && z < N; x += dir.dx, z += dir.dz) {
      len++;
      if (world.terrain[z * N + x] === TILE.WATER) water++;
    }
    const score = len + water * 5 + rng.next() * 12;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// 都市計画: 大通りの格子 + スーパーブロック内の街路（奥行き2セルの街区）
// 道路ビルダーはこの計画線の上だけを伸びていく
// ---------------------------------------------------------------------------------------------

function buildPlan(world, center, seed, hwDir, waterDist) {
  const N = world.size;
  const rng = createRng((seed ^ 0x2545f491) >>> 0);
  const noise = createNoise2D((seed + 909) >>> 0);
  const plan = new Uint8Array(N * N);
  const blockOf = new Int32Array(N * N).fill(-1);
  const cx = center.x;
  const cz = center.z;
  const inb = (x, z) => x >= 0 && z >= 0 && x < N && z < N;

  // 大通りの位置
  const makeLines = (c) => {
    const arr = [c];
    for (let p = c + rng.pick(AVENUE_GAPS); p <= N - 4; p += rng.pick(AVENUE_GAPS)) arr.push(p);
    for (let p = c - rng.pick(AVENUE_GAPS); p >= 3; p -= rng.pick(AVENUE_GAPS)) arr.unshift(p);
    return arr;
  };
  const xs = makeLines(cx);
  const zs = makeLines(cz);

  // 工業地区（高速道路沿い、中心から離れた側）
  const hd = DIRS[hwDir];
  const pd = DIRS[(hwDir + 1) % 4];
  const waterFrac = (px, pz, r) => {
    let w = 0;
    let n = 0;
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const x = Math.round(px + dx);
        const z = Math.round(pz + dz);
        n++;
        if (!inb(x, z) || world.terrain[z * N + x] === TILE.WATER) w++;
      }
    }
    return w / n;
  };
  const districts = [];
  const addDistrict = (along, offMag, r, forceSide) => {
    let best = null;
    for (const side of forceSide ? [forceSide] : [1, -1]) {
      const px = clamp(cx + hd.dx * along + pd.dx * side * offMag, 14, N - 15);
      const pz = clamp(cz + hd.dz * along + pd.dz * side * offMag, 14, N - 15);
      const wf = waterFrac(px, pz, 12);
      if (!best || wf < best.wf) best = { x: px, z: pz, r, wf, side };
    }
    districts.push(best);
    return best;
  };
  const d1 = addDistrict(rng.range(27, 36), rng.range(9, 12), rng.range(11, 13.5), 0);
  if (rng.chance(0.65)) addDistrict(rng.range(52, 64), rng.range(8, 12), rng.range(12, 15), -d1.side);
  const isIndustrial = (x, z) => {
    if (Math.hypot(x - cx, z - cz) < 22) return false;
    const xi = clamp(Math.round(x), 0, N - 1);
    const zi = clamp(Math.round(z), 0, N - 1);
    if (waterDist[zi * N + xi] <= 2) return false;
    const wob = 1 + 0.25 * noise(x / 15 + 31.7, z / 15 - 8.3);
    for (const d of districts) if (Math.hypot(x - d.x, z - d.z) < d.r * wob) return true;
    return false;
  };

  for (const x of xs) for (let z = 0; z < N; z++) plan[z * N + x] = ROAD.AVENUE;
  for (const z of zs) for (let x = 0; x < N; x++) plan[z * N + x] = ROAD.AVENUE;
  for (let x = cx + hd.dx, z = cz + hd.dz; inb(x, z); x += hd.dx, z += hd.dz) plan[z * N + x] = ROAD.HIGHWAY;

  // 街区データ
  const bSumX = [];
  const bSumZ = [];
  const bCount = [];
  const bTrees = [];
  const bTouchU = [];
  const bTouchV = [];

  const bx = [-1, ...xs, N];
  const bz = [-1, ...zs, N];
  for (let i = 0; i + 1 < bx.length; i++) {
    for (let j = 0; j + 1 < bz.length; j++) {
      const x0 = bx[i];
      const x1 = bx[i + 1];
      const z0 = bz[j];
      const z1 = bz[j + 1];
      const mx = (Math.max(x0, 0) + Math.min(x1, N - 1)) / 2;
      const mz = (Math.max(z0, 0) + Math.min(z1, N - 1)) / 2;
      const dm = Math.hypot(mx - cx, mz - cz);
      const vx = x0 < 0 || x1 >= N;
      const vz = z0 < 0 || z1 >= N;
      // horiz: 街路が x 方向に走る（z 一定の行）
      let horiz;
      if (vx && !vz) horiz = false;
      else if (vz && !vx) horiz = true;
      else horiz = rng.chance(0.5);

      const ua = horiz ? x0 : z0;
      const ub = horiz ? x1 : z1;
      const va = horiz ? z0 : x0;
      const vb = horiz ? z1 : x1;
      const uaVirt = ua < 0;
      const ubVirt = ub >= N;
      const vaVirt = va < 0;
      const vbVirt = vb >= N;
      const put = (u, v, t) => {
        const x = horiz ? u : v;
        const z = horiz ? v : u;
        if (inb(x, z) && plan[z * N + x] === ROAD.NONE) plan[z * N + x] = t;
      };

      const rows = [];
      if (!vaVirt) {
        for (let v = va + 3; vbVirt ? v <= N - 3 : v <= vb - 3; v += 3) rows.push(v);
      } else {
        for (let v = vb - 3; v >= 2; v -= 3) rows.unshift(v);
      }
      const ind = isIndustrial(mx, mz);
      let s;
      if (ind) s = rng.int(10, 13);
      else if (dm < 22) s = rng.int(5, 6);
      else if (dm < 48) s = rng.int(6, 9);
      else s = rng.int(8, 12);
      const stagger = !ind && dm > 18 && rng.chance(0.45);
      const span = ub - ua;
      const nb = Math.max(1, Math.round(span / s));

      for (const v of rows) {
        for (let u = Math.max(ua + 1, 0); u <= Math.min(ub - 1, N - 1); u++) put(u, v, ROAD.STREET);
      }
      const V = [va, ...rows, vb];
      for (let k = 0; k + 1 < V.length; k++) {
        const p = V[k];
        const q = V[k + 1];
        const vStart = Math.max(p + 1, 0);
        const vEnd = Math.min(q - 1, N - 1);
        if (vEnd < vStart) continue;
        const cross = [];
        if (p >= 0 && q < N && nb > 1) {
          const off = stagger && k % 2 === 1 && span / nb >= 6;
          const cnt = off ? nb : nb - 1;
          for (let m = 0; m < cnt; m++) {
            const pos = Math.round(ua + (m + (off ? 0.5 : 1)) * (span / nb));
            if (pos < ua + 3 || pos > ub - 3 || pos < 2 || pos > N - 3) continue;
            if (cross.length && pos - cross[cross.length - 1] < 3) continue;
            cross.push(pos);
          }
        }
        for (const pos of cross) for (let v = vStart; v <= vEnd; v++) put(pos, v, ROAD.STREET);
        const cuts = [ua, ...cross, ub];
        for (let m = 0; m + 1 < cuts.length; m++) {
          const uS = Math.max(cuts[m] + 1, 0);
          const uE = Math.min(cuts[m + 1] - 1, N - 1);
          if (uE < uS) continue;
          const id = bCount.length;
          bSumX.push(0);
          bSumZ.push(0);
          bCount.push(0);
          bTrees.push(0);
          bTouchU.push((m === 0 && !uaVirt) || (m === cuts.length - 2 && !ubVirt) ? 1 : 0);
          bTouchV.push((k === 0 && !vaVirt) || (k === V.length - 2 && !vbVirt) ? 1 : 0);
          for (let v = vStart; v <= vEnd; v++) {
            for (let u = uS; u <= uE; u++) {
              const x = horiz ? u : v;
              const z = horiz ? v : u;
              const idx = z * N + x;
              if (plan[idx] !== ROAD.NONE || blockOf[idx] !== -1) continue;
              blockOf[idx] = id;
              if (world.terrain[idx] !== TILE.LAND) continue;
              bSumX[id] += x;
              bSumZ[id] += z;
              bCount[id]++;
              bTrees[id] += world.trees[idx];
            }
          }
        }
      }
    }
  }

  // 水上の計画: 街路は削除、大通りは短い橋（≤7）のみ、高速道路はそのまま
  for (let i = 0; i < N * N; i++) {
    if (plan[i] === ROAD.STREET && world.terrain[i] === TILE.WATER) plan[i] = ROAD.NONE;
  }
  // 縦横の両方向で判定してから削除する（長い水上区間の上にある交差点セルも、
  // 交差する方向の短い橋としては残す）
  const keepBridge = new Uint8Array(N * N);
  const dropBridge = new Uint8Array(N * N);
  const pruneLine = (fixed, vertical) => {
    let runStart = -1;
    for (let t = 0; t <= N; t++) {
      const idx = vertical ? t * N + fixed : fixed * N + t;
      const wet = t < N && plan[idx] === ROAD.AVENUE && world.terrain[idx] === TILE.WATER;
      if (wet && runStart < 0) runStart = t;
      if (!wet && runStart >= 0) {
        const len = t - runStart;
        const mark = runStart === 0 || t === N || len > MAX_BRIDGE ? dropBridge : keepBridge;
        for (let k = runStart; k < t; k++) mark[vertical ? k * N + fixed : fixed * N + k] = 1;
        runStart = -1;
      }
    }
  };
  for (const x of xs) pruneLine(x, true);
  for (const z of zs) pruneLine(z, false);
  for (let i = 0; i < N * N; i++) {
    if (dropBridge[i] && !keepBridge[i]) plan[i] = ROAD.NONE;
  }

  // 街区ごとの用途
  const nB = bCount.length;
  const blockZone = new Uint8Array(nB);
  const blockFront = new Uint8Array(nB);
  const blockDown = new Uint8Array(nB);
  for (let b = 0; b < nB; b++) {
    if (bCount[b] === 0) {
      blockZone[b] = ZONE.RES;
      continue;
    }
    const mx = bSumX[b] / bCount[b];
    const mz = bSumZ[b] / bCount[b];
    const d = Math.hypot(mx - cx, mz - cz);
    const ci = clamp(Math.round(mz), 0, N - 1) * N + clamp(Math.round(mx), 0, N - 1);
    const downtownR = 13 + 3.5 * fbm(noise, mx / 18 + 5.5, mz / 18 + 2.5, 2);
    const h = hash2(b, 17, seed);
    const h2 = hash2(b, 29, seed);
    const h3 = hash2(b, 43, seed);
    const small = bCount[b] <= 18;
    let zone = ZONE.RES;
    if (d < downtownR) {
      blockDown[b] = 1;
      zone = h < 0.85 ? ZONE.COM : h < 0.97 || !small ? ZONE.RES : ZONE.PARK;
    } else if (isIndustrial(mx, mz)) {
      zone = h < 0.95 || !small ? ZONE.IND : ZONE.PARK;
    } else {
      const nearWater = waterDist[ci] <= 3;
      const forest = bTrees[b] / bCount[b] >= 1.3;
      const parkP = 0.022 + (nearWater ? 0.07 : 0) + (forest ? 0.035 : 0);
      if (small && h < parkP) zone = ZONE.PARK;
      else if (d < downtownR + 7 && h2 < 0.35) zone = ZONE.COM;
      else if (bTouchU[b] && bTouchV[b] && h2 < (d < 60 ? 0.3 : 0.18)) zone = ZONE.COM;
      else {
        zone = ZONE.RES;
        blockFront[b] = (bTouchU[b] || bTouchV[b]) && h3 < (d < 45 ? 0.35 : 0.15) ? 1 : 0;
      }
    }
    blockZone[b] = zone;
  }

  return { plan, blockOf, blockZone, blockFront, blockDown, districts };
}

// 副都心: 大通り交差点（水辺・高速道路の近くを優先、工業地区は避ける）に小さな高層クラスター
function chooseClusters(world, center, plan, districts, waterDist, seed) {
  const N = world.size;
  const noise = createNoise2D((seed + 4242) >>> 0);
  const cand = [];
  const isArt = (i) => plan[i] === ROAD.AVENUE || plan[i] === ROAD.HIGHWAY;
  for (let z = 2; z < N - 2; z++) {
    for (let x = 2; x < N - 2; x++) {
      const i = z * N + x;
      if (!isArt(i) || world.terrain[i] !== TILE.LAND) continue;
      if (!(isArt(i - 1) && isArt(i + 1) && isArt(i - N) && isArt(i + N))) continue;
      const d = Math.hypot(x - center.x, z - center.z);
      if (d < 24 || d > 64) continue;
      let bad = false;
      for (const dd of districts) if (Math.hypot(x - dd.x, z - dd.z) < dd.r + 9) bad = true;
      if (bad) continue;
      // 周囲の陸地率（水に囲まれた岬には建てない）と水辺
      let land = 0;
      let cnt = 0;
      let wmin = 255;
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
          const j = zz * N + xx;
          cnt++;
          if (world.terrain[j] === TILE.LAND) land++;
          if (waterDist[j] < wmin) wmin = waterDist[j];
        }
      }
      if (land / cnt < 0.6) continue;
      const hw = plan[i - 1] === ROAD.HIGHWAY || plan[i + 1] === ROAD.HIGHWAY || plan[i - N] === ROAD.HIGHWAY || plan[i + N] === ROAD.HIGHWAY;
      const waterfront = wmin <= 2 ? 1 : 0;
      const score = 0.5 + 0.5 * noise(x / 17 + 3.3, z / 17 - 7.1) + (waterfront ? 0.45 : 0) + (hw ? 0.55 : 0) - d * 0.006 + hash2(x, z, seed + 606) * 0.25;
      cand.push({ x, z, d, score, waterfront, hw });
    }
  }
  cand.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  const out = [];
  for (const c of cand) {
    if (out.length >= 4) break;
    if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 26)) continue;
    const k = out.length;
    const h = hash2(c.x, c.z, seed + 808);
    out.push({
      x: c.x,
      z: c.z,
      // Htop に対する強さ、広がり（セル）、立ち上がる人口
      strength: 0.4 + 0.14 * h + (c.hw ? 0.06 : 0) + (c.waterfront ? 0.04 : 0),
      sigma: 2.6 + 1.2 * hash2(c.z, c.x, seed + 909),
      pop0: 16000 + 14000 * k,
      act: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------------------------

export class City {
  constructor({ seed } = {}) {
    this.seed = typeof seed === 'string' ? hashString(seed) : Number(seed) >>> 0;
    this.rng = createRng(this.seed);
    this.events = new Emitter();
    this.world = new World(CONFIG.GRID);
    const { center } = generateTerrain(this.world, this.seed);
    this.buildings = new Map();
    this.stats = {
      tick: 0,
      date: { year: CONFIG.START_YEAR, month: 4, day: 1 },
      population: 0,
      jobs: 0,
      buildings: 0,
      parks: 0,
      roads: 0,
      zoneCounts: { res: 0, com: 0, ind: 0 },
      vacantLots: 0,
      demand: { res: 0.9, com: 0.35, ind: 0.3 },
      center: { x: center.x, z: center.z },
      radius: 9,
      tallest: 0,
    };

    const n = this.world.size * this.world.size;
    this._started = false;
    this._acc = 0;
    this._nextId = 1;
    this._comJobs = 0;
    this._indJobs = 0;
    // 空き区画（スワップ削除）
    this._vacant = [];
    this._vacantPos = new Int32Array(n).fill(-1);
    // 建物リスト（アップグレード抽選用）
    this._list = [];
    this._lastUp = [];
    this._slot = new Map();
    // 道路ビルダー
    this._active = [];
    this._deferred = [];
    this._deferRadius = 0;
    this._radiusCreep = 0;
    // 計画・フィールド（start で生成）
    this._highwayDir = 0;
    this._plan = null;
    this._blockOf = null;
    this._blockZone = null;
    this._blockFront = null;
    this._blockDown = null;
    this._growDist = null;
    this._staticLV = null;
    this._waterDist = null;
    // スカイライン（高さの許容量）
    this._lotNoise = null;
    this._lotLow = null;
    this._clusters = [];
    this._sky = { pop: -1, top: 6, sc: 3.5, kc: 0.04, mid: 7, midVis: 5.5, rm: 6, floor: 5.5 };
    this._lvCount = [0, 0, 0, 0, 0, 0]; // RES+COM のレベル別棟数
    // ログ
    this._logQueue = [];
    this._lastLogTick = -1e9;
    this._lastBridgeLog = -1e9;
    this._popMilestone = 0;
    this._radiusLog = 0;
    this._bldLog = 0;
    this._parkLog = 0;
    this._flags = { com: false, ind: false, park: false, tower: false, sky: false, redevelop: false, rebuild: false };
  }

  // ------------------------------------------------------------------ public

  start() {
    if (this._started) return;
    this._started = true;
    const w = this.world;
    const c = this.stats.center;

    this._waterDist = computeWaterDist(w);
    const hwDir = chooseHighwayDir(w, c, this.rng);
    this._highwayDir = hwDir;
    const P = buildPlan(w, c, this.seed, hwDir, this._waterDist);
    this._plan = P.plan;
    this._blockOf = P.blockOf;
    this._blockZone = P.blockZone;
    this._blockFront = P.blockFront;
    this._blockDown = P.blockDown;
    this._clusters = chooseClusters(w, c, P.plan, P.districts, this._waterDist, this.seed);
    this._buildStaticFields(P);
    this._updateSky();
    this._recomputeLandValue();

    this._log(`${CONFIG.START_YEAR}年 4月、新しい街づくりが始まりました`, 'milestone');

    // 中心交差点 + 高速道路（マップ端まで一気に）
    this._placeRoad(c.x, c.z, ROAD.AVENUE);
    const hd = DIRS[hwDir];
    let bridged = false;
    for (let x = c.x + hd.dx, z = c.z + hd.dz; w.inBounds(x, z); x += hd.dx, z += hd.dz) {
      if (w.terrain[w.idx(x, z)] === TILE.WATER) bridged = true;
      this._placeRoad(x, z, ROAD.HIGHWAY);
      this._spawnBranches(x, z, hwDir);
    }
    this._log(bridged ? '高速道路が開通しました（橋を渡って市外へ）' : '高速道路が開通しました', 'info');

    // 中心から大通りビルダー
    for (let d = 0; d < 4; d++) if (d !== hwDir) this._active.push({ x: c.x, z: c.z, dir: d, type: ROAD.AVENUE });
    for (let k = 0; k < 18; k++) this._roadStep();
    this.stats.vacantLots = this._vacant.length;
  }

  update(simDt) {
    if (!(simDt > 0)) return 0;
    if (!this._started) this.start();
    this._acc += simDt;
    let n = Math.floor(this._acc * CONFIG.TICKS_PER_SECOND);
    if (n > CONFIG.MAX_TICKS_PER_UPDATE) {
      n = CONFIG.MAX_TICKS_PER_UPDATE;
      this._acc = 0; // 追いつけない分は捨てる
    } else {
      this._acc = Math.max(0, this._acc - n / CONFIG.TICKS_PER_SECOND);
    }
    for (let i = 0; i < n; i++) this.tick();
    return n;
  }

  tick() {
    if (!this._started) this.start();
    const s = this.stats;
    const t = ++s.tick;

    this._updateDate(t);
    this._updateDemand();
    this._updateSky();
    const pop = s.population;
    // 実質的な空き区画数: 需要の低い用途の空き区画は「埋まる見込みが薄い」ので軽く数える
    // （需要ゼロの商業区画が溜まって道路の延伸・半径の拡大が止まるのを防ぐ）
    const V = this._vacant;
    const zone = this.world.zone;
    const wRes = s.demand.res;
    const wCom = s.demand.com;
    const wInd = s.demand.ind;
    let vac = 0;
    for (let k = 0; k < V.length; k++) {
      const zv = zone[V[k]];
      vac += zv === ZONE.RES ? wRes : zv === ZONE.COM ? wCom : zv === ZONE.IND ? wInd : 0.5;
    }
    // 成長半径は人口で決まる。道路が行き詰まったらゆっくり外へ広げる
    if (this._active.length === 0 && this._deferred.length > 0 && vac < 40) this._radiusCreep += 0.01;
    s.radius = Math.max(s.radius, Math.min(135, 9 + Math.sqrt(pop) * 0.19 + this._radiusCreep));
    if (t % 20 === 0) this._recomputeLandValue();
    if (t % 10 === 0 && s.radius > this._deferRadius + 0.2) this._reactivateDeferred();

    // 道路: 空き区画が少ないほど多く伸ばす
    const target = 40 + s.buildings * 0.05;
    let steps = 0;
    if (vac < target) steps = Math.min(16, 1 + Math.floor((target - vac) / 6));
    else if (this.rng.chance(0.2)) steps = 1;
    for (let k = 0; k < steps && this._active.length; k++) this._roadStep();

    this._buildStep();
    this._upgradeStep();

    // ログ
    while (this._popMilestone < POP_MILESTONES.length && s.population >= POP_MILESTONES[this._popMilestone]) {
      const m = POP_MILESTONES[this._popMilestone++];
      if (s.population < (POP_MILESTONES[this._popMilestone] || Infinity)) {
        this._log(`人口 ${formatNumber(m)}人 突破！`, 'milestone');
      }
    }
    if (this._radiusLog < RADIUS_LOGS.length && s.radius >= RADIUS_LOGS[this._radiusLog][0]) {
      this._log(RADIUS_LOGS[this._radiusLog++][1], 'info');
    }
    if (this._bldLog < BUILDING_MILESTONES.length && s.buildings >= BUILDING_MILESTONES[this._bldLog]) {
      this._log(`建物の数が ${formatNumber(BUILDING_MILESTONES[this._bldLog++])} 棟を超えました`, 'info');
    }
    if (this._parkLog < PARK_MILESTONES.length && s.parks >= PARK_MILESTONES[this._parkLog]) {
      this._log(`市内の公園が ${PARK_MILESTONES[this._parkLog++]} か所になりました`, 'info');
    }
    this._flushLogs();

    s.vacantLots = this._vacant.length;
  }

  // 仕様上シムはほぼ使わないが、レンダラ検証用に提供
  removeBuilding(id) {
    const b = this.buildings.get(id);
    if (!b) return false;
    const w = this.world;
    const i = w.idx(b.x, b.z);
    w.building[i] = -1;
    this.buildings.delete(id);
    this._listRemove(b);
    this._applyCapacity(b.zone, b.level, -1);
    if (b.zone === ZONE.PARK) this.stats.parks--;
    else {
      this.stats.buildings--;
      this._zoneCount(b.zone, -1);
    }
    if (w.zone[i] !== ZONE.NONE) this._addVacant(i);
    if (b.height >= this.stats.tallest) {
      let m = 0;
      for (const o of this._list) if (o.height > m) m = o.height;
      this.stats.tallest = m;
    }
    this.stats.vacantLots = this._vacant.length;
    this.events.emit('building:remove', { building: b });
    return true;
  }

  // ------------------------------------------------------------------ fields

  _buildStaticFields(P) {
    const w = this.world;
    const N = w.size;
    const c = this.stats.center;
    const n = N * N;
    const gn = createNoise2D((this.seed + 1717) >>> 0);

    // 成長距離: 中心距離 × ノイズ（有機的な外縁）、高速道路沿い・大通りは少し先行
    const hw = new Uint8Array(n);
    const hd = DIRS[this._highwayDir];
    for (let x = c.x + hd.dx, z = c.z + hd.dz; w.inBounds(x, z); x += hd.dx, z += hd.dz) {
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (w.inBounds(x + dx, z + dz)) hw[w.idx(x + dx, z + dz)] = 1;
        }
      }
    }
    const grow = new Float32Array(n);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        let f = 1 + 0.42 * fbm(gn, x / 22 + 0.5, z / 22 + 0.5, 3);
        if (hw[i]) f *= 0.86;
        if (this._plan[i] === ROAD.AVENUE) f *= 0.92;
        grow[i] = Math.hypot(x - c.x, z - c.z) * f;
      }
    }
    this._growDist = grow;

    // 地価の静的成分: 水辺ボーナス、公園街区ボーナス、工業地区ペナルティ
    const lv = new Float32Array(n);
    const wd = this._waterDist;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        let v = 0;
        const d = wd[i];
        if (d >= 1 && d <= 4) v += 0.17 * (1 - (d - 1) / 4);
        for (const dd of P.districts) {
          const e = Math.hypot(x - dd.x, z - dd.z) - dd.r;
          if (e < 8) v -= 0.28 * Math.min(1, (8 - e) / 8);
        }
        lv[i] = v;
      }
    }
    const parkBonus = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = this._blockOf[i];
      if (b < 0 || this._blockZone[b] !== ZONE.PARK || w.terrain[i] !== TILE.LAND) continue;
      const x = i % N;
      const z = (i / N) | 0;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (w.inBounds(x + dx, z + dz)) parkBonus[w.idx(x + dx, z + dz)] = 0.06;
        }
      }
    }
    for (let i = 0; i < n; i++) lv[i] += parkBonus[i];
    this._staticLV = lv;

    // 区画ごとの「高さの個性」0..1: 区画の乱数 + 街区の乱数（隣同士でも高さがばらつく）
    const ln = new Float32Array(n);
    const low = new Uint8Array(n);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const b = this._blockOf[i];
        const hl = hash2(x, z, this.seed + 3131);
        const hb = b >= 0 ? hash2(b, 57, this.seed + 3232) : 0.5;
        ln[i] = 0.7 * hl + 0.3 * hb;
        // 低層のまま残る区画（都心でも 6〜15 階程度）
        low[i] = hash2(x, z, this.seed + 3333) < LOW_LOT_FRAC ? 1 : 0;
      }
    }
    this._lotNoise = ln;
    this._lotLow = low;
  }

  // 人口に応じたスカイライン・パラメータ（都心のガウス核 + 中層リング + 副都心）
  _updateSky() {
    const pop = this.stats.population;
    const K = this._sky;
    if (K.pop === pop) return;
    K.pop = pop;
    const sp = Math.sqrt(pop);
    K.top = lerpTable(TOP_POP, TOP_H, pop);
    const sc = 3.5 + 0.014 * sp; // 高層核の広がり（セル）
    K.sc = sc;
    K.kc = 1 / (2 * sc * sc);
    K.mid = lerpTable(MID_POP, MID_H, pop); // 中層リングの高さ
    K.midVis = K.mid * (0.78 + 0.22 * smooth01(3000, 20000, pop)); // 小さな町のうちは見た目を低めに
    K.rm = 6 + 0.08 * sp; // 中層リングの半径（この外側でなだらかに低層へ）
    K.floor = 5.5 + 2.5 * smooth01(5000, 60000, pop); // どこでも許される低層の高さ
    for (const cl of this._clusters) cl.act = smooth01(cl.pop0, cl.pop0 * 2.4, pop);
  }

  // 区画 (x, z) で許される最大の高さ（visual: 実際に建てる高さの上限）
  _heightAllow(x, z, visual = false) {
    const K = this._sky;
    const c = this.stats.center;
    const dx = x - c.x;
    const dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    let h = K.top * Math.exp(-d2 * K.kc);
    for (const cl of this._clusters) {
      if (cl.act <= 0) continue;
      const ex = x - cl.x;
      const ez = z - cl.z;
      const s = K.top * cl.strength * cl.act * Math.exp(-(ex * ex + ez * ez) / (2 * cl.sigma * cl.sigma));
      if (s > h) h = s;
    }
    const li = z * this.world.size + x;
    const n = this._lotNoise[li];
    // 中心の数区画はランドマーク（いちばん高いビルは街の真ん中に）
    const nc = this._lotLow[li] ? 0.1 + 0.12 * n : 0.35 + 0.65 * n;
    const peak = Math.exp(-d2 / 13.5);
    h *= nc > peak ? nc : peak;
    // 中層リング。レベル（収容力）判定は台地状、見た目の高さは中心側ほど高く外側へ下がり、
    // 低層区画は一段低い（同じレベルでも高さがばらつく）
    const dm = Math.sqrt(d2);
    if (dm < K.rm * 1.8) {
      let m;
      if (visual) {
        const g = dm < K.rm ? 1 - 0.35 * (dm / K.rm) : 0.65 * (1 - smooth01(K.rm, K.rm * 1.8, dm));
        m = K.midVis * g * (this._lotLow[li] ? 0.55 + 0.1 * n : 0.8 + 0.25 * n);
      } else {
        m = K.mid * (1 - smooth01(K.rm, K.rm * 1.8, dm)) * (0.75 + 0.25 * n);
      }
      if (m > h) h = m;
    }
    return h > K.floor ? h : K.floor;
  }

  _recomputeLandValue() {
    const w = this.world;
    const N = w.size;
    const c = this.stats.center;
    const rc = Math.min(34, 9 + this.stats.radius * 0.4);
    const k = 1 / (rc * rc);
    const road = w.road;
    const out = w.landValue;
    const st = this._staticLV;
    for (let z = 0; z < N; z++) {
      const dz2 = (z - c.z) * (z - c.z);
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (w.terrain[i] === TILE.WATER) {
          out[i] = 0;
          continue;
        }
        let v = 0.05 + 0.85 * Math.exp(-((x - c.x) * (x - c.x) + dz2) * k) + st[i];
        if (
          (x > 0 && road[i - 1] === ROAD.AVENUE) ||
          (x < N - 1 && road[i + 1] === ROAD.AVENUE) ||
          (z > 0 && road[i - N] === ROAD.AVENUE) ||
          (z < N - 1 && road[i + N] === ROAD.AVENUE)
        ) {
          v += 0.04;
        }
        out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    // 副都心の地価ボーナス
    for (const cl of this._clusters) {
      if (cl.act <= 0) continue;
      const sg = cl.sigma * 1.7;
      const r = Math.ceil(sg * 3);
      const kk = 1 / (2 * sg * sg);
      for (let z = Math.max(0, cl.z - r); z <= Math.min(N - 1, cl.z + r); z++) {
        for (let x = Math.max(0, cl.x - r); x <= Math.min(N - 1, cl.x + r); x++) {
          const i = z * N + x;
          if (w.terrain[i] === TILE.WATER) continue;
          const v = out[i] + 0.42 * cl.act * Math.exp(-((x - cl.x) * (x - cl.x) + (z - cl.z) * (z - cl.z)) * kk);
          out[i] = v > 1 ? 1 : v;
        }
      }
    }
  }

  _updateDemand() {
    const s = this.stats;
    const pop = s.population;
    const workers = pop * 0.5;
    const com = this._comJobs;
    const ind = this._indJobs;
    const jobs = com + ind;
    const r = 0.5 + 0.5 * Math.tanh((jobs * 1.2 + 500 - workers) / (workers * 0.5 + 200));
    const cm = 0.5 + 0.5 * Math.tanh((pop * 0.4 + 60 - com) / (pop * 0.1 + 60));
    const id = 0.5 + 0.5 * Math.tanh((pop * 0.13 + 40 - ind) / (pop * 0.06 + 60));
    const d = s.demand;
    d.res += (r - d.res) * 0.04;
    d.com += (cm - d.com) * 0.04;
    d.ind += (id - d.ind) * 0.04;
  }

  _updateDate(t) {
    const days = 90 + Math.floor(t * CONFIG.DAYS_PER_TICK + 1e-7);
    const date = this.stats.date;
    const year = CONFIG.START_YEAR + Math.floor(days / 360);
    date.month = Math.floor((days % 360) / 30) + 1;
    date.day = (days % 30) + 1;
    if (year !== date.year) {
      date.year = year;
      this._log(`${year}年 になりました`, 'info');
    }
  }

  // ------------------------------------------------------------------ roads

  _placeRoad(x, z, type) {
    const w = this.world;
    const i = w.idx(x, z);
    if (w.road[i] !== ROAD.NONE || w.building[i] !== -1) return false;
    if (w.zone[i] !== ZONE.NONE) {
      w.zone[i] = ZONE.NONE;
      this._removeVacant(i);
      this.events.emit('zone:set', { x, z, zone: ZONE.NONE });
    }
    if (w.trees[i] !== 0) {
      w.trees[i] = 0;
      this.events.emit('trees:remove', { x, z });
    }
    w.road[i] = type;
    this.stats.roads++;
    this.events.emit('road:add', { x, z, type });
    if (type !== ROAD.HIGHWAY) {
      if (x > 0) this._tryZone(x - 1, z);
      if (x < w.size - 1) this._tryZone(x + 1, z);
      if (z > 0) this._tryZone(x, z - 1);
      if (z < w.size - 1) this._tryZone(x, z + 1);
    }
    return true;
  }

  _tryZone(x, z) {
    const w = this.world;
    const i = w.idx(x, z);
    if (
      w.terrain[i] !== TILE.LAND ||
      w.road[i] !== ROAD.NONE ||
      w.building[i] !== -1 ||
      w.zone[i] !== ZONE.NONE ||
      this._plan[i] !== ROAD.NONE
    ) {
      return;
    }
    const b = this._blockOf[i];
    let zone = b >= 0 ? this._blockZone[b] : ZONE.RES;
    if (zone === ZONE.RES && b >= 0 && this._blockFront[b] && this._nearPlan(x, z, ROAD.AVENUE)) zone = ZONE.COM;
    // 都心の小さな広場（高層の谷間に抜けをつくる）
    if (b >= 0 && this._blockDown[b] && zone !== ZONE.PARK && hash2(x, z, this.seed + 41) < 0.045) zone = ZONE.PARK;
    // 小さな町のうちは都心予定地も住宅（大通り沿いだけ商店）。後で再開発される
    if (zone === ZONE.COM && b >= 0 && this._blockDown[b] && this.stats.population < REDEVELOP_POP) {
      if (!this._nearPlan(x, z, ROAD.AVENUE) && hash2(x, z, this.seed + 5) < 0.8) zone = ZONE.RES;
    }
    w.zone[i] = zone;
    this._addVacant(i);
    this.events.emit('zone:set', { x, z, zone });
    if (zone === ZONE.IND && !this._flags.ind) {
      this._flags.ind = true;
      this._log('工業地区の整備が始まりました', 'info');
    }
  }

  _nearPlan(x, z, type) {
    const w = this.world;
    const p = this._plan;
    const N = w.size;
    const i = w.idx(x, z);
    return (
      (x > 0 && p[i - 1] === type) ||
      (x < N - 1 && p[i + 1] === type) ||
      (z > 0 && p[i - N] === type) ||
      (z < N - 1 && p[i + N] === type)
    );
  }

  _spawnBranches(x, z, dir) {
    const w = this.world;
    for (const pdir of [(dir + 1) % 4, (dir + 3) % 4]) {
      const d = DIRS[pdir];
      const nx = x + d.dx;
      const nz = z + d.dz;
      if (!w.inBounds(nx, nz)) continue;
      const ni = w.idx(nx, nz);
      const t = this._plan[ni];
      if (t !== ROAD.NONE && w.road[ni] === ROAD.NONE) this._active.push({ x, z, dir: pdir, type: t });
    }
  }

  _targetDist(b) {
    const d = DIRS[b.dir];
    const x = b.x + d.dx;
    const z = b.z + d.dz;
    if (!this.world.inBounds(x, z)) return -1;
    return this._growDist[z * this.world.size + x];
  }

  _roadStep() {
    const A = this._active;
    if (A.length === 0) return false;
    let j = this.rng.int(0, A.length - 1);
    if (A.length > 1) {
      // 2つ抽選して中心に近い方（コンパクトに埋まる）
      const j2 = this.rng.int(0, A.length - 1);
      if (this._targetDist(A[j2]) < this._targetDist(A[j])) j = j2;
    }
    const b = A[j];
    const r = this._stepBuilder(b);
    if (r !== STEP_OK) {
      const last = A.pop();
      if (last !== b) A[j] = last;
      if (r === STEP_DEFER) this._deferred.push(b);
    }
    return true;
  }

  _stepBuilder(b) {
    const w = this.world;
    const N = w.size;
    const d = DIRS[b.dir];
    const nx = b.x + d.dx;
    const nz = b.z + d.dz;
    if (!w.inBounds(nx, nz)) return STEP_DONE;
    const ni = nz * N + nx;
    const pt = this._plan[ni];
    if (pt === ROAD.NONE) return STEP_DONE;
    if (w.road[ni] !== ROAD.NONE) return STEP_DONE; // 接続した
    if (w.building[ni] !== -1) return STEP_DONE;

    if (w.terrain[ni] === TILE.WATER) {
      // 橋: 対岸まで一気に架ける
      let k = 0;
      let x = nx;
      let z = nz;
      while (w.inBounds(x, z) && w.terrain[z * N + x] === TILE.WATER && this._plan[z * N + x] !== ROAD.NONE) {
        k++;
        x += d.dx;
        z += d.dz;
      }
      const landed = w.inBounds(x, z) && w.terrain[z * N + x] === TILE.LAND;
      if (pt !== ROAD.HIGHWAY && (!landed || k > MAX_BRIDGE)) return STEP_DONE;
      const checkX = landed ? x : x - d.dx;
      const checkZ = landed ? z : z - d.dz;
      if (this._growDist[checkZ * N + checkX] > this.stats.radius) return STEP_DEFER;
      let placed = 0;
      for (let s = 0; s < k; s++) {
        const bx = nx + d.dx * s;
        const bz = nz + d.dz * s;
        if (this._placeRoad(bx, bz, this._plan[bz * N + bx])) {
          placed++;
          this._spawnBranches(bx, bz, b.dir);
        }
      }
      b.x = nx + d.dx * (k - 1);
      b.z = nz + d.dz * (k - 1);
      if (placed > 0 && this.stats.tick - this._lastBridgeLog > 150) {
        this._lastBridgeLog = this.stats.tick;
        this._log('新しい橋が架けられました', 'info');
      }
      return STEP_OK;
    }

    if (this._growDist[ni] > this.stats.radius) return STEP_DEFER;
    this._placeRoad(nx, nz, pt);
    b.x = nx;
    b.z = nz;
    b.type = pt;
    this._spawnBranches(nx, nz, b.dir);
    return STEP_OK;
  }

  _reactivateDeferred() {
    this._deferRadius = this.stats.radius;
    const D = this._deferred;
    const r = this.stats.radius;
    for (let j = D.length - 1; j >= 0; j--) {
      const td = this._targetDist(D[j]);
      if (td < 0 || td <= r) {
        const b = D[j];
        const last = D.pop();
        if (j < D.length) D[j] = last;
        if (td >= 0) this._active.push(b);
      }
    }
  }

  // ------------------------------------------------------------------ buildings

  _buildStep() {
    const V = this._vacant;
    if (V.length === 0) return;
    const w = this.world;
    const N = w.size;
    const s = this.stats;
    const samples = Math.min(V.length, 3 + Math.floor(V.length / 40), 24);
    for (let k = 0; k < samples && V.length; k++) {
      const i = V[this.rng.int(0, V.length - 1)];
      const x = i % N;
      const z = (i / N) | 0;
      if (w.roadMask(x, z) === 0) continue;
      const zone = w.zone[i];
      const lv = w.landValue[i];
      let p;
      if (zone === ZONE.PARK) p = 0.1;
      else if (zone === ZONE.RES) p = 0.3 * (0.15 + 0.85 * s.demand.res) * (0.8 + 0.4 * lv);
      else if (zone === ZONE.COM) p = 0.24 * (0.12 + 0.88 * s.demand.com) * (0.7 + 0.6 * lv);
      else p = 0.22 * (0.12 + 0.88 * s.demand.ind);
      if (this.rng.chance(p)) this._construct(x, z, zone);
    }
  }

  _construct(x, z, zone, forceLevel = 0, minHeight = 0) {
    const w = this.world;
    const s = this.stats;
    const i = w.idx(x, z);
    const lv = w.landValue[i];
    let level = 1;
    if (forceLevel > 0) level = forceLevel;
    // 大きな街の一等地には最初から中層が建つ
    else if (zone === ZONE.RES || zone === ZONE.COM) {
      const cap = this._maxLevel(zone, lv, x, z);
      if (cap >= 4 && s.population > 8000) level = cap - 2;
      else if (cap >= 3 && s.population > 2500) level = 2;
    }
    const b = {
      id: this._nextId++,
      x,
      z,
      zone,
      level,
      height: 0,
      w: 0.8,
      d: 0.8,
      rotation: this._faceRoad(x, z),
      variant: 0,
      createdTick: s.tick,
    };
    this._shape(b, lv, minHeight);

    if (w.trees[i] !== 0) {
      w.trees[i] = 0;
      this.events.emit('trees:remove', { x, z });
    }
    w.building[i] = b.id;
    this._removeVacant(i);
    this.buildings.set(b.id, b);
    this._listAdd(b);
    this._applyCapacity(zone, level, 1);
    if (zone === ZONE.PARK) s.parks++;
    else {
      s.buildings++;
      this._zoneCount(zone, 1);
    }
    if (b.height > s.tallest) s.tallest = b.height;
    s.vacantLots = this._vacant.length;
    this.events.emit('building:add', { building: b });

    if (zone === ZONE.COM && !this._flags.com) {
      this._flags.com = true;
      this._log('初めてのお店がオープンしました', 'info');
    } else if (zone === ZONE.PARK && !this._flags.park) {
      this._flags.park = true;
      this._log('初めての公園ができました', 'info');
    }
    this._towerLogs(b);
  }

  _upgradeStep() {
    const L = this._list;
    if (L.length === 0) return;
    const s = this.stats;
    const w = this.world;
    const n = Math.min(L.length, 2 + Math.floor(L.length / 250), 40);
    for (let k = 0; k < n; k++) {
      const slot = this.rng.int(0, L.length - 1);
      this._tryUpgrade(L[slot], slot, false);
    }
    // 都心は追加で抽選（街の成長に高層化が遅れないように）
    if (s.population < CORE_SAMPLE_POP) return;
    const R = clamp(Math.round(this._sky.sc * 2.2), 6, 20);
    const extra = Math.ceil(((2 * R + 1) * (2 * R + 1)) / 160);
    const c = s.center;
    for (let k = 0; k < extra; k++) {
      const x = c.x + this.rng.int(-R, R);
      const z = c.z + this.rng.int(-R, R);
      if (!w.inBounds(x, z)) continue;
      const id = w.building[w.idx(x, z)];
      if (id === -1) continue;
      this._tryUpgrade(this.buildings.get(id), this._slot.get(id), true);
    }
  }

  _tryUpgrade(b, slot, core) {
    const s = this.stats;
    const w = this.world;
    if (b.zone === ZONE.PARK) return;
    if (s.tick - this._lastUp[slot] < 40 + 40 * b.level) return;
    const i = w.idx(b.x, b.z);
    const lv = w.landValue[i];
    if (b.zone === ZONE.RES) {
      const blk = this._blockOf[i];
      if (blk >= 0 && this._blockDown[blk] && this._blockZone[blk] === ZONE.COM) {
        // 都心予定地の住宅は低層のまま、人口が増えたら商業へ建て替え
        if (s.population >= REDEVELOP_POP) {
          if (this.rng.chance(0.3 * (0.3 + 0.7 * s.demand.com))) this._redevelop(b);
          return;
        }
        if (b.level >= 2) return;
      }
    }
    if (b.level >= this._maxLevel(b.zone, lv, b.x, b.z)) {
      // 頭打ちのタワーは、許容量が大きく伸びたら稀に建て替え（スカイラインの頂点が育つ）
      if (core && b.level >= 4 && this.rng.chance(REBUILD_CHANCE) && Math.min(LEVELS[b.zone].h[b.level - 1][1], this._heightAllow(b.x, b.z, true)) > b.height + REBUILD_GAIN) {
        this._rebuildTower(b);
      }
      return;
    }
    // 高層の棟数上限（人口あたり）
    if (b.zone !== ZONE.IND) {
      if (b.level === 3 && this._lvCount[4] >= s.population * L4_PER_POP) return;
      if (b.level === 4 && this._lvCount[5] >= s.population * L5_PER_POP) return;
    }
    const dem = b.zone === ZONE.RES ? s.demand.res : b.zone === ZONE.COM ? s.demand.com : s.demand.ind;
    // 都心の抽選は需要への依存を弱める（人口の伸びに対して都心の成熟が遅れ、初の高層が遅れないように）
    if (!this.rng.chance(core ? 0.5 * (0.5 + 0.5 * dem) : 0.35 * (0.1 + 0.9 * dem))) return;
    this._upgrade(b, slot, lv);
  }

  // 超高層の建て替え（同じ区画に、より高いタワー）
  _rebuildTower(b) {
    const { x, z, zone, level, height } = b;
    this.removeBuilding(b.id);
    this._construct(x, z, zone, level, height + REBUILD_GAIN * 0.5);
    if (!this._flags.rebuild) {
      this._flags.rebuild = true;
      this._log('都心で超高層ビルの建て替えが始まりました', 'info');
    }
  }

  // 都心の低層住宅 → 商業ビルへ建て替え
  _redevelop(b) {
    const w = this.world;
    const { x, z } = b;
    this.removeBuilding(b.id);
    const i = w.idx(x, z);
    w.zone[i] = ZONE.COM;
    this.events.emit('zone:set', { x, z, zone: ZONE.COM });
    this._construct(x, z, ZONE.COM);
    if (!this._flags.redevelop) {
      this._flags.redevelop = true;
      this._log('都心部の再開発が始まりました', 'info');
    }
  }

  _upgrade(b, slot, lv) {
    const s = this.stats;
    const prevLevel = b.level;
    const prevHeight = b.height;
    this._applyCapacity(b.zone, prevLevel, -1);
    b.level = prevLevel + 1;
    this._applyCapacity(b.zone, b.level, 1);
    this._shape(b, lv, prevHeight);
    this._lastUp[slot] = s.tick;
    if (b.height > s.tallest) s.tallest = b.height;
    this.events.emit('building:upgrade', { building: b, prevLevel });
    this._towerLogs(b);
  }

  _towerLogs(b) {
    if (b.zone !== ZONE.RES && b.zone !== ZONE.COM) return;
    if (b.level >= 4 && !this._flags.tower) {
      this._flags.tower = true;
      this._log('初の高層ビルが完成しました', 'milestone');
    } else if (b.level >= 5 && b.zone === ZONE.COM && !this._flags.sky) {
      this._flags.sky = true;
      this._log('街のシンボルとなる超高層ビルが誕生しました', 'milestone');
    }
  }

  _maxLevel(zone, lv, x, z) {
    const pop = this.stats.population;
    if (zone === ZONE.PARK) return 1;
    if (zone === ZONE.IND) return pop < 1500 ? 1 : pop < 9000 ? 2 : 3;
    const gate = pop < 350 ? 2 : pop < L4_POP ? 3 : pop < L5_POP ? 4 : 5;
    let byLv;
    if (zone === ZONE.RES) byLv = lv < 0.12 ? 1 : lv < 0.26 ? 2 : lv < 0.5 ? 3 : lv < 0.7 ? 4 : 5;
    else byLv = lv < 0.12 ? 1 : lv < 0.28 ? 2 : lv < 0.48 ? 3 : lv < 0.68 ? 4 : 5;
    let cap = byLv < gate ? byLv : gate;
    // スカイライン: そのレベルの最低の高さが許容量に収まること
    if (cap > 1) {
      const H = LEVELS[zone].h;
      const ha = this._heightAllow(x, z);
      while (cap > 1 && H[cap - 1][0] > ha) cap--;
    }
    return cap;
  }

  // 高さ・フットプリント・バリアント
  _shape(b, lv, minHeight) {
    const rng = this.rng;
    if (b.zone === ZONE.PARK) {
      b.height = 0;
      b.w = 0.95;
      b.d = 0.95;
      b.variant = rng.int(0, 999);
      return;
    }
    const [lo, hi] = LEVELS[b.zone].h[b.level - 1];
    // 上限はスカイラインの許容量（工業は対象外）。低層（L1-2）は都心から離れるほど低めに
    let top = hi;
    if (b.zone !== ZONE.IND) {
      const allow = this._heightAllow(b.x, b.z, true);
      top = clamp(b.level <= 2 ? LOW_RISE_H + 0.35 * (allow - LOW_RISE_H) : allow, lo, hi);
    }
    const t = b.level <= 2 ? rng.next() : Math.pow(rng.next(), 1 / (1 + 1.2 * lv));
    let height = lo + (top - lo) * t;
    if (minHeight > 0 && height < minHeight + 0.5) height = Math.min(hi, minHeight + 0.5);
    b.height = height;
    let fl;
    let fh;
    if (b.zone === ZONE.IND) [fl, fh] = [0.8, 0.95];
    else if (b.level >= 4) {
      // タワーは高さに応じて太く（針のような塔にしない）
      fl = clamp(height / (TOWER_SLENDER * CONFIG.CELL), 0.72, 0.9);
      fh = Math.min(0.92, fl + 0.18);
    } else if (b.level === 1 && b.zone === ZONE.RES) [fl, fh] = [0.55, 0.75];
    else [fl, fh] = [0.7, 0.9];
    b.w = Math.round(rng.range(fl, fh) * 100) / 100;
    b.d = Math.round(rng.range(fl, fh) * 100) / 100;
    b.variant = rng.int(0, 999);
  }

  _faceRoad(x, z) {
    const w = this.world;
    let best = -1;
    let bestRank = 0;
    let ties = 0;
    const h = hash2(x, z, this.seed + 17);
    for (let r = 0; r < 4; r++) {
      const d = DIRS[r];
      const nx = x + d.dx;
      const nz = z + d.dz;
      if (!w.inBounds(nx, nz)) continue;
      const rank = ROAD_RANK[w.road[w.idx(nx, nz)]];
      if (rank === 0) continue;
      if (rank > bestRank) {
        bestRank = rank;
        best = r;
        ties = 1;
      } else if (rank === bestRank) {
        ties++;
        if (h * ties < 1) best = r; // 決定論的なタイブレーク
      }
    }
    return best < 0 ? 2 : best;
  }

  _applyCapacity(zone, level, sign) {
    const L = LEVELS[zone];
    if (!L) return;
    const cap = L.cap[level - 1] * sign;
    const s = this.stats;
    if (zone !== ZONE.IND) this._lvCount[level] += sign;
    if (zone === ZONE.RES) s.population += cap;
    else if (zone === ZONE.COM) {
      this._comJobs += cap;
      s.jobs += cap;
    } else {
      this._indJobs += cap;
      s.jobs += cap;
    }
  }

  _zoneCount(zone, delta) {
    const zc = this.stats.zoneCounts;
    if (zone === ZONE.RES) zc.res += delta;
    else if (zone === ZONE.COM) zc.com += delta;
    else if (zone === ZONE.IND) zc.ind += delta;
  }

  // ------------------------------------------------------------------ containers

  _addVacant(i) {
    if (this._vacantPos[i] !== -1) return;
    this._vacantPos[i] = this._vacant.length;
    this._vacant.push(i);
  }

  _removeVacant(i) {
    const p = this._vacantPos[i];
    if (p === -1) return;
    const last = this._vacant.pop();
    if (last !== i) {
      this._vacant[p] = last;
      this._vacantPos[last] = p;
    }
    this._vacantPos[i] = -1;
  }

  _listAdd(b) {
    this._slot.set(b.id, this._list.length);
    this._list.push(b);
    this._lastUp.push(this.stats.tick);
  }

  _listRemove(b) {
    const p = this._slot.get(b.id);
    if (p === undefined) return;
    const lastB = this._list.pop();
    const lastT = this._lastUp.pop();
    if (lastB !== b) {
      this._list[p] = lastB;
      this._lastUp[p] = lastT;
      this._slot.set(lastB.id, p);
    }
    this._slot.delete(b.id);
  }

  // ------------------------------------------------------------------ logs

  _log(text, kind = 'info') {
    const t = this.stats.tick;
    if (kind === 'milestone' || t - this._lastLogTick >= LOG_GAP) {
      this._lastLogTick = t;
      this.events.emit('log', { text, kind });
      return;
    }
    if (this._logQueue.length >= 3) this._logQueue.shift();
    this._logQueue.push({ text, kind });
  }

  _flushLogs() {
    if (this._logQueue.length && this.stats.tick - this._lastLogTick >= LOG_GAP) {
      this._lastLogTick = this.stats.tick;
      this.events.emit('log', this._logQueue.shift());
    }
  }
}
