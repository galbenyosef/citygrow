import { TILE } from '../config.js';
import { createRng, createNoise2D, fbm, hash2 } from '../core/rng.js';

// 地形生成: 川・湖・海岸線・森。world.terrain / world.trees を埋め、街の中心セルを返す
export function generateTerrain(world, seed) {
  seed = seed >>> 0;
  const N = world.size;
  const total = N * N;
  const mid = N / 2;
  const rng = createRng((seed ^ 0x5bd1e995) >>> 0);
  const nRiver = createNoise2D((seed + 101) >>> 0);
  const nLake = createNoise2D((seed + 202) >>> 0);
  const nForest = createNoise2D((seed + 303) >>> 0);
  const nCoast = createNoise2D((seed + 404) >>> 0);

  const water = new Uint8Array(total);
  let waterCount = 0;
  const setWater = (x, z) => {
    if (x < 0 || z < 0 || x >= N || z >= N) return;
    const i = z * N + x;
    if (!water[i]) {
      water[i] = 1;
      waterCount++;
    }
  };

  // --- 川: ノイズで蛇行するポリラインに円をスタンプ ---
  const horizontal = rng.chance(0.5);
  const side = rng.chance(0.5) ? 1 : -1;
  const offset = side * rng.range(17, 30);
  const tilt = rng.range(-0.22, 0.22);
  const phase = rng.range(0, 50);
  const baseW = rng.range(3.4, 5.4);
  for (let t = -6; t <= N + 6; t += 0.5) {
    const s = t - mid;
    const off = offset + s * tilt + fbm(nRiver, t / 46 + phase, 0.37, 3) * 20 + Math.sin(t / 19 + phase) * 3;
    const hw = Math.max(1.6, (baseW + fbm(nRiver, t / 23 + 3.1, 7.7 + phase, 2) * 2.2) / 2);
    const cu = t;
    const cv = mid + off;
    const px = horizontal ? cu : cv;
    const pz = horizontal ? cv : cu;
    const r = Math.ceil(hw);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = Math.round(px) + dx;
        const cz = Math.round(pz) + dz;
        const ex = cx - px;
        const ez = cz - pz;
        if (ex * ex + ez * ez <= hw * hw) setWater(cx, cz);
      }
    }
  }

  // --- 海岸線（片側、確率で） ---
  if (rng.chance(0.4)) {
    const coastSide = rng.int(0, 3); // 0:N 1:E 2:S 3:W
    const depth0 = rng.range(6, 11);
    for (let t = 0; t < N; t++) {
      const depth = depth0 + fbm(nCoast, t / 34, 1.7, 3) * 9 + Math.sin(t / 13 + phase) * 1.5;
      for (let e = 0; e < depth; e++) {
        if (coastSide === 0) setWater(t, e);
        else if (coastSide === 1) setWater(N - 1 - e, t);
        else if (coastSide === 2) setWater(t, N - 1 - e);
        else setWater(e, t);
      }
    }
  }

  // --- 湖: 低周波 fbm の低い場所から目標水域率まで ---
  const targetWater = Math.floor(total * rng.range(0.16, 0.21));
  const lakeNeed = Math.min(Math.floor(total * 0.14), targetWater - waterCount);
  if (lakeNeed > 0) {
    const cand = [];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        if (water[i]) continue;
        const dx = x - mid;
        const dz = z - mid;
        if (dx * dx + dz * dz < 20 * 20) continue;
        cand.push({ i, v: fbm(nLake, x / 30 + 11.3, z / 30 - 4.9, 3) });
      }
    }
    cand.sort((a, b) => a.v - b.v || a.i - b.i);
    for (let k = 0; k < lakeNeed && k < cand.length; k++) {
      if (cand[k].v > 0.02) break;
      water[cand[k].i] = 1;
      waterCount++;
    }
  }

  // --- 平滑化（細い陸地・水路のスリバー除去） ---
  const tmp = new Uint8Array(total);
  for (let pass = 0; pass < 3; pass++) {
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let c = 0;
        let n = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const xx = x + dx;
            const zz = z + dz;
            n++;
            // 境界外は自身と同じ扱い
            if (xx < 0 || zz < 0 || xx >= N || zz >= N) c += water[z * N + x];
            else c += water[zz * N + xx];
          }
        }
        const i = z * N + x;
        tmp[i] = c >= 5 ? 1 : c <= 3 ? 0 : water[i];
      }
    }
    water.set(tmp);
    // 4近傍で3方向以上が反対属性なら反転（1セル幅の突起を消す）
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const w = water[i];
        let opp = 0;
        if (x > 0 && water[i - 1] !== w) opp++;
        if (x < N - 1 && water[i + 1] !== w) opp++;
        if (z > 0 && water[i - N] !== w) opp++;
        if (z < N - 1 && water[i + N] !== w) opp++;
        tmp[i] = opp >= 3 ? 1 - w : w;
      }
    }
    water.set(tmp);
  }

  // --- 小さな水域 → 陸, 小さな島 → 水 ---
  removeSmallComponents(water, N, 1, 12, 0);
  removeSmallComponents(water, N, 0, 60, 1);

  // --- 中心: 中央付近で半径 7 以内に水がなく、周囲に陸地が多い場所 ---
  let best = null;
  let bestScore = Infinity;
  for (let z = Math.floor(mid - 26); z <= mid + 26; z += 2) {
    for (let x = Math.floor(mid - 26); x <= mid + 26; x += 2) {
      const dm = Math.hypot(x - mid, z - mid);
      if (dm > 26) continue;
      let nearWater = false;
      let wCount = 0;
      let cnt = 0;
      for (let dz = -14; dz <= 14; dz++) {
        for (let dx = -14; dx <= 14; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > 196) continue;
          const xx = x + dx;
          const zz = z + dz;
          cnt++;
          const w = xx < 0 || zz < 0 || xx >= N || zz >= N ? 1 : water[zz * N + xx];
          if (w) {
            wCount++;
            if (d2 <= 49) nearWater = true;
          }
        }
      }
      if (nearWater) continue;
      const score = dm / 26 + (wCount / cnt) * 1.5;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  if (!best) {
    best = { x: Math.floor(mid), z: Math.floor(mid) };
    for (let dz = -7; dz <= 7; dz++) {
      for (let dx = -7; dx <= 7; dx++) {
        if (dx * dx + dz * dz <= 49) water[(best.z + dz) * N + best.x + dx] = 0;
      }
    }
  }

  // --- 書き込み & 森 ---
  const fv = new Float32Array(total);
  const landVals = [];
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      world.terrain[i] = water[i] ? TILE.WATER : TILE.LAND;
      world.trees[i] = 0;
      if (water[i]) continue;
      const d = Math.hypot(x - best.x, z - best.z);
      const v =
        fbm(nForest, x / 21 + 3.7, z / 21 + 8.1, 4) +
        0.22 * nForest(x / 5.3 + 40.5, z / 5.3 - 17.2) -
        0.25 * Math.exp(-(d * d) / (18 * 18));
      fv[i] = v;
      landVals.push(v);
    }
  }
  landVals.sort((a, b) => a - b);
  const thr = landVals.length ? landVals[Math.floor(landVals.length * 0.65)] : 1;
  for (let i = 0; i < total; i++) {
    if (water[i]) continue;
    const v = fv[i];
    const x = i % N;
    const z = (i / N) | 0;
    if (v > thr) world.trees[i] = v > thr + 0.17 ? 3 : v > thr + 0.07 ? 2 : 1;
    else if (hash2(x, z, seed) < 0.025) world.trees[i] = 1;
  }

  return { center: { x: best.x, z: best.z } };
}

// value と同じ連結成分でサイズ < minSize のものを replace に置き換える（4近傍）
function removeSmallComponents(grid, N, value, minSize, replace) {
  const seen = new Uint8Array(N * N);
  const stack = new Int32Array(N * N);
  const comp = [];
  for (let s = 0; s < N * N; s++) {
    if (seen[s] || grid[s] !== value) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    comp.length = 0;
    while (sp > 0) {
      const i = stack[--sp];
      comp.push(i);
      const x = i % N;
      if (x > 0 && !seen[i - 1] && grid[i - 1] === value) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < N - 1 && !seen[i + 1] && grid[i + 1] === value) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= N && !seen[i - N] && grid[i - N] === value) { seen[i - N] = 1; stack[sp++] = i - N; }
      if (i < N * N - N && !seen[i + N] && grid[i + N] === value) { seen[i + N] = 1; stack[sp++] = i + N; }
    }
    if (comp.length < minSize) for (const i of comp) grid[i] = replace;
  }
}
