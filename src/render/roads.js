import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, TILE, ROAD, DIRS } from '../config.js';
import { hash2, mulberry32 } from '../core/rng.js';

// 道路タイル（接続マスク別の回転インスタンス）＋ 立体の歩道・ガードレール・橋・街灯

const CELL = CONFIG.CELL;
const HALF = CELL / 2;
const ROAD_Y = 0.06;
const TEX = 512;
const REBUILD_INTERVAL = 0.2;

// 道路幅のレイアウト（セル幅に対する比率）。traffic.js と共有
// curb: 片側の歩道/路肩の幅, lanes: 中心線からの車線中心, edge: 外側線, speed: 車の基準速度(ワールド単位/シム秒)
export const ROAD_LAYOUT = Object.freeze({
  [ROAD.STREET]: Object.freeze({ curb: 0.13, lanes: Object.freeze([0.185]), edge: 0.35, speed: 3.0 }),
  [ROAD.AVENUE]: Object.freeze({ curb: 0.08, lanes: Object.freeze([0.105, 0.315]), edge: 0.4, speed: 4.6 }),
  [ROAD.HIGHWAY]: Object.freeze({ curb: 0.05, lanes: Object.freeze([0.135, 0.345]), edge: 0.43, speed: 7.0 }),
});

export const VARIANT = Object.freeze({ SINGLE: 0, DEAD: 1, STRAIGHT: 2, CORNER: 3, T: 4, CROSS: 5 });
// 各バリアントの基準マスク（テクスチャ上は上=北）: 行き止まり=N, 直線=N|S, 角=N|E, T=N|E|S
const CANON_MASK = [0, 1, 5, 3, 7, 15];

// マスクを時計回り (N→E→S→W) に k 回回す
export function rotMaskCW(mask, k) {
  k &= 3;
  return ((mask << k) | (mask >> (4 - k))) & 15;
}

// mask → { variant, rot }。rot = 時計回り1/4回転の回数。three の rotation.y = -rot * PI/2
const TILE_TABLE = (() => {
  const table = [];
  for (let mask = 0; mask < 16; mask++) {
    search: for (let v = 0; v < CANON_MASK.length; v++) {
      for (let k = 0; k < 4; k++) {
        if (rotMaskCW(CANON_MASK[v], k) === mask) {
          table[mask] = Object.freeze({ variant: v, rot: k });
          break search;
        }
      }
    }
  }
  return Object.freeze(table);
})();

export function maskToTile(mask) {
  return TILE_TABLE[mask & 15];
}

// ---------------------------------------------------------------------------------------------
// キャンバステクスチャ

const WHITE = 'rgba(236,236,228,0.95)';
const YELLOW = 'rgba(235,178,48,0.95)';
const MEDIAN = '#8f8d87';
const ASPHALT_RGB = {
  [ROAD.STREET]: [80, 83, 88],
  [ROAD.AVENUE]: [71, 74, 79],
  [ROAD.HIGHWAY]: [60, 62, 67],
};

function makeCanvas(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  return cv;
}

function makeAsphalt(type, seed) {
  const cv = makeCanvas(TEX);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(TEX, TEX);
  const d = img.data;
  const rand = mulberry32(seed);
  const [r0, g0, b0] = ASPHALT_RGB[type];
  for (let i = 0; i < d.length; i += 4) {
    let n = (rand() - 0.5) * 16;
    const s = rand();
    if (s < 0.018) n += 26;
    else if (s < 0.03) n -= 18;
    d[i] = r0 + n;
    d[i + 1] = g0 + n;
    d[i + 2] = b0 + n * 1.05;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function strokeLine(ctx, x0, y0, x1, y1, width, color, dash, period) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  strokeWith(ctx, width, color, dash, period);
}

// dash: ダッシュ長, period: 周期。ダッシュは周期の中央に置く（タイル端は必ず隙間 → 継ぎ目で揃う）
function strokeWith(ctx, width, color, dash = 0, period = 0) {
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  if (dash > 0) {
    ctx.setLineDash([dash, period - dash]);
    ctx.lineDashOffset = -(period - dash) / 2;
  } else {
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// 中心 (cx,cy) の 1/4 円弧上の破線。弧長に合わせて周期を調整
function strokeArc(ctx, cx, cy, r, a0, a1, width, color, dashFrac = 0) {
  if (r <= 0.001) return;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1, false);
  if (dashFrac > 0) {
    const len = r * Math.abs(a1 - a0);
    const n = Math.max(1, Math.round(len / 0.5));
    const p = len / n;
    strokeWith(ctx, width, color, p * dashFrac, p);
  } else {
    strokeWith(ctx, width, color);
  }
}

// 縦方向の線群（x=0.5 を中心線とする、y0→y1）。edges=false なら外側線なし
function drawLongitudinal(ctx, type, y0, y1, edges) {
  const L = ROAD_LAYOUT[type];
  if (type === ROAD.STREET) {
    strokeLine(ctx, 0.5, y0, 0.5, y1, 0.014, WHITE, 0.22, 0.5);
  } else if (type === ROAD.AVENUE) {
    strokeLine(ctx, 0.488, y0, 0.488, y1, 0.01, YELLOW);
    strokeLine(ctx, 0.512, y0, 0.512, y1, 0.01, YELLOW);
    strokeLine(ctx, 0.29, y0, 0.29, y1, 0.012, WHITE, 0.2, 0.5);
    strokeLine(ctx, 0.71, y0, 0.71, y1, 0.012, WHITE, 0.2, 0.5);
  } else {
    ctx.fillStyle = MEDIAN;
    ctx.fillRect(0.47, y0, 0.06, y1 - y0);
    ctx.fillStyle = 'rgba(40,40,40,0.5)';
    ctx.fillRect(0.465, y0, 0.006, y1 - y0);
    ctx.fillRect(0.529, y0, 0.006, y1 - y0);
    strokeLine(ctx, 0.455, y0, 0.455, y1, 0.01, YELLOW);
    strokeLine(ctx, 0.545, y0, 0.545, y1, 0.01, YELLOW);
    strokeLine(ctx, 0.26, y0, 0.26, y1, 0.014, WHITE, 0.28, 0.5);
    strokeLine(ctx, 0.74, y0, 0.74, y1, 0.014, WHITE, 0.28, 0.5);
  }
  if (edges) {
    strokeLine(ctx, 0.5 - L.edge, y0, 0.5 - L.edge, y1, 0.012, WHITE);
    strokeLine(ctx, 0.5 + L.edge, y0, 0.5 + L.edge, y1, 0.012, WHITE);
  }
}

// 北東の角 (1,0) を中心にした弧群（N→E のカーブ）。縦線 x に対して半径 1-x
function drawCornerArcs(ctx, type) {
  const L = ROAD_LAYOUT[type];
  const A0 = Math.PI / 2;
  const A1 = Math.PI;
  if (type === ROAD.STREET) {
    strokeArc(ctx, 1, 0, 0.5, A0, A1, 0.014, WHITE, 0.44);
  } else if (type === ROAD.AVENUE) {
    strokeArc(ctx, 1, 0, 0.512, A0, A1, 0.01, YELLOW);
    strokeArc(ctx, 1, 0, 0.488, A0, A1, 0.01, YELLOW);
    strokeArc(ctx, 1, 0, 0.71, A0, A1, 0.012, WHITE, 0.4);
    strokeArc(ctx, 1, 0, 0.29, A0, A1, 0.012, WHITE, 0.4);
  } else {
    strokeArc(ctx, 1, 0, 0.5, A0, A1, 0.06, MEDIAN);
    strokeArc(ctx, 1, 0, 0.545, A0, A1, 0.01, YELLOW);
    strokeArc(ctx, 1, 0, 0.455, A0, A1, 0.01, YELLOW);
    strokeArc(ctx, 1, 0, 0.74, A0, A1, 0.014, WHITE, 0.56);
    strokeArc(ctx, 1, 0, 0.26, A0, A1, 0.014, WHITE, 0.56);
  }
  strokeArc(ctx, 1, 0, 0.5 + L.edge, A0, A1, 0.012, WHITE);
  strokeArc(ctx, 1, 0, 0.5 - L.edge, A0, A1, 0.012, WHITE);
}

// 交差点の北側アーム: 停止線（左側通行 → 南行きは東半分）＋ AVENUE は横断歩道
function drawJunctionArm(ctx, type) {
  const L = ROAD_LAYOUT[type];
  const as = 0.5 - L.curb;
  if (type === ROAD.HIGHWAY) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(0.515, 0.02, as - 0.03, 0.026);
    ctx.fillStyle = YELLOW;
    ctx.fillRect(0.47, 0.0, 0.06, 0.05);
    return;
  }
  if (type === ROAD.AVENUE) {
    ctx.fillStyle = WHITE;
    const x0 = 0.5 - as + 0.02;
    const x1 = 0.5 + as - 0.02;
    const stripe = 0.04;
    const gap = 0.034;
    const n = Math.floor((x1 - x0 + gap) / (stripe + gap));
    const start = (x0 + x1) / 2 - (n * stripe + (n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) ctx.fillRect(start + i * (stripe + gap), 0.065, stripe, 0.12);
    ctx.fillRect(0.515, 0.018, as - 0.03, 0.018);
  } else {
    ctx.fillStyle = WHITE;
    ctx.fillRect(0.51, 0.03, as - 0.035, 0.02);
  }
}

function withRotation(ctx, k, fn) {
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.rotate((k * Math.PI) / 2);
  ctx.translate(-0.5, -0.5);
  fn();
  ctx.restore();
}

// 走行跡（うっすら暗い帯）
function drawWear(ctx, type, variant) {
  const L = ROAD_LAYOUT[type];
  ctx.globalAlpha = 0.07;
  const col = '#1c1d20';
  for (const lane of L.lanes) {
    for (const side of [-1, 1]) {
      const x = 0.5 + side * lane;
      for (const w of [-0.055, 0.055]) {
        if (variant === VARIANT.STRAIGHT) strokeLine(ctx, x + w, 0, x + w, 1, 0.035, col);
        else if (variant === VARIANT.CORNER) strokeArc(ctx, 1, 0, 1 - (x + w), Math.PI / 2, Math.PI, 0.035, col);
        else if (variant === VARIANT.DEAD) strokeLine(ctx, x + w, 0, x + w, 0.5, 0.035, col);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function makeTileTexture(type, variant, asphalt, seed) {
  const cv = makeCanvas(TEX);
  const ctx = cv.getContext('2d');
  ctx.drawImage(asphalt, 0, 0);
  ctx.save();
  ctx.scale(TEX, TEX);
  drawWear(ctx, type, variant);
  ctx.restore();

  const mk = makeCanvas(TEX);
  const m = mk.getContext('2d');
  m.save();
  m.scale(TEX, TEX);
  m.lineCap = 'butt';
  const L = ROAD_LAYOUT[type];
  switch (variant) {
    case VARIANT.STRAIGHT:
      drawLongitudinal(m, type, 0, 1, true);
      break;
    case VARIANT.DEAD: {
      drawLongitudinal(m, type, 0, 0.5, false);
      m.beginPath();
      m.moveTo(0.5 - L.edge, 0);
      m.lineTo(0.5 - L.edge, 0.5);
      m.arc(0.5, 0.5, L.edge, Math.PI, 0, true);
      m.lineTo(0.5 + L.edge, 0);
      strokeWith(m, 0.012, WHITE);
      break;
    }
    case VARIANT.CORNER:
      drawCornerArcs(m, type);
      break;
    case VARIANT.T:
    case VARIANT.CROSS: {
      const arms = variant === VARIANT.T ? [0, 1, 2] : [0, 1, 2, 3];
      for (const k of arms) withRotation(m, k, () => drawJunctionArm(m, type));
      // 接続された角の外側線（北東角を回転）
      const corners = variant === VARIANT.T ? [0, 1] : [0, 1, 2, 3];
      for (const k of corners) {
        withRotation(m, k, () => strokeArc(m, 1, 0, 0.5 - L.edge, Math.PI / 2, Math.PI, 0.012, WHITE));
      }
      if (variant === VARIANT.T) strokeLine(m, 0.5 - L.edge, 0, 0.5 - L.edge, 1, 0.012, WHITE);
      break;
    }
    case VARIANT.SINGLE:
    default:
      m.beginPath();
      m.arc(0.5, 0.5, L.edge, 0, Math.PI * 2);
      strokeWith(m, 0.012, WHITE);
      break;
  }
  m.restore();

  // かすれ
  const rand = mulberry32(seed);
  m.globalCompositeOperation = 'destination-out';
  m.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < 2600; i++) {
    const s = 1 + rand() * 2.5;
    m.fillRect(rand() * TEX, rand() * TEX, s, s);
  }
  m.globalCompositeOperation = 'source-over';

  ctx.globalAlpha = 0.92;
  ctx.drawImage(mk, 0, 0);
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function makeGlowTexture() {
  const cv = makeCanvas(128);
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,214,150,1)');
  g.addColorStop(0.35, 'rgba(255,190,120,0.55)');
  g.addColorStop(1, 'rgba(255,170,100,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// ジオメトリ・マテリアル

const SW_H = 0.14; // 歩道の天端（道路面 0.06 から縁石 8cm 相当）
const OPAQUE_RENDER_ORDER = -2;

// 縁石まわりの小物は数千個並ぶので、見える面だけのローポリで作る（底面・隣の歩道に接する平面は省く）
function fromArrays(pos, nrm) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}

// 1/4 円柱（原点から +X と -Z に広がる、高さ 0..1）: 上面の扇 + 外周の曲面
function makeQuarterDisc(seg = 6) {
  const pos = [];
  const nrm = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 0.5;
    const a1 = ((i + 1) / seg) * Math.PI * 0.5;
    const x0 = Math.cos(a0), z0 = -Math.sin(a0);
    const x1 = Math.cos(a1), z1 = -Math.sin(a1);
    pos.push(0, 1, 0, x0, 1, z0, x1, 1, z1);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    pos.push(x0, 0, z0, x1, 0, z1, x1, 1, z1, x0, 0, z0, x1, 1, z1, x0, 1, z0);
    nrm.push(x0, 0, z0, x1, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z0);
  }
  return fromArrays(pos, nrm);
}

// 凹型フィレット（正方形 [0,1]x[-1,0] から (1,-1) 中心の 1/4 円を除いた形）: 上面 + 凹面
function makeFillet(seg = 8) {
  const pos = [];
  const nrm = [];
  for (let i = 0; i < seg; i++) {
    // 円弧: (1,0) → (0,-1)、中心 (1,-1)
    const a0 = Math.PI * 0.5 + (i / seg) * Math.PI * 0.5;
    const a1 = Math.PI * 0.5 + ((i + 1) / seg) * Math.PI * 0.5;
    const x0 = 1 + Math.cos(a0), z0 = -1 + Math.sin(a0);
    const x1 = 1 + Math.cos(a1), z1 = -1 + Math.sin(a1);
    pos.push(0, 1, 0, x0, 1, z0, x1, 1, z1);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    // 凹面の法線は円の中心（道路側）を向く
    const n0x = -Math.cos(a0), n0z = -Math.sin(a0);
    const n1x = -Math.cos(a1), n1z = -Math.sin(a1);
    pos.push(x0, 0, z0, x1, 1, z1, x0, 1, z0, x0, 0, z0, x1, 0, z1, x1, 1, z1);
    nrm.push(n0x, 0, n0z, n1x, 0, n1z, n0x, 0, n0z, n0x, 0, n0z, n1x, 0, n1z, n1x, 0, n1z);
  }
  return fromArrays(pos, nrm);
}

// 歩道の直方体（中心原点、高さ 0..1 ではなく -0.5..0.5）: 底面なし
function makeSlabGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const idx = g.index.array;
  // BoxGeometry の面順: +x, -x, +y, -y, +z, -z（各 6 インデックス）→ -y を除く
  const keep = [];
  for (let f = 0; f < 6; f++) if (f !== 3) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]);
  g.setIndex(keep);
  g.deleteAttribute('uv');
  g.clearGroups();
  return g;
}

function makePierGeometry() {
  const beam = new THREE.BoxGeometry(3.3, 0.35, 0.75);
  beam.translate(0, -0.72, 0);
  const parts = [beam];
  for (const sx of [-1.05, 1.05]) {
    const col = new THREE.CylinderGeometry(0.2, 0.25, 1.35, 7, 1, true);
    col.translate(sx, -1.55, 0);
    col.deleteAttribute('uv');
    parts.push(col.toNonIndexed());
  }
  beam.deleteAttribute('uv');
  parts[0] = beam.toNonIndexed();
  return mergeGeometries(parts);
}

// 指定面だけの箱（faces: +x,-x,+y,-y,+z,-z のビット 1,2,4,8,16,32）
function boxFaces(w, h, d, x, y, z, faces) {
  const g = new THREE.BoxGeometry(w, h, d);
  const idx = g.index.array;
  const keep = [];
  for (let f = 0; f < 6; f++) if (faces & (1 << f)) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]);
  g.setIndex(keep);
  g.clearGroups();
  g.deleteAttribute('uv');
  g.translate(x, y, z);
  return g.toNonIndexed();
}

// 街灯（原点=支柱、アームは +X = 道路側）。上下の隠れる面は省く
function makeLampGeometry() {
  const pole = boxFaces(0.07, 1.5, 0.07, 0, SW_H + 0.75, 0, 1 | 2 | 16 | 32);
  const arm = boxFaces(0.62, 0.05, 0.05, 0.3, SW_H + 1.47, 0, 4 | 16 | 32);
  const head = boxFaces(0.28, 0.07, 0.14, 0.58, SW_H + 1.44, 0, 1 | 2 | 4 | 16 | 32);
  return mergeGeometries([pole, arm, head]);
}

function makeLampGlowGeometry() {
  const g = new THREE.BoxGeometry(0.24, 0.02, 0.11);
  g.translate(0.58, SW_H + 1.4, 0);
  return g;
}

function makeLampPoolGeometry() {
  const g = new THREE.PlaneGeometry(2.8, 2.8);
  g.rotateX(-Math.PI / 2);
  g.translate(0.75, ROAD_Y + 0.025, 0);
  return g;
}

// 上面は石畳の目地（ワールド座標）、側面は少し暗く
function makeConcreteMaterial(color, paving) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    const decl = 'varying vec3 vCgWorld;\nvarying float vCgUp;\n';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 cgW = vec4(transformed, 1.0);
        vec4 cgN = vec4(objectNormal, 0.0);
        #ifdef USE_INSTANCING
          cgW = instanceMatrix * cgW;
          cgN = instanceMatrix * cgN;
        #endif
        cgW = modelMatrix * cgW;
        vCgWorld = cgW.xyz;
        vCgUp = normalize((modelMatrix * cgN).xyz + vec3(1e-6)).y;`,
      );
    // 微分（fwidth）は分岐の外で計算する（非一様な制御フロー内の微分は未定義）
    const pave = paving
      ? `vec2 cgQ = vCgWorld.xz * 2.2;
         vec2 cgFw = fwidth(cgQ);
         vec2 cgF = abs(fract(cgQ) - 0.5);
         vec2 cgL = smoothstep(0.5 - cgFw * 1.5, vec2(0.5), cgF);
         float cgLine = max(cgL.x, cgL.y) * (1.0 - smoothstep(0.12, 0.4, max(cgFw.x, cgFw.y)));
         diffuseColor.rgb *= vCgUp > 0.5 ? 1.0 - 0.14 * cgLine : 0.8;`
      : 'diffuseColor.rgb *= vCgUp > 0.5 ? 1.0 : 0.8;';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{ ${pave} }`);
  };
  mat.customProgramCacheKey = () => `cgConcrete2-${paving ? 1 : 0}`;
  return mat;
}

// 回転 k（時計回り1/4回転, rotation.y = -k*PI/2）の cos / sin
const CK = [1, 0, -1, 0];
const SK = [0, -1, 0, 1];

// インスタンスバッファ（複数レイヤーで instanceMatrix を共有、満杯なら作り直し）
class Batch {
  constructor(parent, layers, capacity = 256) {
    this.parent = parent;
    this.layers = layers;
    this.meshes = [];
    this.count = 0;
    this.capacity = 0;
    this._alloc(capacity);
  }

  _alloc(capacity) {
    const prev = this.meshes;
    const L0 = this.layers[0];
    const primary = new THREE.InstancedMesh(L0.geometry, L0.material, capacity);
    primary.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (prev.length && this.count > 0) {
      primary.instanceMatrix.array.set(prev[0].instanceMatrix.array.subarray(0, this.count * 16));
    }
    const meshes = [];
    for (let i = 0; i < this.layers.length; i++) {
      const L = this.layers[i];
      const mesh = i === 0 ? primary : new THREE.InstancedMesh(L.geometry, L.material, 1);
      if (i > 0) mesh.instanceMatrix = primary.instanceMatrix;
      mesh.count = this.count;
      mesh.frustumCulled = false;
      mesh.castShadow = !!L.castShadow;
      mesh.receiveShadow = !!L.receiveShadow;
      // 不透明レイヤーは建物（-3）の後・地形（0）の前に描く（隠れた地面を早期深度テストで捨てるため）
      mesh.renderOrder = L.renderOrder ?? (L.material.transparent ? 0 : OPAQUE_RENDER_ORDER);
      mesh.visible = L.visible !== false;
      mesh.matrixAutoUpdate = false;
      this.parent.add(mesh);
      meshes.push(mesh);
    }
    for (const m of prev) {
      this.parent.remove(m);
      m.dispose();
    }
    this.meshes = meshes;
    this.capacity = capacity;
    this.array = primary.instanceMatrix.array;
  }

  begin() {
    this.count = 0;
  }

  // M = T * Ry * S
  push(c, s, sx, sy, sz, tx, ty, tz) {
    if (this.count >= this.capacity) this._alloc(Math.ceil(this.capacity * 1.6) + 64);
    const a = this.array;
    const o = this.count * 16;
    a[o] = c * sx;
    a[o + 1] = 0;
    a[o + 2] = -s * sx;
    a[o + 3] = 0;
    a[o + 4] = 0;
    a[o + 5] = sy;
    a[o + 6] = 0;
    a[o + 7] = 0;
    a[o + 8] = s * sz;
    a[o + 9] = 0;
    a[o + 10] = c * sz;
    a[o + 11] = 0;
    a[o + 12] = tx;
    a[o + 13] = ty;
    a[o + 14] = tz;
    a[o + 15] = 1;
    this.count++;
  }

  commit() {
    for (const m of this.meshes) m.count = this.count;
    this.meshes[0].instanceMatrix.needsUpdate = true;
  }

  setVisible(layer, v) {
    this.layers[layer].visible = v;
    const m = this.meshes[layer];
    if (m) m.visible = v && this.count > 0;
  }
}

// ---------------------------------------------------------------------------------------------

export class RoadView {
  constructor(scene, city) {
    this.city = city;
    this.world = city.world;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    scene.add(this.group);

    const n = this.world.size * this.world.size;
    this._tileType = new Uint8Array(n);
    this._mask = new Uint8Array(n);
    this._dirty = true;
    this._timer = 0;
    this._lastNight = -1;

    this._buildAssets();
    this._rebuild();

    city.events.on('road:add', () => {
      this._dirty = true;
    });
  }

  _buildAssets() {
    const g = this.group;
    const tileGeo = new THREE.PlaneGeometry(CELL, CELL);
    tileGeo.rotateX(-Math.PI / 2); // uv v=1 が北（-Z）→ キャンバス上端=北

    this.tiles = [];
    for (const type of [ROAD.STREET, ROAD.AVENUE, ROAD.HIGHWAY]) {
      const asphalt = makeAsphalt(type, 1000 + type * 17);
      const row = [];
      for (let v = 0; v < CANON_MASK.length; v++) {
        const map = makeTileTexture(type, v, asphalt, type * 31 + v * 7 + 5);
        const material = new THREE.MeshStandardMaterial({
          map,
          roughness: 0.93,
          metalness: 0,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        });
        row[v] = new Batch(g, [{ geometry: tileGeo, material, receiveShadow: true }], 128);
      }
      this.tiles[type] = row;
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const slab = makeSlabGeometry();
    const sidewalkMat = makeConcreteMaterial(0xb9b5ab, true);
    const barrierMat = makeConcreteMaterial(0xcdcac2, false);
    const deckMat = makeConcreteMaterial(0x9d9a93, false);

    this.sidewalk = new Batch(g, [{ geometry: slab, material: sidewalkMat, receiveShadow: true }], 1024);
    this.corner = new Batch(g, [{ geometry: makeQuarterDisc(), material: sidewalkMat, receiveShadow: true }], 256);
    this.fillet = new Batch(g, [{ geometry: makeFillet(), material: sidewalkMat, receiveShadow: true }], 128);
    this.barrier = new Batch(g, [{ geometry: box, material: barrierMat, castShadow: true, receiveShadow: true }], 256);
    this.deck = new Batch(g, [{ geometry: box, material: deckMat, castShadow: true, receiveShadow: true }], 64);
    this.pier = new Batch(g, [{ geometry: makePierGeometry(), material: deckMat, castShadow: true, receiveShadow: true }], 32);

    const lampMat = new THREE.MeshStandardMaterial({ color: 0x5b5f66, roughness: 0.6, metalness: 0.3 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    this.poolMat = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(),
      color: 0x000000,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.lamps = new Batch(
      g,
      [
        { geometry: makeLampGeometry(), material: lampMat, castShadow: true },
        { geometry: makeLampGlowGeometry(), material: this.glowMat, visible: false },
        { geometry: makeLampPoolGeometry(), material: this.poolMat, visible: false, renderOrder: 2 },
      ],
      256,
    );

    this._batches = [this.sidewalk, this.corner, this.fillet, this.barrier, this.deck, this.pier, this.lamps];
    for (const row of this.tiles) if (row) this._batches.push(...row);
  }

  _rebuild() {
    this._dirty = false;
    this._timer = 0;
    const w = this.world;
    const size = w.size;
    const road = w.road;
    const terrain = w.terrain;
    const tt = this._tileType;
    const masks = this._mask;

    // 1) マスクとタイル種別（交差点は周囲の上位種別を使う）
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const i = z * size + x;
        const type = road[i];
        if (!type) {
          tt[i] = 0;
          continue;
        }
        let mask = 0;
        let maxT = type;
        let deg = 0;
        if (z > 0 && road[i - size]) {
          mask |= 1;
          deg++;
          if (road[i - size] > maxT) maxT = road[i - size];
        }
        if (x < size - 1 && road[i + 1]) {
          mask |= 2;
          deg++;
          if (road[i + 1] > maxT) maxT = road[i + 1];
        }
        if (z < size - 1 && road[i + size]) {
          mask |= 4;
          deg++;
          if (road[i + size] > maxT) maxT = road[i + size];
        }
        if (x > 0 && road[i - 1]) {
          mask |= 8;
          deg++;
          if (road[i - 1] > maxT) maxT = road[i - 1];
        }
        masks[i] = mask;
        tt[i] = deg >= 3 ? maxT : type;
      }
    }

    for (const b of this._batches) b.begin();

    // 2) インスタンス
    const half = size / 2;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const i = z * size + x;
        const type = tt[i];
        if (!type) continue;
        const mask = masks[i];
        const { variant, rot } = TILE_TABLE[mask];
        const cx = (x - half + 0.5) * CELL;
        const cz = (z - half + 0.5) * CELL;
        const L = ROAD_LAYOUT[type];
        const wc = L.curb * CELL;
        const hw = type === ROAD.HIGHWAY;
        const bridge = terrain[i] === TILE.WATER;

        this.tiles[type][variant].push(CK[rot], SK[rot], 1, 1, 1, cx, ROAD_Y, cz);

        // 接続のない辺: 歩道 or ガードレール
        for (let e = 0; e < 4; e++) {
          const d = DIRS[e];
          if (mask & d.bit) continue;
          const sx = d.dx ? wc : CELL;
          const sz = d.dx ? CELL : wc;
          const ox = d.dx * (HALF - wc / 2);
          const oz = d.dz * (HALF - wc / 2);
          if (hw) {
            this.barrier.push(1, 0, sx, 0.3, sz, cx + ox, 0.15, cz + oz);
          } else {
            this.sidewalk.push(1, 0, sx, SW_H, sz, cx + ox, SW_H / 2, cz + oz);
            if (bridge) {
              const t = 0.1;
              this.barrier.push(
                1,
                0,
                d.dx ? t : CELL,
                0.3,
                d.dx ? CELL : t,
                cx + d.dx * (HALF - t / 2),
                SW_H + 0.15,
                cz + d.dz * (HALF - t / 2),
              );
            }
          }
        }

        // 両辺が接続された角: 隣の歩道をつなぐ 1/4 円（斜めのセルも道路なら広場なので置かない）
        for (let k = 0; k < 4; k++) {
          const da = DIRS[(k + 2) % 4];
          const db = DIRS[(k + 3) % 4];
          if (!(mask & da.bit) || !(mask & db.bit)) continue;
          const qx = x + da.dx + db.dx;
          const qz = z + da.dz + db.dz;
          if (qx >= 0 && qz >= 0 && qx < size && qz < size && road[qz * size + qx]) continue;
          const ia = (z + da.dz) * size + (x + da.dx);
          const ib = (z + db.dz) * size + (x + db.dx);
          const A = ROAD_LAYOUT[tt[ia]].curb * CELL;
          const B = ROAD_LAYOUT[tt[ib]].curb * CELL;
          const px = cx + (da.dx + db.dx) * HALF;
          const pz = cz + (da.dz + db.dz) * HALF;
          this.corner.push(CK[k], SK[k], A, SW_H, B, px, 0, pz);
        }

        // 行き止まり・カーブ・単独セルの丸い縁石
        if (!hw && (variant === VARIANT.CORNER || variant === VARIANT.DEAD || variant === VARIANT.SINGLE)) {
          const R = (variant === VARIANT.CORNER ? 1 - L.curb : 0.5 - L.curb) * CELL;
          for (let k = 0; k < 4; k++) {
            const da = DIRS[(k + 2) % 4];
            const db = DIRS[(k + 3) % 4];
            if (mask & da.bit || mask & db.bit) continue;
            const c = CK[k];
            const s = SK[k];
            const px = cx + (da.dx + db.dx) * HALF + (c * wc - s * wc);
            const pz = cz + (da.dz + db.dz) * HALF + (-s * wc - c * wc);
            this.fillet.push(c, s, R, SW_H, R, px, 0, pz);
          }
        }

        // 橋
        if (bridge) {
          this.deck.push(1, 0, CELL + 0.02, 0.55, CELL + 0.02, cx, 0.02 - 0.275, cz);
          const along = rot & 1 ? x : z;
          if (variant !== VARIANT.STRAIGHT || (along & 1) === 0) {
            this.pier.push(CK[rot], SK[rot], 1, 1, 1, cx, 0, cz);
          }
        }

        // 街灯（直線区間のみ）
        if (variant === VARIANT.STRAIGHT) {
          const along = rot & 1 ? x : z;
          if (type === ROAD.AVENUE) {
            this._pushLamp(rot, along & 1, cx, cz, wc);
          } else if (type === ROAD.HIGHWAY) {
            if ((along & 1) === 0) {
              this._pushLamp(rot, 0, cx, cz, wc);
              this._pushLamp(rot, 1, cx, cz, wc);
            }
          } else if (hash2(x, z, 91) < 0.2) {
            this._pushLamp(rot, hash2(x, z, 92) < 0.5 ? 0 : 1, cx, cz, wc);
          }
        }
      }
    }

    for (const b of this._batches) b.commit();
    this._lastNight = -1;
  }

  // side 0: 回転 rot の左側（-X 側）、1: 反対側。アームは道路中央へ
  _pushLamp(rot, side, cx, cz, wc) {
    const k = (rot + side * 2) & 3;
    const c = CK[k];
    const s = SK[k];
    const lx = -HALF + wc / 2;
    this.lamps.push(c, s, 1, 1, 1, cx + c * lx, 0, cz - s * lx);
  }

  update(env) {
    this._timer += env.dt || 0;
    if (this._dirty && this._timer >= REBUILD_INTERVAL) this._rebuild();

    const night = env.night || 0;
    if (Math.abs(night - this._lastNight) > 0.004) {
      this._lastNight = night;
      const on = night > 0.02;
      const k = Math.min(1, night * 1.25);
      this.glowMat.color.setRGB(3.2 * k, 2.5 * k, 1.5 * k);
      this.poolMat.color.setRGB(0.4 * k, 0.33 * k, 0.24 * k);
      this.lamps.setVisible(1, on);
      this.lamps.setVisible(2, on);
    }
  }
}
