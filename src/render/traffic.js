import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, ROAD, DIRS, clamp } from '../config.js';
import { ROAD_LAYOUT } from './roads.js';

// 道路網を走る車（左側通行、セル中心を通る3次ベジェで曲がる）

const CELL = CONFIG.CELL;
const HALF = CELL / 2;
const CAR_Y = 0.07;
const MAX_CARS = 1800;
const TRUCK_SHARE = 0.1;
const GLASS = [0.14, 0.17, 0.22];

// ---------------------------------------------------------------------------------------------
// ジオメトリ（前方 = ローカル +Z、底面 y=0）

// 面ビット（BoxGeometry の面順）: +x, -x, +y, -y, +z, -z
const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;
const SIDES = PX | NX | PZ | NZ;

// 指定面だけの箱（非インデックス）。車は最大 1800 台並ぶので、底面や車体に隠れる面は作らない
function box(w, h, d, faces) {
  const g = new THREE.BoxGeometry(w, h, d);
  const idx = g.index.array;
  const keep = [];
  for (let f = 0; f < 6; f++) if (faces & (1 << f)) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]);
  g.setIndex(keep);
  g.clearGroups();
  return g.toNonIndexed();
}

// 前(+Z)/後(-Z)向きの板（ライト用）
function plate(w, h, front) {
  const g = new THREE.PlaneGeometry(w, h);
  if (!front) g.rotateY(Math.PI);
  return g.toNonIndexed();
}

// color: 頂点色, paint: インスタンス色をどれだけ乗せるか (0..1)
function part(geo, color, paint, opts = {}) {
  if (opts.taper) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * opts.taper[0]);
        pos.setZ(i, pos.getZ(i) * opts.taper[1] + (opts.taper[2] || 0));
      }
    }
    geo.computeVertexNormals();
  }
  if (opts.at) geo.translate(opts.at[0], opts.at[1], opts.at[2]);
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const pt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = color[0];
    col[i * 3 + 1] = color[1];
    col[i * 3 + 2] = color[2];
    pt[i] = paint;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('paint', new THREE.BufferAttribute(pt, 1));
  return geo;
}

// 乗用車: 44 三角形（車輪 2 本の側面, 車体, キャビン（屋根はインスタンス色）, ライト 4 枚）
function makeCarGeometry() {
  const dark = [0.06, 0.06, 0.07];
  const parts = [
    part(box(0.7, 0.19, 0.28, SIDES), dark, 0, { at: [0, 0.095, 0.47] }),
    part(box(0.7, 0.19, 0.28, SIDES), dark, 0, { at: [0, 0.095, -0.47] }),
    part(box(0.66, 0.25, 1.5, SIDES | PY), [1, 1, 1], 1, { at: [0, 0.265, 0] }),
    part(box(0.58, 0.24, 0.82, SIDES), GLASS, 0, { taper: [0.86, 0.64, -0.02], at: [0, 0.51, -0.08] }),
    part(box(0.58, 0.24, 0.82, PY), [1, 1, 1], 1, { taper: [0.86, 0.64, -0.02], at: [0, 0.51, -0.08] }),
    part(plate(0.15, 0.06, true), [1, 0.96, 0.82], 0, { at: [-0.21, 0.3, 0.752] }),
    part(plate(0.15, 0.06, true), [1, 0.96, 0.82], 0, { at: [0.21, 0.3, 0.752] }),
    part(plate(0.15, 0.06, false), [0.7, 0.05, 0.04], 0, { at: [-0.21, 0.31, -0.752] }),
    part(plate(0.15, 0.06, false), [0.7, 0.05, 0.04], 0, { at: [0.21, 0.31, -0.752] }),
  ];
  return mergeGeometries(parts);
}

// トラック: 64 三角形
function makeTruckGeometry() {
  const dark = [0.06, 0.06, 0.07];
  const parts = [
    part(box(0.76, 0.24, 0.3, SIDES), dark, 0, { at: [0, 0.12, 0.78] }),
    part(box(0.76, 0.24, 0.3, SIDES), dark, 0, { at: [0, 0.12, -0.38] }),
    part(box(0.76, 0.24, 0.3, SIDES), dark, 0, { at: [0, 0.12, -0.8] }),
    part(box(0.7, 0.1, 2.3, SIDES | PY), [0.22, 0.22, 0.24], 0, { at: [0, 0.24, 0] }),
    part(box(0.72, 0.6, 0.62, SIDES | PY), [1, 1, 1], 1, { at: [0, 0.59, 0.84] }),
    part(plate(0.64, 0.22, true), GLASS, 0, { at: [0, 0.73, 1.152] }),
    part(box(0.76, 0.82, 1.58, SIDES | PY), [0.95, 0.95, 0.93], 0.22, { at: [0, 0.7, -0.32] }),
    part(plate(0.14, 0.07, true), [1, 0.96, 0.82], 0, { at: [-0.24, 0.38, 1.152] }),
    part(plate(0.14, 0.07, true), [1, 0.96, 0.82], 0, { at: [0.24, 0.38, 1.152] }),
    part(plate(0.14, 0.07, false), [0.7, 0.05, 0.04], 0, { at: [-0.26, 0.36, -1.112] }),
    part(plate(0.14, 0.07, false), [0.7, 0.05, 0.04], 0, { at: [0.26, 0.36, -1.112] }),
  ];
  return mergeGeometries(parts);
}

// 前後どちらか向きの発光板（夜のみ表示。加算合成なので板 1 枚で十分）
function glowBox(w, h, d, color, at) {
  const g = new THREE.PlaneGeometry(w, h + d);
  if (at[2] < 0) g.rotateY(Math.PI);
  g.translate(at[0], at[1], at[2] + (at[2] < 0 ? -d / 2 : d / 2));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(color, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// 路面を照らすヘッドライトの帯（手前が明るく先端で消える）
function beamQuad(z0, z1, w0, w1, y, c0) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([-w0 / 2, y, z0, w0 / 2, y, z0, w1 / 2, y, z1, -w1 / 2, y, z1]);
  const col = new Float32Array([...c0, ...c0, 0, 0, 0, 0, 0, 0]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

function makeLightGeometry(front, rear, halfSpan, y) {
  const head = [3.2, 2.9, 2.2];
  const tail = [2.4, 0.12, 0.06];
  return mergeGeometries([
    glowBox(0.17, 0.08, 0.03, head, [-halfSpan, y, front + 0.01]),
    glowBox(0.17, 0.08, 0.03, head, [halfSpan, y, front + 0.01]),
    glowBox(0.17, 0.08, 0.03, tail, [-halfSpan, y, rear - 0.01]),
    glowBox(0.17, 0.08, 0.03, tail, [halfSpan, y, rear - 0.01]),
    beamQuad(front + 0.05, front + 2.4, 0.55, 1.45, 0.02, [0.3, 0.27, 0.2]),
  ]);
}

function makeBodyMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.1 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float paint;\n${shader.vertexShader}`.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
      #if defined( USE_COLOR ) && defined( USE_INSTANCING_COLOR )
        vColor.xyz = color.xyz * mix(vec3(1.0), instanceColor.xyz, paint);
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'cgCarPaint';
  return mat;
}

const CAR_PALETTE = [
  [0xf3f3f0, 1.8], [0xc5c9cf, 1.2], [0x25282e, 1], [0x7b828c, 0.6], [0xd1332b, 1.3], [0x2a66d1, 1.2],
  [0xf2c230, 0.7], [0x3c9e58, 0.6], [0xef8127, 0.6], [0x8fcbe9, 0.7], [0x6b3f9b, 0.35], [0xe6dcc2, 0.6],
  [0x1f9e9a, 0.5], [0xe95f8e, 0.35],
];
const TRUCK_PALETTE = [[0xf5f5f2, 3], [0x2f6fd0, 1], [0x3a9a55, 0.8], [0xe9782a, 0.8], [0xcf3a30, 0.7], [0xf0c02e, 0.6]];

function pickColor(palette, out) {
  let total = 0;
  for (const p of palette) total += p[1];
  let r = Math.random() * total;
  for (const p of palette) {
    r -= p[1];
    if (r <= 0) return out.setHex(p[0]);
  }
  return out.setHex(palette[0][0]);
}

// ---------------------------------------------------------------------------------------------
// 車群（SoA、スワップ削除）

const FS = 16; // float stride: p0..p3 (8), t, len, speed, vfac, scale, life, yaw, -
const IS = 5; // int stride: cell, dIn, dOut, lane, state(0=走行,1=消滅中)
const F_T = 8;
const F_LEN = 9;
const F_SPEED = 10;
const F_VFAC = 11;
const F_SCALE = 12;
const F_LIFE = 13;
const F_YAW = 14;
const I_CELL = 0;
const I_IN = 1;
const I_OUT = 2;
const I_LANE = 3;
const I_STATE = 4;

class Fleet {
  constructor(group, geometry, lightGeometry, bodyMat, lightMat, palette, capacity) {
    this.group = group;
    this.geometry = geometry;
    this.lightGeometry = lightGeometry;
    this.bodyMat = bodyMat;
    this.lightMat = lightMat;
    this.palette = palette;
    this.count = 0;
    this.dying = 0;
    this.capacity = 0;
    this.spawnAcc = 0;
    this.despawnAcc = 0;
    this.f = new Float32Array(0);
    this.n = new Int32Array(0);
    this.mesh = null;
    this.lights = null;
    this._alloc(capacity);
  }

  _alloc(capacity) {
    const f = new Float32Array(capacity * FS);
    const n = new Int32Array(capacity * IS);
    f.set(this.f.subarray(0, this.count * FS));
    n.set(this.n.subarray(0, this.count * IS));
    this.f = f;
    this.n = n;

    const mesh = new THREE.InstancedMesh(this.geometry, this.bodyMat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const lights = new THREE.InstancedMesh(this.lightGeometry, this.lightMat, 1);
    lights.instanceMatrix = mesh.instanceMatrix;
    if (this.mesh) {
      mesh.instanceMatrix.array.set(this.mesh.instanceMatrix.array.subarray(0, this.count * 16));
      mesh.instanceColor.array.set(this.mesh.instanceColor.array.subarray(0, this.count * 3));
      lights.visible = this.lights.visible;
      this.group.remove(this.mesh, this.lights);
      this.mesh.dispose();
      this.lights.dispose();
    } else {
      lights.visible = false;
    }
    for (const m of [mesh, lights]) {
      m.count = this.count;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = -2; // 建物（-3）の後・地形（0）の前（roads.js と同じ）
    lights.renderOrder = 3;
    this.mesh = mesh;
    this.lights = lights;
    this.capacity = capacity;
  }

  add() {
    if (this.count >= this.capacity) this._alloc(this.capacity * 2);
    const i = this.count++;
    this.f.fill(0, i * FS, (i + 1) * FS);
    this.n.fill(0, i * IS, (i + 1) * IS);
    return i;
  }

  remove(i) {
    const last = this.count - 1;
    if (this.n[i * IS + I_STATE] === 1) this.dying--;
    if (i !== last) {
      this.f.copyWithin(i * FS, last * FS, (last + 1) * FS);
      this.n.copyWithin(i * IS, last * IS, (last + 1) * IS);
      const m = this.mesh.instanceMatrix.array;
      m.copyWithin(i * 16, last * 16, (last + 1) * 16);
      const c = this.mesh.instanceColor.array;
      c.copyWithin(i * 3, last * 3, (last + 1) * 3);
    }
    this.count = last;
    this.mesh.instanceColor.needsUpdate = true;
  }

  sync() {
    this.mesh.count = this.count;
    this.lights.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------

function laneOffset(type, lane) {
  const lanes = (ROAD_LAYOUT[type] || ROAD_LAYOUT[ROAD.STREET]).lanes;
  return lanes[lane < lanes.length ? lane : lanes.length - 1] * CELL;
}

export class TrafficView {
  constructor(scene, city) {
    this.city = city;
    this.world = city.world;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);

    const size = this.world.size;
    this._roadFlag = new Uint8Array(size * size);
    this._roadCells = new Int32Array(1024);
    this._roadCount = 0;
    for (let i = 0; i < size * size; i++) if (this.world.road[i]) this._addRoadIndex(i);
    city.events.on('road:add', ({ x, z }) => {
      if (this.world.inBounds(x, z)) this._addRoadIndex(this.world.idx(x, z));
    });

    this._color = new THREE.Color();
    this._lastNight = -1;
    const bodyMat = makeBodyMaterial();
    this.lightMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.cars = new Fleet(
      this.group,
      makeCarGeometry(),
      makeLightGeometry(0.755, -0.755, 0.21, 0.3),
      bodyMat,
      this.lightMat,
      CAR_PALETTE,
      2048,
    );
    this.trucks = new Fleet(
      this.group,
      makeTruckGeometry(),
      makeLightGeometry(1.155, -1.115, 0.25, 0.37),
      bodyMat,
      this.lightMat,
      TRUCK_PALETTE,
      256,
    );
    this.cars.vfacRange = [0.85, 1.15];
    this.trucks.vfacRange = [0.7, 0.85];
    this.cars.halfLen = 0.76;
    this.trucks.halfLen = 1.17;
    this._fleets = [this.cars, this.trucks];

    this._head = new Int32Array(size * size * 8).fill(-1);
    this._touched = new Int32Array(4096);
    this._touchedCount = 0;
    this._next = new Int32Array(2048);
    this._total = 0;
    this._gapHalf = 0;
  }

  _addRoadIndex(i) {
    if (this._roadFlag[i]) return;
    this._roadFlag[i] = 1;
    if (this._roadCount >= this._roadCells.length) {
      const next = new Int32Array(this._roadCells.length * 2);
      next.set(this._roadCells);
      this._roadCells = next;
    }
    this._roadCells[this._roadCount++] = i;
  }

  _mask(x, z) {
    const w = this.world;
    const size = w.size;
    const road = w.road;
    const i = z * size + x;
    let m = 0;
    if (z > 0 && road[i - size]) m |= 1;
    if (x < size - 1 && road[i + 1]) m |= 2;
    if (z < size - 1 && road[i + size]) m |= 4;
    if (x > 0 && road[i - 1]) m |= 8;
    return m;
  }

  // 次の出口方向: 直進を優先、Uターンは行き止まりのみ
  _chooseExit(x, z, dIn) {
    const mask = this._mask(x, z);
    const back = (dIn + 2) & 3;
    const road = this.world.road;
    const size = this.world.size;
    const here = road[z * size + x];
    let total = 0;
    let choice = back;
    for (let k = 0; k < 4; k++) {
      if (k === back || !(mask & DIRS[k].bit)) continue;
      const d = DIRS[k];
      const nt = road[(z + d.dz) * size + (x + d.dx)];
      let wgt = k === dIn ? (here >= ROAD.AVENUE ? 6 : 3) : 1;
      if (nt > here) wgt *= 1.6;
      total += wgt;
      if (Math.random() * total < wgt) choice = k;
    }
    return choice;
  }

  // P0 は設定済み。セル (x,z) を dIn で進入し dOut で出る経路を作る
  _buildPath(fleet, i, x, z, dIn, dOut) {
    const w = this.world;
    const size = w.size;
    const f = fleet.f;
    const o = i * FS;
    const lane = fleet.n[i * IS + I_LANE];
    const type = w.road[z * size + x] || ROAD.STREET;
    const cx = (x - size / 2 + 0.5) * CELL;
    const cz = (z - size / 2 + 0.5) * CELL;

    const eo = DIRS[dOut];
    const nx = x + eo.dx;
    const nz = z + eo.dz;
    const nt = nx >= 0 && nz >= 0 && nx < size && nz < size ? w.road[nz * size + nx] : 0;
    const off = laneOffset(nt ? Math.min(type, nt) : type, lane);
    const p0x = f[o];
    const p0z = f[o + 1];
    const p3x = cx + eo.dx * HALF + eo.dz * off;
    const p3z = cz + eo.dz * HALF - eo.dx * off;
    const di = DIRS[dIn];
    let p1x, p1z, p2x, p2z;
    if (dOut === dIn) {
      const k = CELL / 3;
      p1x = p0x + di.dx * k;
      p1z = p0z + di.dz * k;
      p2x = p3x - di.dx * k;
      p2z = p3z - di.dz * k;
    } else if (dOut === ((dIn + 2) & 3)) {
      const k = CELL * 0.62;
      p1x = p0x + di.dx * k;
      p1z = p0z + di.dz * k;
      p2x = p3x + di.dx * k;
      p2z = p3z + di.dz * k;
    } else {
      // 進入車線と退出車線の交点を制御点にした2次曲線 → 3次に昇格
      const proj = (p3x - p0x) * di.dx + (p3z - p0z) * di.dz;
      const qx = p0x + di.dx * proj;
      const qz = p0z + di.dz * proj;
      p1x = p0x + (qx - p0x) * (2 / 3);
      p1z = p0z + (qz - p0z) * (2 / 3);
      p2x = p3x + (qx - p3x) * (2 / 3);
      p2z = p3z + (qz - p3z) * (2 / 3);
    }
    f[o + 2] = p1x;
    f[o + 3] = p1z;
    f[o + 4] = p2x;
    f[o + 5] = p2z;
    f[o + 6] = p3x;
    f[o + 7] = p3z;

    let len = 0;
    let lx = p0x;
    let lz = p0z;
    for (let s = 1; s <= 6; s++) {
      const t = s / 6;
      const u = 1 - t;
      const b0 = u * u * u;
      const b1 = 3 * u * u * t;
      const b2 = 3 * u * t * t;
      const b3 = t * t * t;
      const px = b0 * p0x + b1 * p1x + b2 * p2x + b3 * p3x;
      const pz = b0 * p0z + b1 * p1z + b2 * p2z + b3 * p3z;
      len += Math.hypot(px - lx, pz - lz);
      lx = px;
      lz = pz;
    }
    f[o + F_LEN] = Math.max(0.25, len);
    const n = fleet.n;
    n[i * IS + I_CELL] = z * size + x;
    n[i * IS + I_IN] = dIn;
    n[i * IS + I_OUT] = dOut;
  }

  _spawn(fleet) {
    const count = this._roadCount;
    if (count === 0) return false;
    const w = this.world;
    const size = w.size;
    for (let tries = 0; tries < 6; tries++) {
      const ci = this._roadCells[(Math.random() * count) | 0];
      const x = ci % size;
      const z = (ci / size) | 0;
      const mask = this._mask(x, z);
      if (mask === 0) continue;
      // 地価の高い（にぎやかな）場所ほど湧きやすい
      if (tries < 4 && Math.random() > 0.3 + (w.landValue[ci] || 0)) continue;

      let pickK = -1;
      let seen = 0;
      for (let k = 0; k < 4; k++) {
        if (mask & DIRS[k].bit && Math.random() * ++seen < 1) pickK = k;
      }
      const dIn = (pickK + 2) & 3;
      const i = fleet.add();
      const f = fleet.f;
      const nn = fleet.n;
      const o = i * FS;
      const lane = Math.random() < 0.5 ? 0 : 1;
      nn[i * IS + I_LANE] = lane;
      nn[i * IS + I_STATE] = 0;

      const type = w.road[ci];
      const bt = w.road[ci + DIRS[pickK].dz * size + DIRS[pickK].dx];
      const off = laneOffset(Math.min(type, bt || type), lane);
      const d = DIRS[dIn];
      const cx = (x - size / 2 + 0.5) * CELL;
      const cz = (z - size / 2 + 0.5) * CELL;
      f[o] = cx - d.dx * HALF + d.dz * off;
      f[o + 1] = cz - d.dz * HALF - d.dx * off;
      this._buildPath(fleet, i, x, z, dIn, this._chooseExit(x, z, dIn));

      const [v0, v1] = fleet.vfacRange;
      f[o + F_T] = Math.random() * 0.7;
      f[o + F_VFAC] = v0 + Math.random() * (v1 - v0);
      f[o + F_SPEED] = (ROAD_LAYOUT[type] || ROAD_LAYOUT[ROAD.STREET]).speed * f[o + F_VFAC] * 0.6;
      f[o + F_SCALE] = 0;
      f[o + F_LIFE] = 30 + Math.random() * 60;
      f[o + F_YAW] = Math.atan2(d.dx, d.dz);

      const col = pickColor(fleet.palette, this._color);
      const jitter = 0.92 + Math.random() * 0.1;
      const ca = fleet.mesh.instanceColor.array;
      ca[i * 3] = col.r * jitter;
      ca[i * 3 + 1] = col.g * jitter;
      ca[i * 3 + 2] = col.b * jitter;
      fleet.mesh.instanceColor.needsUpdate = true;
      return true;
    }
    return false;
  }

  // 次のセルへ（P0 = 前の P3 なので道路種別が変わっても位置は飛ばない）
  _advance(fleet, i) {
    const w = this.world;
    const size = w.size;
    const nn = fleet.n;
    const f = fleet.f;
    const o = i * FS;
    const ci = nn[i * IS + I_CELL];
    const dOut = nn[i * IS + I_OUT];
    let x = ci % size;
    let z = (ci / size) | 0;
    const d = DIRS[dOut];
    const nx = x + d.dx;
    const nz = z + d.dz;
    let dIn = dOut;
    if (nx >= 0 && nz >= 0 && nx < size && nz < size && w.road[nz * size + nx]) {
      x = nx;
      z = nz;
    } else {
      dIn = (dOut + 2) & 3; // 行き先がない（孤立セル）: 同じセルで折り返す
    }
    f[o] = f[o + 6];
    f[o + 1] = f[o + 7];
    this._buildPath(fleet, i, x, z, dIn, this._chooseExit(x, z, dIn));
  }

  _manage(fleet, target, step) {
    const alive = fleet.count - fleet.dying;
    if (alive < target) {
      fleet.despawnAcc = 0;
      fleet.spawnAcc = Math.min(fleet.spawnAcc + step * (2 + (target - alive) * 0.6), 30);
      let guard = 0;
      while (fleet.spawnAcc >= 1 && fleet.count - fleet.dying < target && guard++ < 30) {
        fleet.spawnAcc -= 1;
        if (!this._spawn(fleet)) break;
      }
    } else if (alive > target) {
      fleet.spawnAcc = 0;
      fleet.despawnAcc = Math.min(fleet.despawnAcc + step * (1.5 + (alive - target) * 0.5), 30);
      let guard = 0;
      while (fleet.despawnAcc >= 1 && fleet.count - fleet.dying > target && guard++ < 60) {
        fleet.despawnAcc -= 1;
        const i = (Math.random() * fleet.count) | 0;
        if (fleet.n[i * IS + I_STATE] === 0) {
          fleet.n[i * IS + I_STATE] = 1;
          fleet.dying++;
        }
      }
    }
  }

  // 出現・消滅アニメと寿命
  _lifecycle(fleet, step) {
    const f = fleet.f;
    const nn = fleet.n;
    for (let i = 0; i < fleet.count; i++) {
      const o = i * FS;
      const io = i * IS;
      if (nn[io + I_STATE] === 1) {
        f[o + F_SCALE] -= step * 2.2;
        if (f[o + F_SCALE] <= 0) {
          fleet.remove(i);
          i--;
        }
      } else {
        if (f[o + F_SCALE] < 1) f[o + F_SCALE] = Math.min(1, f[o + F_SCALE] + step * 2.2);
        f[o + F_LIFE] -= step;
        if (f[o + F_LIFE] <= 0) {
          nn[io + I_STATE] = 1;
          fleet.dying++;
        }
      }
    }
  }

  _laneKey(cell, dIn, lane) {
    const type = this.world.road[cell] || ROAD.STREET;
    const nl = ROAD_LAYOUT[type].lanes.length;
    return (cell * 4 + dIn) * 2 + (lane < nl ? lane : nl - 1);
  }

  // 同じセル・進入方向・車線ごとの連結リスト（前方車の検索用）
  _buildOccupancy() {
    const fleets = this._fleets;
    let total = 0;
    for (const fl of fleets) total += fl.count;
    if (this._next.length < total) this._next = new Int32Array(Math.max(total, this._next.length * 2));
    const head = this._head;
    for (let k = 0; k < this._touchedCount; k++) head[this._touched[k]] = -1;
    this._touchedCount = 0;
    let base = 0;
    for (const fl of fleets) {
      fl.base = base;
      const nn = fl.n;
      for (let i = 0; i < fl.count; i++) {
        const io = i * IS;
        const key = this._laneKey(nn[io + I_CELL], nn[io + I_IN], nn[io + I_LANE]);
        if (head[key] === -1) {
          if (this._touchedCount >= this._touched.length) {
            const t = new Int32Array(this._touched.length * 2);
            t.set(this._touched);
            this._touched = t;
          }
          this._touched[this._touchedCount++] = key;
        }
        this._next[base + i] = head[key];
        head[key] = base + i;
      }
      base += fl.count;
    }
    this._total = base;
  }

  _fleetOf(id) {
    const fl = this._fleets;
    return id >= fl[1].base ? fl[1] : fl[0];
  }

  // 前方車までの距離（見つからなければ Infinity）。out[0] に前方車の車長の半分
  _gapAhead(fleet, i) {
    const size = this.world.size;
    const road = this.world.road;
    const nn = fleet.n;
    const f = fleet.f;
    const io = i * IS;
    const o = i * FS;
    const cell = nn[io + I_CELL];
    const dOut = nn[io + I_OUT];
    const lane = nn[io + I_LANE];
    const t = f[o + F_T];
    const len = f[o + F_LEN];
    const self = fleet.base + i;
    let best = Infinity;
    let bestHalf = 0;

    let id = this._head[this._laneKey(cell, nn[io + I_IN], lane)];
    while (id !== -1) {
      if (id !== self) {
        const lf = this._fleetOf(id);
        const j = id - lf.base;
        if (j < lf.count && lf.n[j * IS + I_CELL] === cell) {
          const tl = lf.f[j * FS + F_T];
          if (tl > t || (tl === t && id > self)) {
            const g = (tl - t) * len;
            if (g < best) {
              best = g;
              bestHalf = lf.halfLen;
            }
          }
        }
      }
      id = this._next[id];
    }
    if (best !== Infinity) {
      this._gapHalf = bestHalf;
      return best;
    }

    const x = (cell % size) + DIRS[dOut].dx;
    const z = ((cell / size) | 0) + DIRS[dOut].dz;
    if (x < 0 || z < 0 || x >= size || z >= size) return Infinity;
    const nc = z * size + x;
    if (!road[nc]) return Infinity;
    id = this._head[this._laneKey(nc, dOut, lane)];
    while (id !== -1) {
      const lf = this._fleetOf(id);
      const j = id - lf.base;
      if (j < lf.count && lf.n[j * IS + I_CELL] === nc) {
        const g = (1 - t) * len + lf.f[j * FS + F_T] * lf.f[j * FS + F_LEN];
        if (g < best) {
          best = g;
          bestHalf = lf.halfLen;
        }
      }
      id = this._next[id];
    }
    this._gapHalf = bestHalf;
    return best;
  }

  _move(fleet, step) {
    const road = this.world.road;
    const f = fleet.f;
    const nn = fleet.n;
    for (let i = 0; i < fleet.count; i++) {
      const o = i * FS;
      const io = i * IS;
      const dIn = nn[io + I_IN];
      const dOut = nn[io + I_OUT];
      const type = road[nn[io + I_CELL]] || ROAD.STREET;
      let vt = ROAD_LAYOUT[type].speed * f[o + F_VFAC];
      if (dOut !== dIn) vt *= dOut === ((dIn + 2) & 3) ? 0.35 : 0.55;

      // 車間距離（詰まり続けたら少しの間すり抜けを許してデッドロック回避）
      let stall = f[o + 15];
      let blocked = false;
      if (stall < 0) {
        stall = Math.min(0, stall + step);
      } else {
        const gap = this._gapAhead(fleet, i);
        if (gap < 6) {
          const need = fleet.halfLen + this._gapHalf + 0.4;
          const k = clamp((gap - need) / 2.2, 0, 1);
          vt *= k;
          blocked = k < 0.05;
        }
        if (blocked && f[o + F_SPEED] < 0.05) {
          stall += step;
          if (stall > 4) stall = -2.5;
        } else {
          stall = 0;
        }
      }
      f[o + 15] = stall;

      const sp = f[o + F_SPEED];
      f[o + F_SPEED] = blocked ? 0 : sp + (vt - sp) * Math.min(1, step * (vt < sp ? 6 : 2.5));
      f[o + F_T] += (f[o + F_SPEED] * step) / f[o + F_LEN];
      let guard = 0;
      while (f[o + F_T] >= 1 && guard++ < 8) {
        const carry = (f[o + F_T] - 1) * f[o + F_LEN];
        this._advance(fleet, i);
        f[o + F_T] = carry / f[o + F_LEN];
      }
      if (f[o + F_T] > 1) f[o + F_T] = 1;
    }
  }

  _writeMatrices(fleet) {
    const f = fleet.f;
    const a = fleet.mesh.instanceMatrix.array;
    for (let i = 0; i < fleet.count; i++) {
      const o = i * FS;
      const t = f[o + F_T];
      const u = 1 - t;
      const b0 = u * u * u;
      const b1 = 3 * u * u * t;
      const b2 = 3 * u * t * t;
      const b3 = t * t * t;
      const px = b0 * f[o] + b1 * f[o + 2] + b2 * f[o + 4] + b3 * f[o + 6];
      const pz = b0 * f[o + 1] + b1 * f[o + 3] + b2 * f[o + 5] + b3 * f[o + 7];
      const d0 = 3 * u * u;
      const d1 = 6 * u * t;
      const d2 = 3 * t * t;
      const tx = d0 * (f[o + 2] - f[o]) + d1 * (f[o + 4] - f[o + 2]) + d2 * (f[o + 6] - f[o + 4]);
      const tz = d0 * (f[o + 3] - f[o + 1]) + d1 * (f[o + 5] - f[o + 3]) + d2 * (f[o + 7] - f[o + 5]);
      if (tx * tx + tz * tz > 1e-8) f[o + F_YAW] = Math.atan2(tx, tz);
      const yaw = f[o + F_YAW];
      const s0 = f[o + F_SCALE];
      const sc = s0 * s0 * (3 - 2 * s0);
      const c = Math.cos(yaw) * sc;
      const s = Math.sin(yaw) * sc;
      const m = i * 16;
      a[m] = c;
      a[m + 1] = 0;
      a[m + 2] = -s;
      a[m + 3] = 0;
      a[m + 4] = 0;
      a[m + 5] = sc;
      a[m + 6] = 0;
      a[m + 7] = 0;
      a[m + 8] = s;
      a[m + 9] = 0;
      a[m + 10] = c;
      a[m + 11] = 0;
      a[m + 12] = px;
      a[m + 13] = CAR_Y;
      a[m + 14] = pz;
      a[m + 15] = 1;
    }
    fleet.sync();
  }

  update(env) {
    const dt = env.dt || 0;
    const simDt = env.simDt || 0;
    // 高速再生でも目で追える速さに抑える（一時停止中は 0）
    const step = Math.min(simDt, dt * 4);

    if (step > 0) {
      const pop = (this.city.stats && this.city.stats.population) || 0;
      const target = Math.min(clamp(Math.round(pop / 20), 8, MAX_CARS), Math.floor(this._roadCount * 0.35));
      const trucks = Math.round(target * TRUCK_SHARE);
      this._manage(this.cars, target - trucks, step);
      this._manage(this.trucks, trucks, step);
      this._lifecycle(this.cars, step);
      this._lifecycle(this.trucks, step);
      this._buildOccupancy();
      this._move(this.cars, step);
      this._move(this.trucks, step);
      this._writeMatrices(this.cars);
      this._writeMatrices(this.trucks);
    }

    const night = env.night || 0;
    if (Math.abs(night - this._lastNight) > 0.004) {
      this._lastNight = night;
      const on = night > 0.03;
      this.lightMat.color.setScalar(Math.min(1, night * 1.3));
      this.cars.lights.visible = on;
      this.trucks.lights.visible = on;
    }
  }
}
