// 建物ビュー: アーキタイプ別 InstancedMesh + 手続き窓シェーダ + 建設アニメーション
import * as THREE from 'three';
import { CONFIG, ZONE, cellToWorld, rotationToAngle, clamp } from '../config.js';
import { hash2 } from '../core/rng.js';

const C = CONFIG.CELL;
const RISE_TIME = 1.2;
const HOUSE_WALL = 0.7; // 家の本体ジオメトリで壁が占める高さ比（残りは妻壁）

const OP_ADD = 1;
const OP_UPG = 2;
const OP_REM = 4;

// ---------------------------------------------------------------------------------------------
// 色

const _tmpColor = new THREE.Color();
function lin(hex) {
  _tmpColor.set(hex); // sRGB → 作業色空間（linear）
  return [_tmpColor.r, _tmpColor.g, _tmpColor.b];
}
function palette(list) {
  return list.map((h) => new THREE.Color(h));
}

const PAL = {
  houseWall: palette(['#f1ebe0', '#e9dcc6', '#f6f3ee', '#ddd6ca', '#ecd6bb', '#d3dade', '#e8cdb9', '#dac9aa', '#f2e4c4', '#cdbfae', '#c7d6c9', '#e4d3d8']),
  houseRoof: palette(['#9a4432', '#4b525b', '#3f5f7a', '#6e4c36', '#355743', '#7d3434', '#5c5c5e', '#8a6a3f', '#2f3a48']),
  apt: palette(['#e9e4da', '#d8d2c6', '#cbd5da', '#e3d3bd', '#c2b6a4', '#b98a6c', '#d9c9b0', '#aeb9bf', '#e6dccb', '#c9a58a', '#d4dccf']),
  tower: palette(['#dcdcd8', '#c8ccce', '#b7bfc4', '#e2dccf', '#a9b2b8', '#cfc3b0', '#9fa9ae', '#d9cfc2', '#b98a6c', '#c9b08f', '#8e9aa3', '#d8c3a5']),
  shop: palette(['#f3efe6', '#e6d6be', '#d5e0e6', '#f1dcb8', '#c9d2d9', '#ebe3d2', '#d8b99a', '#bfc9c1', '#e8c9c1']),
  awning: palette(['#d9443a', '#2f7dd1', '#f0a030', '#2e9e6a', '#8a4fc2', '#e0668f', '#1f6f8b', '#c8b02a']),
  office: palette(['#cfd2d4', '#bcc5cb', '#d8d1c4', '#aab4bc', '#939fa8', '#d2c9b9', '#a3aab0', '#c4b9a8']),
  frame: palette(['#b4bcc3', '#737e87', '#3e464e', '#cdd2d6', '#8b9095', '#5a646c']),
  crown: palette(['#8a929a', '#a3a9ae', '#6f7880', '#b8bcbf', '#7d8a94']),
  ind: palette(['#bdb094', '#aaa69d', '#9f937e', '#c5b78f', '#909089', '#b69f79', '#a3aba3', '#c4c0b6']),
  indRoof: palette(['#80878d', '#606c74', '#8c7258', '#707c6c', '#9ba1a5', '#6d6660']),
  metal: palette(['#d8dadb', '#b9bec2', '#a3abb0', '#c9c2b5']),
  tank: palette(['#c9cdd0', '#9fb3c2', '#b98d6a', '#d6d0c0', '#8fa3a0']),
  chimney: palette(['#8d4b3a', '#6b6b6b', '#7a5a48']),
  concrete: palette(['#cfcac2', '#bdb9b2', '#d8d4cc']),
  lawn: palette(['#6aa84f', '#76b35a', '#5e9c46', '#82bb5f']),
  sign: palette(['#ff5a4a', '#3aa0ff', '#ffb02e', '#35d07f', '#b36bff', '#ff6fae', '#f2f2f2']),
};

// 建物ごとの安定乱数（variant と位置から）
function rv(b, k) {
  return hash2(b.variant + k * 1013, b.x * 197 + b.z * 389, 0x5bd1 + k);
}
function pick(pal, r) {
  return pal[Math.min(pal.length - 1, Math.floor(r * pal.length))];
}

// ---------------------------------------------------------------------------------------------
// ジオメトリビルダー（非インデックス、position/normal/color）

class GeoBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
  }

  tri(a, b, c, hint, col) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) return;
    nx /= len; ny /= len; nz /= len;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      const t = b; b = c; c = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) {
      this.n.push(nx, ny, nz);
      this.c.push(col[0], col[1], col[2]);
    }
  }

  quad(a, b, c, d, hint, col) {
    this.tri(a, b, c, hint, col);
    this.tri(a, c, d, hint, col);
  }

  // 軸平行ボックス。col は [r,g,b] か { side, top, bottom }
  box(x0, y0, z0, x1, y1, z1, col, bottom = true, top = true) {
    const side = col.side || col;
    const topCol = col.top || side;
    const bot = col.bottom || side;
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], side);
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0], side);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], side);
    if (top) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], topCol);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], bot);
  }

  // Y 軸回転したボックス（中心 cx,cz、半幅 hx,hz）
  boxRot(cx, cz, hx, hz, y0, y1, angle, col, bottom = true) {
    const start = this.p.length;
    this.box(-hx, y0, -hz, hx, y1, hz, col, bottom);
    const cs = Math.cos(angle), sn = Math.sin(angle);
    for (let i = start; i < this.p.length; i += 3) {
      const x = this.p[i], z = this.p[i + 2];
      this.p[i] = cx + cs * x + sn * z;
      this.p[i + 2] = cz - sn * x + cs * z;
      const nx = this.n[i], nz = this.n[i + 2];
      this.n[i] = cs * nx + sn * nz;
      this.n[i + 2] = -sn * nx + cs * nz;
    }
  }

  // YZ 平面の凸多角形 prof [[z,y],...] を X 方向に押し出す。edgeCols[i] は辺 i→i+1 の色（null = 面なし）
  // caps: 1 = x0 側, 2 = x1 側
  prismX(x0, x1, prof, edgeCols, capCol, caps = 3) {
    let cz = 0, cy = 0;
    for (const [z, y] of prof) { cz += z; cy += y; }
    cz /= prof.length; cy /= prof.length;
    for (let i = 0; i < prof.length; i++) {
      const [za, ya] = prof[i];
      const [zb, yb] = prof[(i + 1) % prof.length];
      const hint = [0, (ya + yb) / 2 - cy, (za + zb) / 2 - cz];
      const ec = i < edgeCols.length ? edgeCols[i] : edgeCols[0];
      if (ec) this.quad([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], hint, ec);
    }
    for (let i = 1; i < prof.length - 1; i++) {
      const a = prof[0], b = prof[i], c = prof[i + 1];
      if (caps & 1) this.tri([x0, a[1], a[0]], [x0, b[1], b[0]], [x0, c[1], c[0]], [-1, 0, 0], capCol);
      if (caps & 2) this.tri([x1, a[1], a[0]], [x1, b[1], b[0]], [x1, c[1], c[0]], [1, 0, 0], capCol);
    }
  }

  // caps: 1 = 上面, 2 = 底面, 4 = 側面なし
  cyl(cx, cz, y0, y1, rb, rt, seg, col, capCol = col, a0 = 0, caps = 1) {
    for (let i = 0; i < seg; i++) {
      const t0 = a0 + (i / seg) * Math.PI * 2, t1 = a0 + ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const cm = Math.cos((t0 + t1) / 2), sm = Math.sin((t0 + t1) / 2);
      if (!(caps & 4)) {
        this.quad(
          [cx + c0 * rb, y0, cz + s0 * rb], [cx + c1 * rb, y0, cz + s1 * rb],
          [cx + c1 * rt, y1, cz + s1 * rt], [cx + c0 * rt, y1, cz + s0 * rt],
          [cm, (rb - rt) / Math.max(1e-6, y1 - y0), sm], col,
        );
      }
      if (caps & 1 && rt > 1e-6) this.tri([cx, y1, cz], [cx + c0 * rt, y1, cz + s0 * rt], [cx + c1 * rt, y1, cz + s1 * rt], [0, 1, 0], capCol);
      if (caps & 2) this.tri([cx, y0, cz], [cx + c0 * rb, y0, cz + s0 * rb], [cx + c1 * rb, y0, cz + s1 * rb], [0, -1, 0], capCol);
    }
  }

  ball(cx, cy, cz, r, sy, detail, col) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.getAttribute('position');
    const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < pos.count; i += 3) {
      let mx = 0, my = 0, mz = 0;
      for (let k = 0; k < 3; k++) {
        v[k] = [cx + pos.getX(i + k), cy + pos.getY(i + k) * sy, cz + pos.getZ(i + k)];
        mx += pos.getX(i + k); my += pos.getY(i + k); mz += pos.getZ(i + k);
      }
      this.tri(v[0], v[1], v[2], [mx, my, mz], col);
    }
    g.dispose();
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = [1, 1, 1];
const shade = (k) => [k, k, k];

// 公園の木（幹 5 角 + 丸い樹冠）
function tree(gb, x, z, s, canopy, trunk) {
  gb.cyl(x, z, 0.06, 0.55 * s, 0.09 * s, 0.07 * s, 5, trunk, trunk, 0, 0);
  gb.ball(x, 0.95 * s, z, 0.55 * s, 0.92, 1, canopy);
}

function buildGeometries() {
  const G = {};
  let gb;

  // 単位ボックス（底 y=0、上 y=1）
  gb = new GeoBuilder();
  gb.box(-0.5, 0, -0.5, 0.5, 1, 0.5, WHITE, false);
  G.box = gb.build();

  // 家の本体（壁 + 妻壁の三角）
  gb = new GeoBuilder();
  gb.box(-0.5, 0, -0.5, 0.5, HOUSE_WALL, 0.5, WHITE, false);
  for (const sx of [-0.5, 0.5]) {
    gb.tri([sx, HOUSE_WALL, -0.5], [sx, HOUSE_WALL, 0.5], [sx, 1, 0], [Math.sign(sx), 0, 0], WHITE);
  }
  G.houseBody = gb.build();

  // 切妻屋根（棟は X 方向、2 枚の板。y=0 が軒の上面、y=1 が棟の上面）。棟の内側で接する面は省く
  gb = new GeoBuilder();
  const th = 0.16;
  for (const sz of [-0.5, 0.5]) {
    gb.prismX(-0.5, 0.5, [[0, 1], [sz, 0], [sz, -th], [0, 1 - th]], [WHITE, shade(0.7), shade(0.5), null], shade(0.72));
  }
  G.gable = gb.build();

  // のこぎり屋根（4 山、垂直面は暗いガラス）
  gb = new GeoBuilder();
  const glaze = lin('#56636e');
  for (let i = 0; i < 4; i++) {
    const z0 = -0.5 + i * 0.25, z1 = z0 + 0.25;
    gb.prismX(-0.5, 0.5, [[z0, 0], [z1, 0], [z1, 1]], [null, glaze, WHITE], shade(0.8));
  }
  G.sawtooth = gb.build();

  // 高架水槽（56 三角形）
  gb = new GeoBuilder();
  for (const lx of [-0.3, 0.3]) for (const lz of [-0.3, 0.3]) gb.box(lx - 0.04, 0, lz - 0.04, lx + 0.04, 0.55, lz + 0.04, shade(0.5), false, false);
  gb.cyl(0, 0, 0.55, 1.35, 0.5, 0.5, 6, WHITE, shade(0.6), Math.PI / 6, 2);
  gb.cyl(0, 0, 1.35, 1.58, 0.5, 0, 6, shade(0.82), shade(0.82), Math.PI / 6, 0);
  G.tank = gb.build();

  // 空調室外機クラスタ
  gb = new GeoBuilder();
  const acUnits = [[-0.6, -0.35], [0.25, -0.35], [-0.2, 0.45]];
  for (const [ax, az] of acUnits) {
    gb.box(ax - 0.36, 0, az - 0.28, ax + 0.36, 0.5, az + 0.28, WHITE, false);
    gb.quad([ax - 0.22, 0.51, az - 0.2], [ax + 0.22, 0.51, az - 0.2], [ax + 0.22, 0.51, az + 0.2], [ax - 0.22, 0.51, az + 0.2], [0, 1, 0], shade(0.3));
  }
  gb.cyl(0.75, 0.5, 0, 0.7, 0.14, 0.14, 4, shade(0.7), shade(0.25), Math.PI / 4);
  G.ac = gb.build();

  // 工場の煙突（上部に紅白帯）
  gb = new GeoBuilder();
  const red = lin('#e04a3a').map((v) => v * 1.25);
  gb.cyl(0, 0, 0, 0.8, 0.5, 0.4, 6, WHITE, WHITE, 0, 0);
  gb.cyl(0, 0, 0.8, 0.88, 0.4, 0.39, 6, red, red, 0, 0);
  gb.cyl(0, 0, 0.88, 0.94, 0.39, 0.385, 6, WHITE, WHITE, 0, 0);
  gb.cyl(0, 0, 0.94, 1.0, 0.385, 0.38, 6, red, shade(0.15));
  G.chimney = gb.build();

  // サイロ 2 基
  gb = new GeoBuilder();
  for (const sx of [-0.55, 0.55]) {
    gb.cyl(sx, 0, 0, 0.92, 0.5, 0.5, 8, WHITE, WHITE, 0, 0);
    gb.cyl(sx, 0, 0.92, 1.02, 0.5, 0, 8, shade(0.85), shade(0.85), 0, 0);
  }
  gb.box(-0.6, 0.6, -0.08, 0.6, 0.66, 0.08, shade(0.5), false);
  G.silo = gb.build();

  // コンテナ・資材
  gb = new GeoBuilder();
  gb.box(-0.7, 0, -0.35, 0.5, 0.48, 0.05, lin('#b5523b'), false);
  gb.box(-0.7, 0, 0.1, 0.5, 0.48, 0.5, lin('#2f6ea5'), false);
  gb.box(-0.6, 0.48, -0.3, 0.6, 0.96, 0.12, lin('#3e8a5c'), false);
  gb.box(0.6, 0, -0.3, 0.95, 0.3, 0.3, lin('#9c7a4f'), false);
  G.crates = gb.build();

  // 日よけ（前方 +Z に張り出す、縞模様）。壁に接する背面と縞の間の断面は省く
  gb = new GeoBuilder();
  const stripes = 5;
  for (let i = 0; i < stripes; i++) {
    const x0 = -0.5 + i / stripes, x1 = x0 + 1 / stripes;
    const col = i % 2 ? shade(0.62) : WHITE;
    gb.prismX(x0, x1, [[0, 1], [0, 0.85], [1, 0.2], [1, 0.5]], [null, col, col, col], col, (i === 0 ? 1 : 0) | (i === stripes - 1 ? 2 : 0));
  }
  G.awning = gb.build();

  // 四角錐台（超高層の頂部）
  gb = new GeoBuilder();
  gb.cyl(0, 0, 0, 1, Math.SQRT1_2, 0.3, 4, WHITE, WHITE, Math.PI / 4);
  G.frustum = gb.build();

  gb = new GeoBuilder();
  gb.cyl(0, 0, 0, 1, 0.14, 0.035, 5, WHITE);
  gb.box(-0.3, 0.3, -0.03, 0.3, 0.33, 0.03, WHITE, false);
  G.antenna = gb.build();

  gb = new GeoBuilder();
  gb.ball(0, 0, 0, 0.3, 1, 0, WHITE);
  G.beacon = gb.build();

  // 公園 A: 十字の園路 + 噴水 + 4 本の木
  const path = lin('#d9ccb0');
  const stone = lin('#b9b4aa');
  const water = lin('#4f93b8');
  const leaf = lin('#4f9a3c');
  const leaf2 = lin('#3f8a45');
  const trunk = lin('#6b4a30');
  const hedge = lin('#3d7a34');
  const half = C * 0.48;
  gb = new GeoBuilder();
  gb.box(-half, 0.07, -0.26, half, 0.1, 0.26, path, false);
  gb.box(-0.26, 0.07, -half, 0.26, 0.1, half, path, false);
  gb.cyl(0, 0, 0.07, 0.3, 0.62, 0.6, 12, stone);
  gb.cyl(0, 0, 0.31, 0.31, 0.5, 0.5, 12, water, water, 0, 1 | 4);
  gb.cyl(0, 0, 0.3, 0.62, 0.08, 0.05, 6, stone);
  const q = C * 0.26;
  tree(gb, -q, -q, 1.15, leaf, trunk);
  tree(gb, q, -q, 0.95, leaf2, trunk);
  tree(gb, -q, q, 1.0, leaf2, trunk);
  tree(gb, q, q, 1.2, leaf, trunk);
  gb.ball(-0.7, 0.15, 0.62, 0.22, 0.8, 0, hedge);
  gb.ball(0.7, 0.15, -0.62, 0.22, 0.8, 0, hedge);
  G.parkA = gb.build();

  // 公園 B: 斜めの園路 + 池 + 5 本の木 + ベンチ
  gb = new GeoBuilder();
  gb.boxRot(0, 0, C * 0.62, 0.24, 0.07, 0.1, Math.PI / 4, path, false);
  gb.cyl(C * 0.22, C * 0.22, 0.07, 0.1, 0.95, 0.95, 14, stone);
  gb.cyl(C * 0.22, C * 0.22, 0.11, 0.11, 0.82, 0.82, 14, water, water, 0, 1 | 4);
  tree(gb, -C * 0.3, -C * 0.3, 1.2, leaf, trunk);
  tree(gb, -C * 0.05, -C * 0.37, 0.9, leaf2, trunk);
  tree(gb, -C * 0.37, -C * 0.02, 1.0, leaf2, trunk);
  tree(gb, C * 0.38, -C * 0.1, 1.05, leaf, trunk);
  tree(gb, -C * 0.12, C * 0.38, 0.95, leaf, trunk);
  gb.boxRot(-0.75, -0.05, 0.4, 0.12, 0.1, 0.3, Math.PI / 4, lin('#8a6040'), false);
  gb.ball(-0.9, 0.14, -1.65, 0.24, 0.8, 0, hedge);
  G.parkB = gb.build();

  return G;
}

// ---------------------------------------------------------------------------------------------
// マテリアル（手続き窓）

const SHARED = {
  uCgNight: { value: 0 },
  uCgDay: { value: 1 },
  uCgLodPx: { value: 1000 }, // 距離 1 での 1 ワールド単位の画面サイズ（CSS px）
  uCgCamPos: { value: new THREE.Vector3(0, 1e4, 0) }, // 表示カメラ位置（影パスでも表示カメラ基準で LOD するため）
};

// 面・インスタンスごとに一定の量（窓グリッドの列数・行数、面 ID、乱数、窓サイズなど）は頂点シェーダで計算して
// flat varying で渡す。グリッド座標など面内で線形な量は通常の varying（透視補正で厳密）。
const WINDOW_VERT_PARS = /* glsl */ `
uniform vec4 uCgWin;
uniform vec4 uCgA;
uniform vec4 uCgB;
varying vec2 vCgG;        // 窓グリッド座標
varying vec4 vCgA;        // 面内の水平座標 U, ローカル高さ Y, 店舗帯の列座標, ワールド Y
varying vec4 vCgR;        // 屋上の縁までの距離（4 方向）
flat varying vec4 vCgB;   // 列数, 行数, 面 ID, 鉛直面度
flat varying vec4 vCgC;   // 窓の幅比, 高さ比, 建物の乱数, 屋上面フラグ
flat varying vec4 vCgD;   // 高さ, 搬入口の半幅, 搬入口の高さ, 点灯確率
`;

const WINDOW_VERT = /* glsl */ `
{
  mat4 cgM = modelMatrix;
  vec3 cgSize = vec3(1.0);
  #ifdef USE_INSTANCING
    cgM = modelMatrix * instanceMatrix;
    cgSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  #endif
  cgSize = max(cgSize, vec3(1e-4));
  vec4 cgWp = cgM * vec4(transformed, 1.0);
  vec3 cgN = normalize(mat3(cgM) * (objectNormal / (cgSize * cgSize)));
  vec3 cgL = transformed * cgSize;
  vec3 cgP = fract(vec3(floor(cgM[3].x * 2.0 + 0.5), floor(cgM[3].z * 2.0 + 0.5), 7.13) * 0.1031);
  cgP += dot(cgP, cgP.yzx + 33.33);
  float cgSeed = fract((cgP.x + cgP.y) * cgP.z);

  float cgFaceW = cgSize.x;
  float cgFaceU = cgL.x;
  float cgFaceId = objectNormal.z > 0.0 ? 0.0 : 2.0;
  if (abs(objectNormal.x) > abs(objectNormal.z)) {
    cgFaceW = cgSize.z;
    cgFaceU = cgL.z;
    cgFaceId = objectNormal.x > 0.0 ? 1.0 : 3.0;
  }
  cgFaceW = max(cgFaceW, 0.01);
  float cgWallH = cgSize.y * uCgB.x;
  float cgBase = max(uCgB.w, uCgA.x);

  float cgVarK = 1.0 - 0.7 * uCgA.w;
  float cgCellW = uCgWin.x * (1.0 + (fract(cgSeed * 5.71) - 0.4) * 0.35 * cgVarK);
  vec2 cgFrac = min(uCgWin.zw * (1.0 + (vec2(fract(cgSeed * 3.17), fract(cgSeed * 8.3)) - 0.5) * vec2(0.4, 0.25) * cgVarK), vec2(0.94));
  float cgMargin = min(0.2, cgFaceW * 0.12);
  float cgInner = max(cgFaceW - 2.0 * cgMargin, 0.01);
  float cgCols = max(1.0, floor(cgInner / cgCellW + 0.35));
  float cgGu = (cgFaceU + 0.5 * cgFaceW - cgMargin) / cgInner * cgCols;
  float cgRows = floor(max(cgWallH - uCgWin.y * 0.3 - cgBase, 0.0) / uCgWin.y);
  float cgGv = (cgL.y - cgBase) / uCgWin.y;
  if (uCgB.y > 1.5) {
    cgRows = step(2.2, cgWallH);
    cgGv = (cgL.y - cgWallH * 0.56) / max(cgWallH * 0.24, 0.01);
  }
  float cgSfCols = max(1.0, floor(cgFaceW / 2.3 + 0.3));

  vCgG = vec2(cgGu, cgGv);
  vCgA = vec4(cgFaceU, cgL.y, (cgFaceU / cgFaceW + 0.5) * cgSfCols, cgWp.y);
  vCgR = vec4(0.5 * cgSize.x - cgL.x, 0.5 * cgSize.x + cgL.x, 0.5 * cgSize.z - cgL.z, 0.5 * cgSize.z + cgL.z);
  vCgB = vec4(cgCols, cgRows, cgFaceId, 1.0 - smoothstep(0.3, 0.6, abs(cgN.y)));
  vCgC = vec4(cgFrac, cgSeed, cgN.y > 0.6 ? 1.0 : 0.0);
  vCgD = vec4(cgSize.y, min(1.2, cgFaceW * 0.2), min(2.4, cgWallH * 0.45), uCgA.y * (0.55 + 0.9 * fract(cgSeed * 13.7)));
}
`;

const WINDOW_FRAG_PARS = /* glsl */ `
uniform float uCgNight;
uniform float uCgDay;
uniform vec4 uCgWin;   // cellW, cellH, fracX, fracY
uniform vec4 uCgA;     // storefrontH, litProb, coolProb, glass
uniform vec4 uCgB;     // wallFrac, band(0 none/1 slab/2 industrial), emissiveGain, plinth
uniform vec4 uCgC;     // floorLitProb, corrugation, glassMetal, glassSheen
varying vec2 vCgG;
varying vec4 vCgA;
varying vec4 vCgR;
flat varying vec4 vCgB;
flat varying vec4 vCgC;
flat varying vec4 vCgD;
float cgHash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
`;

const WINDOW_FRAG = /* glsl */ `
if (vCgC.w > 0.5) {
  // 屋上（パラペット + 防水面）。屋上では窓・店舗帯・発光はすべて 0 なので壁の計算を丸ごと省く
  vec3 cgFacade = diffuseColor.rgb;
  float cgRim = 1.0 - smoothstep(0.14, 0.22, min(min(vCgR.x, vCgR.y), min(vCgR.z, vCgR.w)));
  vec3 cgRoof = mix(vec3(0.30, 0.31, 0.32), cgFacade, 0.3);
  diffuseColor.rgb = mix(cgRoof, cgFacade * 1.04, cgRim);
} else {
  vec3 cgFacade = diffuseColor.rgb;
  float cgVert = vCgB.w;
  float cgFaceU = vCgA.x;
  float cgY = vCgA.y;
  float cgFaceId = vCgB.z;
  float cgSeed = vCgC.z;
  float cgStore = uCgA.x;
  vec2 cgFrac = vCgC.xy;

  // 窓グリッド
  vec2 cgG = vCgG;
  vec2 cgCell = floor(cgG);
  vec2 cgF = fract(cgG);
  float cgIn = step(0.0, cgG.x) * step(cgG.x, vCgB.x) * step(0.0, cgG.y) * step(cgCell.y + 0.5, vCgB.y);
  vec2 cgFw = max(fwidth(cgG), vec2(1e-4));
  vec2 cgM2 = clamp((0.5 * cgFrac - abs(cgF - 0.5)) / cgFw + 0.5, 0.0, 1.0);
  float cgFar = smoothstep(0.2, 0.6, max(cgFw.x, cgFw.y));
  float cgWin = mix(cgM2.x * cgM2.y, cgFrac.x * cgFrac.y, cgFar) * cgIn * cgVert;

  float cgH = cgHash3(vec3(cgCell.x * 1.37 + cgFaceId * 17.0, cgCell.y * 2.11 + 3.0, cgSeed * 97.0));

  // 壁面の質感
  vec3 cgWall = cgFacade;
  if (uCgB.y > 0.5 && uCgB.y < 1.5) {
    float cgSlab = 1.0 - smoothstep(0.08, 0.14, cgF.y);
    cgWall *= 1.0 + 0.1 * cgSlab * cgIn * (1.0 - cgFar) * cgVert;
  }
  if (uCgC.y > 0.0) {
    float cgRib = fract(cgFaceU * 1.6);
    float cgRibW = fwidth(cgFaceU * 1.6);
    float cgRibM = mix(0.9 + 0.1 * step(0.5, cgRib), 0.95, smoothstep(0.3, 0.8, cgRibW));
    cgWall *= mix(1.0, cgRibM, uCgC.y * cgVert);
  }

  // ガラス色
  vec3 cgGlass;
  if (uCgA.w > 0.5) {
    float cgT = fract(cgSeed * 5.3);
    vec3 cgTint = cgT < 0.4 ? vec3(0.09, 0.19, 0.30) : (cgT < 0.7 ? vec3(0.08, 0.21, 0.22) : (cgT < 0.85 ? vec3(0.22, 0.16, 0.10) : vec3(0.22, 0.25, 0.29)));
    cgGlass = cgTint * (0.7 + 0.55 * smoothstep(0.0, vCgD.x, cgY)) * (0.88 + 0.24 * cgH);
  } else {
    cgGlass = vec3(0.06, 0.075, 0.1) * (0.8 + 0.4 * cgH) + vec3(0.04, 0.06, 0.08) * cgF.y * (1.0 - cgFar);
    cgGlass = mix(cgGlass, vec3(0.22, 0.19, 0.15), step(0.84, fract(cgH * 3.3)) * (1.0 - cgFar));
    // 窓枠
    vec2 cgM3 = clamp((0.5 * cgFrac + 0.06 - abs(cgF - 0.5)) / cgFw + 0.5, 0.0, 1.0);
    float cgFrame = max(cgM3.x * cgM3.y * cgIn * cgVert * (1.0 - cgFar) - cgWin, 0.0);
    cgWall = mix(cgWall, cgFacade * 1.12 + 0.04, cgFrame * 0.8);
  }

  // 1階の店舗帯
  float cgSf = 0.0;
  float cgSign = 0.0;
  vec3 cgSignCol = vec3(0.0);
  if (cgStore > 0.0) {
    float cgSx = vCgA.z;
    float cgSxw = max(fwidth(cgSx), 1e-4);
    float cgInX = clamp((0.43 - abs(fract(cgSx) - 0.5)) / cgSxw + 0.5, 0.0, 1.0);
    cgInX = mix(cgInX, 0.86, smoothstep(0.2, 0.6, cgSxw));
    float cgInY = step(0.12, cgY) * step(cgY, cgStore - 0.4);
    cgSf = cgInX * cgInY * cgVert;
    cgSign = step(cgStore - 0.32, cgY) * step(cgY, cgStore - 0.04) * cgVert;
    cgSignCol = 0.5 + 0.5 * cos(6.2831 * (fract(cgSeed * 7.0 + cgFaceId * 0.13) + vec3(0.0, 0.33, 0.67)));
  }

  // 工場の搬入口
  float cgDoor = 0.0;
  if (uCgB.y > 1.5) {
    cgDoor = step(abs(cgFaceU), vCgD.y) * step(cgY, vCgD.z) * step(cgFaceId, 0.5) * cgVert;
  }

  vec3 cgCol = mix(cgWall, cgGlass, cgWin);
  cgCol = mix(cgCol, vec3(0.28, 0.32, 0.34), cgSf);
  cgCol = mix(cgCol, cgSignCol * 0.8, cgSign);
  cgCol = mix(cgCol, vec3(0.34, 0.36, 0.39) * (0.9 + 0.1 * step(0.5, fract(cgY * 3.0))), cgDoor);

  // 接地部の陰り
  cgCol *= mix(1.0, 0.7 + 0.3 * smoothstep(0.0, 1.4, vCgA.w), cgVert);
  diffuseColor.rgb = cgCol;

  float cgGlassMask = max(cgWin, cgSf);
  roughnessFactor = mix(roughnessFactor, uCgA.w > 0.5 ? 0.12 : 0.2, cgGlassMask);
  metalnessFactor = mix(metalnessFactor, uCgC.z, cgWin);

  // 夜間の点灯（昼は寄与 0 なので計算しない）
  if (uCgNight > 0.0) {
    float cgRowH = cgHash3(vec3(cgCell.y * 3.7 + 1.0, cgSeed * 51.0, cgFaceId + 5.0));
    float cgAct = clamp(uCgNight * 1.5 - 0.1, 0.0, 1.0);
    float cgLitP = vCgD.w;
    float cgLit = step(cgH, cgLitP * cgAct);
    cgLit = max(cgLit, step(cgRowH, uCgC.x * cgAct) * step(cgH, 0.9));
    vec3 cgWarm = vec3(1.0, 0.6, 0.26);
    vec3 cgCoolC = vec3(0.55, 0.75, 1.0);
    float cgCool = step(fract(cgH * 23.17), uCgA.z);
    vec3 cgLitCol = mix(cgWarm, cgCoolC, cgCool) * (0.5 + 0.5 * fract(cgH * 7.31));
    // 遠景の平均発光: 単純平均だと暖色と寒色が混ざった明るい灰色になり、ガラス塔が「白い柱」に見える。
    // 暗め・暖色寄りにして、窓 4x3 ブロック単位の点灯ムラを残す（ブロックも潰れる距離では平均へ）
    vec3 cgAvgCol = mix(cgWarm, cgCoolC, uCgA.z * 0.5) * 0.5;
    float cgAvgLit = clamp((cgLitP + uCgC.x * 0.9) * cgAct, 0.0, 1.0);
    vec2 cgCellC = floor(cgG / vec2(4.0, 3.0));
    float cgHC = cgHash3(vec3(cgCellC.x * 3.1 + cgFaceId * 7.0, cgCellC.y * 1.7 + 9.0, cgSeed * 53.0));
    float cgClust = mix(mix(0.3, 1.7, step(cgHC, 0.5)), 1.0, smoothstep(1.2, 3.0, max(cgFw.x, cgFw.y)));
    vec3 cgEm = mix(cgLitCol * cgLit, cgAvgCol * cgAvgLit * cgClust * 0.5, cgFar);
    totalEmissiveRadiance += cgEm * cgWin * uCgNight * uCgB.z;
    totalEmissiveRadiance += cgSignCol * cgSign * uCgNight * 1.2;
  }
  totalEmissiveRadiance += cgGlass * cgWin * uCgDay * uCgC.w;
  totalEmissiveRadiance += vec3(1.0, 0.8, 0.5) * cgSf * (0.06 * uCgDay + uCgNight * 1.6);
}
`;

// 太陽（月）に背を向けた面では直接光が 0 になるので、PCF 影サンプリング（16 タップ）を省く（結果は同一）
const SHADOW_SKIP_FROM = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
const SHADOW_SKIP_TO = 'directLight.color *= ( directLight.visible && receiveShadow && dot( geometryNormal, directLight.direction ) > 0.0 ) ? getShadow( directionalShadowMap[ i ]';
function patchShadowSkip(shader) {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (!chunk.includes(SHADOW_SKIP_FROM)) return;
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', chunk.replace(SHADOW_SKIP_FROM, SHADOW_SKIP_TO));
}

function makeWindowMaterial(o) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: o.roughness ?? 0.85,
    metalness: o.metalness ?? 0.02,
  });
  const uWin = new THREE.Vector4(o.cellW, o.cellH, o.fracX, o.fracY);
  const uA = new THREE.Vector4(o.store ?? 0, o.lit ?? 0.4, o.cool ?? 0.2, o.glass ? 1 : 0);
  const uB = new THREE.Vector4(o.wallFrac ?? 1, o.band ?? 0, o.gain ?? 2.4, o.plinth ?? 0.4);
  const uC = new THREE.Vector4(o.floorLit ?? 0, o.corrugation ?? 0, o.glassMetal ?? 0.15, o.sheen ?? 0.06);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCgNight = SHARED.uCgNight;
    shader.uniforms.uCgDay = SHARED.uCgDay;
    shader.uniforms.uCgWin = { value: uWin };
    shader.uniforms.uCgA = { value: uA };
    shader.uniforms.uCgB = { value: uB };
    shader.uniforms.uCgC = { value: uC };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + WINDOW_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_FRAG_PARS)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + WINDOW_FRAG);
    patchShadowSkip(shader);
  };
  // シェーダ文字列は全窓マテリアル共通（差はユニフォームのみ）なのでキャッシュキーも共通
  mat.customProgramCacheKey = () => 'citygrow-window-v3';
  return mat;
}

// 夜に自身の色で光る（看板用）
function makeGlowMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCgNight = SHARED.uCgNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCgNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (0.05 + uCgNight * 1.4);');
    patchShadowSkip(shader);
  };
  mat.customProgramCacheKey = () => 'citygrow-glow-v2';
  return mat;
}

// 屋上の小物など: 画面上のサイズ（CSS px）が小さくなるとインスタンスごとに根元へ縮めて消す。
// 数 px のサブピクセル三角形はラスタライズ（MSAA）で割高なので、見えない大きさになったら描かない
const LOD_VERT_PARS = /* glsl */ `
uniform float uCgLodPx;
uniform vec3 uCgCamPos;
uniform vec3 uCgLod; // 基準サイズ, 消え始め px, 完全表示 px
`;
const LOD_VERT = /* glsl */ `
#ifdef USE_INSTANCING
{
  float cgSc = pow(max(length(instanceMatrix[0].xyz) * length(instanceMatrix[1].xyz) * length(instanceMatrix[2].xyz), 1e-12), 1.0 / 3.0);
  vec3 cgIp = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  float cgPx = uCgLod.x * cgSc * uCgLodPx / max(distance(cgIp, uCgCamPos), 1.0);
  transformed *= smoothstep(uCgLod.y, uCgLod.z, cgPx);
}
#endif
`;

function injectLod(shader, uLod) {
  shader.uniforms.uCgLodPx = SHARED.uCgLodPx;
  shader.uniforms.uCgCamPos = SHARED.uCgCamPos;
  shader.uniforms.uCgLod = uLod;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + LOD_VERT_PARS)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + LOD_VERT);
}

// base マテリアルに LOD を足した複製と、同じ LOD で縮む影用デプスマテリアル
function withLod(base, geo, range) {
  const mat = base.clone();
  const size = geo.boundingSphere ? geo.boundingSphere.radius * 2 : 1;
  const uLod = { value: new THREE.Vector3(size, range[0], range[1]) };
  const prev = base.onBeforeCompile;
  const prevKey = base.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    injectLod(shader, uLod);
  };
  mat.customProgramCacheKey = () => prevKey + '|cg-lod';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => injectLod(shader, uLod);
  depth.customProgramCacheKey = () => 'cg-lod-depth';
  return { mat, depth, size };
}

function litMaterial(o) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, ...o });
  mat.onBeforeCompile = (shader) => patchShadowSkip(shader);
  mat.customProgramCacheKey = () => 'citygrow-lit-v1';
  return mat;
}

function buildMaterials() {
  const M = {};
  M.house = makeWindowMaterial({ cellW: 1.1, cellH: 1.4, fracX: 0.46, fracY: 0.5, lit: 0.5, cool: 0.1, wallFrac: HOUSE_WALL, plinth: 0.35, gain: 1.6 });
  M.apt = makeWindowMaterial({ cellW: 1.2, cellH: 1.4, fracX: 0.56, fracY: 0.5, lit: 0.42, cool: 0.18, band: 1, plinth: 0.45, gain: 1.6 });
  M.tower = makeWindowMaterial({ cellW: 1.0, cellH: 1.3, fracX: 0.62, fracY: 0.52, lit: 0.4, cool: 0.25, band: 1, plinth: 0.8, gain: 1.5, glassMetal: 0.25, sheen: 0.08 });
  M.shop = makeWindowMaterial({ cellW: 1.2, cellH: 1.4, fracX: 0.6, fracY: 0.5, store: 1.45, lit: 0.35, cool: 0.3, plinth: 1.6, gain: 1.5 });
  M.office = makeWindowMaterial({ cellW: 1.1, cellH: 1.3, fracX: 0.8, fracY: 0.5, store: 1.7, lit: 0.28, cool: 0.55, floorLit: 0.22, plinth: 1.9, gain: 1.5, glassMetal: 0.3, sheen: 0.12, roughness: 0.75 });
  M.glass = makeWindowMaterial({ cellW: 0.75, cellH: 1.05, fracX: 0.9, fracY: 0.8, glass: true, lit: 0.3, cool: 0.6, floorLit: 0.28, plinth: 0.3, gain: 1.3, glassMetal: 0.4, sheen: 0.32, roughness: 0.55, metalness: 0.2 });
  M.ind = makeWindowMaterial({ cellW: 1.2, cellH: 1.0, fracX: 0.62, fracY: 0.45, lit: 0.45, cool: 0.5, band: 2, corrugation: 1, plinth: 0, gain: 0.75, glassMetal: 0.2 });
  M.plain = litMaterial({ roughness: 0.85, metalness: 0.0 });
  M.roof = litMaterial({ roughness: 0.72, metalness: 0.05 });
  M.metal = litMaterial({ roughness: 0.5, metalness: 0.35 });
  M.foliage = litMaterial({ roughness: 0.92, metalness: 0.0 });
  M.glow = makeGlowMaterial();
  M.beacon = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3322, emissiveIntensity: 0.3, roughness: 0.4 });
  return M;
}

// ---------------------------------------------------------------------------------------------
// アーキタイプ。layout(b, T) はパーツごとに [px,py,pz, sx,sy,sz, ry, visible] を書く（建物ローカル、正面 +Z）
// パーツ: shadow = 影を落とすか, lod = [消え始め px, 完全表示 px]（画面上の大きさで縮めて消す小物。影パスでも同じく縮む）
const NO_SHADOW = false;
const LOD_TINY = [2.5, 5];
const LOD_SMALL = [3, 6];
const LOD_MED = [1.8, 3.6];

const STRIDE = 8;
let W = 1, D = 1, H = 1;

function dims(b) {
  W = clamp(b.w, 0.3, 0.97) * C;
  D = clamp(b.d, 0.3, 0.97) * C;
  H = Math.max(b.height || 0, 1.5);
}

function P(T, i, px, py, pz, sx, sy, sz, ry = 0) {
  const o = i * STRIDE;
  T[o] = px; T[o + 1] = py; T[o + 2] = pz;
  T[o + 3] = sx; T[o + 4] = sy; T[o + 5] = sz;
  T[o + 6] = ry; T[o + 7] = 1;
}
function hide(T, i) {
  T[i * STRIDE + 7] = 0;
}
function setCol(Cs, i, col, k = 1) {
  Cs[i * 3] = col.r * k;
  Cs[i * 3 + 1] = col.g * k;
  Cs[i * 3 + 2] = col.b * k;
}
function copyCol(Cs, dst, src, k = 1) {
  Cs[dst * 3] = Cs[src * 3] * k;
  Cs[dst * 3 + 1] = Cs[src * 3 + 1] * k;
  Cs[dst * 3 + 2] = Cs[src * 3 + 2] * k;
}
function frontDepth() {
  return clamp(C / 2 - D / 2 + 0.15, 0.25, 0.6);
}
const HALF_PI = Math.PI / 2;

const A = Object.freeze({ HOUSE: 0, LOWAPT: 1, APT: 2, TOWER: 3, SHOP: 4, OFFICE: 5, GLASS: 6, FACTORY: 7, PARK_A: 8, PARK_B: 9 });

function archetypeOf(b) {
  const lv = b.level | 0;
  switch (b.zone) {
    case ZONE.RES:
      if (lv <= 1) return rv(b, 9) < 0.12 ? A.LOWAPT : A.HOUSE;
      if (lv === 2) return rv(b, 9) < 0.3 ? A.HOUSE : A.LOWAPT;
      return lv === 3 ? A.APT : A.TOWER;
    case ZONE.COM:
      if (lv <= 2) return A.SHOP;
      return lv === 3 ? A.OFFICE : A.GLASS;
    case ZONE.IND:
      return A.FACTORY;
    case ZONE.PARK:
      return rv(b, 9) < 0.5 ? A.PARK_A : A.PARK_B;
    default:
      return A.LOWAPT;
  }
}

function buildArchetypes(G, M) {
  const defs = [];

  defs[A.HOUSE] = {
    name: 'house',
    cap: 1024,
    parts: [
      { geo: G.houseBody, mat: M.house },
      { geo: G.gable, mat: M.roof },
      { geo: G.box, mat: M.plain, lod: LOD_TINY },
    ],
    layout(b, T) {
      dims(b);
      const bodyH = Math.min(H, 6) * 1.1;
      const wall = bodyH * HOUSE_WALL;
      const slope = (bodyH - wall) / (D * 0.5);
      const ov = 0.24;
      const top = bodyH + 0.1;
      const eave = top - slope * (D * 0.5 + ov);
      P(T, 0, 0, 0, 0, W, bodyH, D);
      P(T, 1, 0, eave, 0, W + 0.32, top - eave, D + ov * 2);
      if (rv(b, 3) < 0.55) {
        const cx = (rv(b, 4) < 0.5 ? -1 : 1) * W * 0.27;
        const roofAt = top - slope * D * 0.22;
        P(T, 2, cx, wall, -D * 0.22, 0.34, roofAt - wall + 0.45, 0.34);
      } else hide(T, 2);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.houseWall, rv(b, 1)), 0.94 + 0.1 * rv(b, 5));
      setCol(Cs, 1, pick(PAL.houseRoof, rv(b, 2)));
      setCol(Cs, 2, pick(PAL.chimney, rv(b, 6)));
    },
  };

  defs[A.LOWAPT] = {
    name: 'lowapt',
    cap: 512,
    parts: [
      { geo: G.box, mat: M.apt },
      { geo: G.tank, mat: M.metal, lod: LOD_SMALL },
      { geo: G.box, mat: M.plain, lod: LOD_MED },
      { geo: G.box, mat: M.plain, lod: LOD_SMALL },
    ],
    layout(b, T) {
      dims(b);
      P(T, 0, 0, 0, 0, W, H, D);
      if (rv(b, 3) < 0.5 && H > 4) P(T, 1, W * 0.24, H, -D * 0.2, 0.75, 0.75, 0.75);
      else hide(T, 1);
      P(T, 2, -W * 0.22, H, -D * 0.12, W * 0.26, 0.9, D * 0.3);
      const dp = frontDepth();
      P(T, 3, (rv(b, 4) - 0.5) * W * 0.4, Math.min(1.12, H * 0.4), D / 2 + dp / 2, Math.min(1.4, W * 0.35), 0.1, dp);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.apt, rv(b, 1)), 0.95 + 0.1 * rv(b, 5));
      setCol(Cs, 1, pick(PAL.tank, rv(b, 2)));
      copyCol(Cs, 2, 0, 0.86);
      setCol(Cs, 3, pick(PAL.concrete, rv(b, 6)));
    },
  };

  defs[A.APT] = {
    name: 'apt',
    cap: 512,
    parts: [
      { geo: G.box, mat: M.apt },
      { geo: G.box, mat: M.plain, lod: LOD_MED },
      { geo: G.tank, mat: M.metal, lod: LOD_SMALL },
      { geo: G.ac, mat: M.metal, lod: LOD_SMALL },
    ],
    layout(b, T) {
      dims(b);
      P(T, 0, 0, 0, 0, W, H, D);
      P(T, 1, -W * 0.22, H, -D * 0.15, W * 0.28, 1.25, D * 0.28);
      if (rv(b, 3) < 0.6) P(T, 2, W * 0.24, H, -D * 0.22, 0.9, 0.9, 0.9);
      else hide(T, 2);
      if (rv(b, 4) < 0.7) P(T, 3, W * 0.18, H, D * 0.2, 0.8, 0.8, 0.8, HALF_PI);
      else hide(T, 3);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.apt, rv(b, 1)), 0.95 + 0.1 * rv(b, 5));
      copyCol(Cs, 1, 0, 0.84);
      setCol(Cs, 2, pick(PAL.tank, rv(b, 2)));
      setCol(Cs, 3, pick(PAL.metal, rv(b, 6)));
    },
  };

  defs[A.TOWER] = {
    name: 'tower',
    cap: 256,
    parts: [
      { geo: G.box, mat: M.tower },
      { geo: G.box, mat: M.tower },
      { geo: G.box, mat: M.plain, lod: LOD_MED },
      { geo: G.tank, mat: M.metal, lod: LOD_SMALL },
    ],
    layout(b, T) {
      dims(b);
      const setback = rv(b, 3) < 0.5 && H > 24;
      const lowerH = setback ? H * 0.6 : H;
      const tw = setback ? W * 0.76 : W;
      const td = setback ? D * 0.76 : D;
      P(T, 0, 0, 0, 0, W, lowerH, D);
      if (setback) P(T, 1, 0, lowerH, 0, tw, H - lowerH, td);
      else hide(T, 1);
      P(T, 2, tw * 0.1, H, -td * 0.08, tw * 0.42, 1.9, td * 0.42);
      if (rv(b, 4) < 0.6) P(T, 3, -tw * 0.26, H, td * 0.22, 1, 1, 1);
      else hide(T, 3);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.tower, rv(b, 1)), 0.95 + 0.1 * rv(b, 5));
      copyCol(Cs, 1, 0);
      copyCol(Cs, 2, 0, 0.82);
      setCol(Cs, 3, pick(PAL.tank, rv(b, 2)));
    },
  };

  defs[A.SHOP] = {
    name: 'shop',
    cap: 512,
    parts: [
      { geo: G.box, mat: M.shop },
      { geo: G.awning, mat: M.plain, lod: LOD_MED },
      { geo: G.ac, mat: M.metal, lod: LOD_SMALL },
      { geo: G.box, mat: M.glow, shadow: NO_SHADOW },
    ],
    layout(b, T) {
      dims(b);
      P(T, 0, 0, 0, 0, W, H, D);
      if (rv(b, 3) < 0.75) P(T, 1, 0, 0.72, D / 2, W * 0.86, 0.45, frontDepth());
      else hide(T, 1);
      P(T, 2, (rv(b, 4) - 0.5) * W * 0.3, H, -D * 0.18, 0.8, 0.8, 0.8, rv(b, 5) < 0.5 ? 0 : HALF_PI);
      if (b.level >= 2 || rv(b, 6) < 0.3) P(T, 3, 0, H, D / 2 - 0.14, W * 0.55, 0.8, 0.1);
      else hide(T, 3);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.shop, rv(b, 1)), 0.95 + 0.1 * rv(b, 7));
      setCol(Cs, 1, pick(PAL.awning, rv(b, 2)));
      setCol(Cs, 2, pick(PAL.metal, rv(b, 8)));
      setCol(Cs, 3, pick(PAL.sign, rv(b, 10)), 0.9);
    },
  };

  defs[A.OFFICE] = {
    name: 'office',
    cap: 256,
    parts: [
      { geo: G.box, mat: M.office },
      { geo: G.box, mat: M.plain, lod: LOD_MED },
      { geo: G.ac, mat: M.metal, lod: LOD_SMALL },
      { geo: G.tank, mat: M.metal, lod: LOD_SMALL },
    ],
    layout(b, T) {
      dims(b);
      P(T, 0, 0, 0, 0, W, H, D);
      P(T, 1, (rv(b, 3) - 0.5) * W * 0.25, H, -D * 0.1, W * 0.4, 1.6, D * 0.36);
      P(T, 2, W * 0.2, H, D * 0.24, 0.85, 0.85, 0.85, HALF_PI);
      if (rv(b, 4) < 0.5) P(T, 3, -W * 0.27, H, D * 0.24, 1, 1, 1);
      else hide(T, 3);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.office, rv(b, 1)), 0.95 + 0.1 * rv(b, 5));
      copyCol(Cs, 1, 0, 0.8);
      setCol(Cs, 2, pick(PAL.metal, rv(b, 2)));
      setCol(Cs, 3, pick(PAL.tank, rv(b, 6)));
    },
  };

  defs[A.GLASS] = {
    name: 'glass',
    cap: 256,
    parts: [
      { geo: G.box, mat: M.office },
      { geo: G.box, mat: M.glass },
      { geo: G.box, mat: M.glass },
      { geo: G.box, mat: M.metal },
      { geo: G.frustum, mat: M.metal },
      { geo: G.antenna, mat: M.metal },
      { geo: G.beacon, mat: M.beacon, shadow: false },
    ],
    layout(b, T) {
      dims(b);
      const s = rv(b, 3);
      let tw = W, td = D;
      if (s < 0.35) {
        hide(T, 0);
        P(T, 1, 0, 0, 0, W, H, D);
        hide(T, 2);
      } else if (s < 0.7) {
        hide(T, 0);
        const lh = H * 0.62;
        tw = W * 0.72; td = D * 0.72;
        P(T, 1, 0, 0, 0, W, lh, D);
        P(T, 2, 0, lh, 0, tw, H - lh, td);
      } else {
        const ph = Math.min(6, H * 0.16);
        tw = W * 0.8; td = D * 0.8;
        P(T, 0, 0, 0, 0, W, ph, D);
        P(T, 1, 0, ph, 0, tw, H - ph, td);
        hide(T, 2);
      }
      const tall = b.level >= 5 || H > 55;
      let crownTop;
      if (tall && rv(b, 4) < 0.55) {
        const sh = 2.5 + H * 0.06;
        hide(T, 3);
        P(T, 4, 0, H, 0, tw * 0.94, sh, td * 0.94);
        crownTop = H + sh;
      } else {
        const ch = 1.1 + H * 0.015;
        P(T, 3, 0, H, 0, tw * 0.72, ch, td * 0.72);
        hide(T, 4);
        crownTop = H + ch;
      }
      if (tall) {
        const al = 4 + H * 0.1;
        P(T, 5, 0, crownTop, 0, 1, al, 1);
        P(T, 6, 0, crownTop + al + 0.1, 0, 1, 1, 1);
      } else {
        hide(T, 5);
        hide(T, 6);
      }
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.office, rv(b, 1)));
      setCol(Cs, 1, pick(PAL.frame, rv(b, 2)));
      copyCol(Cs, 2, 1);
      setCol(Cs, 3, pick(PAL.crown, rv(b, 5)));
      copyCol(Cs, 4, 3);
      setCol(Cs, 5, PAL.metal[0]);
      Cs[18] = 1; Cs[19] = 1; Cs[20] = 1;
    },
  };

  defs[A.FACTORY] = {
    name: 'factory',
    cap: 512,
    parts: [
      { geo: G.box, mat: M.ind },
      { geo: G.sawtooth, mat: M.roof },
      { geo: G.box, mat: M.office },
      { geo: G.chimney, mat: M.plain },
      { geo: G.silo, mat: M.metal },
      { geo: G.ac, mat: M.metal, lod: LOD_SMALL },
      { geo: G.crates, mat: M.plain, lod: LOD_SMALL },
    ],
    layout(b, T) {
      dims(b);
      const saw = rv(b, 3) < 0.45;
      const silo = rv(b, 4) < 0.4;
      // 煙突は工業地区が「剣山」にならない程度に（約 3 割）
      const chim = silo ? rv(b, 5) < 0.1 : rv(b, 5) < 0.36;
      const shedW = silo ? W * 0.68 : W;
      const shedX = silo ? -W * 0.16 : 0;
      const shedD = D * 0.74;
      const shedZ = -D * 0.13;
      // 工場は低く横に広く見せる（煙突で高さを出す）
      const mass = 1.9 + H * 0.26;
      const shedH = saw ? mass * 0.82 : mass;
      P(T, 0, shedX, 0, shedZ, shedW, shedH, shedD);
      if (saw) P(T, 1, shedX, shedH, shedZ, shedW, 0.7 + mass * 0.08, shedD);
      else hide(T, 1);
      P(T, 2, -W * 0.28, 0, D * 0.38, W * 0.42, Math.min(3.0, mass * 0.7), D * 0.22);
      if (chim) P(T, 3, shedX + shedW * 0.3, 0, shedZ - shedD * 0.22, 0.8, mass + 2.0 + H * 0.5, 0.8);
      else hide(T, 3);
      if (silo) P(T, 4, W * 0.34, 0, -D * 0.14, W * 0.28, mass * 1.25 + 0.6, W * 0.28, HALF_PI);
      else hide(T, 4);
      if (!saw) P(T, 5, shedX - shedW * 0.18, shedH, shedZ + shedD * 0.12, 1, 1, 1);
      else hide(T, 5);
      P(T, 6, W * 0.24, 0, D * 0.38, 0.9, 0.9, 0.9);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.ind, rv(b, 1)), 0.95 + 0.1 * rv(b, 6));
      setCol(Cs, 1, pick(PAL.indRoof, rv(b, 2)));
      setCol(Cs, 2, pick(PAL.office, rv(b, 7)));
      setCol(Cs, 3, pick(PAL.concrete, rv(b, 8)));
      setCol(Cs, 4, pick(PAL.tank, rv(b, 10)));
      setCol(Cs, 5, pick(PAL.metal, rv(b, 11)));
      const t = 0.85 + 0.25 * rv(b, 12);
      Cs[18] = t; Cs[19] = t; Cs[20] = t;
    },
  };

  const parkDef = (name, geo) => ({
    name,
    cap: 256,
    parts: [
      { geo: G.box, mat: M.plain, shadow: NO_SHADOW },
      { geo, mat: M.foliage },
    ],
    layout(b, T) {
      P(T, 0, 0, 0, 0, C * 0.96, 0.07, C * 0.96);
      P(T, 1, 0, 0, 0, 1, 1, 1, rv(b, 3) < 0.5 ? 0 : HALF_PI);
    },
    colors(b, Cs) {
      setCol(Cs, 0, pick(PAL.lawn, rv(b, 1)), 0.95 + 0.1 * rv(b, 4));
      const t = 0.9 + 0.18 * rv(b, 2);
      Cs[3] = t; Cs[4] = t * (1.0 + 0.06 * rv(b, 5)); Cs[5] = t;
    },
  });
  defs[A.PARK_A] = parkDef('parkA', G.parkA);
  defs[A.PARK_B] = parkDef('parkB', G.parkB);

  return defs;
}

// ---------------------------------------------------------------------------------------------
// BuildingView

const DIRTY_LIST = 24;
const RENDER_ORDER = -3; // 空（-1000）の後、道路・車（-2）や地形（0）より前

function heightOf(b) {
  return b.zone === ZONE.PARK ? 1 : Math.max(b.height || 0, 1.5);
}

export class BuildingView {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'BuildingView';
    scene.add(this.group);

    this.geometries = buildGeometries();
    this.materials = buildMaterials();
    this.archetypes = buildArchetypes(this.geometries, this.materials).map((def, index) => this._createArchetype(def, index));

    this.entries = new Map(); // id → entry
    this.animating = [];
    this.pendingOps = new Map(); // id → OP_* ビット
    this.pendingRefs = new Map(); // id → building
    this.time = 0;
    this._pos = { x: 0, z: 0 };

    if (city.buildings) {
      for (const b of city.buildings.values()) this._add(b, false);
    }
    this._flush();

    const ev = city.events;
    this._unsubs = [
      ev.on('building:add', (p) => this._queue(p && p.building, OP_ADD)),
      ev.on('building:upgrade', (p) => this._queue(p && p.building, OP_UPG)),
      ev.on('building:remove', (p) => this._queue(p && p.building, OP_REM)),
    ];
  }

  update(env) {
    const dt = env.dt || 0;
    this.time += dt;
    const night = env.night || 0;
    SHARED.uCgNight.value = night;
    SHARED.uCgDay.value = env.daylight ?? 1 - night;
    const blink = this.time % 1.6 < 0.18 ? 1 : 0.1;
    this.materials.beacon.emissiveIntensity = (0.3 + 3.5 * night) * blink;

    if (this.pendingOps.size > 0) this._processPending();

    const step = Math.min(env.simDt || 0, dt * 2) / RISE_TIME;
    if (step > 0 && this.animating.length > 0) this._stepAnim(step);

    this._updateLod(env.camera);
    this._flush();
  }

  dispose() {
    for (const off of this._unsubs) off();
    for (const arch of this.archetypes) {
      for (const pool of arch.pools) {
        pool.mesh.dispose();
        if (pool.material !== pool.part.mat) pool.material.dispose();
        if (pool.depthMaterial) pool.depthMaterial.dispose();
      }
    }
    for (const g of Object.values(this.geometries)) g.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.scene.remove(this.group);
  }

  // 画面サイズ LOD: シェーダ側でインスタンスごとに縮める。全インスタンスが閾値未満ならメッシュごと描かない
  _updateLod(camera) {
    const persp = !!(camera && camera.isPerspectiveCamera);
    const h = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const px = persp ? (h * (camera.zoom || 1)) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) : 1e6;
    SHARED.uCgLodPx.value = px;
    if (persp) SHARED.uCgCamPos.value.copy(camera.position);
    const camY = persp ? camera.position.y : -1e6;
    for (const arch of this.archetypes) {
      for (const pool of arch.pools) {
        const mesh = pool.mesh;
        if (pool.count === 0) {
          mesh.visible = false;
          continue;
        }
        if (!pool.lod) {
          mesh.visible = true;
          continue;
        }
        // カメラから最も近いインスタンスでもこれ以上は離れている
        const minDist = Math.max(1, camY - pool.maxY);
        mesh.visible = (pool.size * pool.maxScale * px) / minDist > pool.lod[0];
      }
    }
  }

  // --- イベント ---------------------------------------------------------------------------

  _queue(b, op) {
    if (!b) return;
    this.pendingOps.set(b.id, (this.pendingOps.get(b.id) || 0) | op);
    this.pendingRefs.set(b.id, b);
  }

  _processPending() {
    for (const [id, op] of this.pendingOps) {
      const b = this.pendingRefs.get(id);
      const e = this.entries.get(id);
      if (op & OP_REM) {
        if (e) this._remove(e);
      } else if (!e) {
        this._add(b, true);
      } else if (op & OP_UPG || archetypeOf(b) !== e.arch.index || heightOf(b) !== e.height) {
        this._upgrade(e, b);
      }
    }
    this.pendingOps.clear();
    this.pendingRefs.clear();
  }

  _add(b, animate) {
    const e = { id: b.id, b, arch: null, slots: null, t: 1, from: 0, height: heightOf(b), anim: -1, dying: false };
    this.entries.set(b.id, e);
    this._assign(this.archetypes[archetypeOf(b)], e);
    if (animate) {
      e.t = 0;
      e.from = 0;
      this._startAnim(e);
    }
    this._writeMatrices(e);
  }

  _upgrade(e, b) {
    const visual = e.height * this._scaleOf(e);
    const newH = heightOf(b);
    let from = b.zone === ZONE.PARK ? 0 : clamp(visual / newH, 0, 1);
    const ai = archetypeOf(b);
    e.b = b;
    if (ai !== e.arch.index) {
      this._free(e);
      this._assign(this.archetypes[ai], e);
      from = Math.min(from, 0.55);
    } else if (from > 0.97) {
      from = 0.9;
    }
    e.height = newH;
    e.from = from;
    e.t = 0;
    this._writeColors(e);
    if (e.anim < 0) this._startAnim(e);
    this._writeMatrices(e);
  }

  _remove(e) {
    this.entries.delete(e.id);
    e.from = this._scaleOf(e);
    e.t = 0;
    e.dying = true;
    if (e.anim < 0) this._startAnim(e);
  }

  // --- アニメーション ---------------------------------------------------------------------

  _startAnim(e) {
    e.anim = this.animating.length;
    this.animating.push(e);
  }

  _stopAnim(e) {
    const list = this.animating;
    const last = list.pop();
    if (last !== e) {
      list[e.anim] = last;
      last.anim = e.anim;
    }
    e.anim = -1;
  }

  _stepAnim(step) {
    const list = this.animating;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dying) {
        e.t += step * 2.4;
        if (e.t >= 1) {
          this._stopAnim(e);
          this._free(e);
          continue;
        }
        this._writeMatrices(e);
        continue;
      }
      e.t += step;
      if (e.t >= 1) {
        e.t = 1;
        this._stopAnim(e);
      }
      this._writeMatrices(e);
    }
  }

  // 建設中の Y スケール（ease-out + 少しのオーバーシュート）
  _scaleOf(e) {
    if (e.dying) return Math.max(0.002, e.from * (1 - e.t * e.t));
    if (e.t >= 1) return 1;
    const u = e.t - 1;
    const k = 1 + 2.2 * u * u * u + 1.2 * u * u;
    return Math.max(0.002, e.from + (1 - e.from) * k);
  }

  // --- インスタンススロット ---------------------------------------------------------------
  // パーツごとに独立した詰めたスロット列（プール）を持つ。非表示のパーツはスロットを占有しない
  // （ゼロスケールのインスタンスで頂点処理を無駄にしない）。エントリは e.slots[part] = スロット or -1

  _createArchetype(def, index) {
    const n = def.parts.length;
    const arch = { def, index, pools: [], T: new Float32Array(n * STRIDE), Cs: new Float32Array(n * 3) };
    for (let i = 0; i < n; i++) {
      const part = def.parts[i];
      const lod = part.lod ? withLod(part.mat, part.geo, part.lod) : null;
      const pool = {
        part,
        index: i,
        material: lod ? lod.mat : part.mat,
        depthMaterial: lod ? lod.depth : null,
        lod: part.lod || null,
        size: lod ? lod.size : 0,
        maxY: 0,
        maxScale: 0,
        capacity: def.cap,
        count: 0,
        owners: new Array(def.cap).fill(null),
        mesh: null,
        dirtySlots: new Int32Array(DIRTY_LIST),
        dirtyN: 0,
        dirtyMin: Infinity,
        dirtyMax: -1,
        colorMin: Infinity,
        colorMax: -1,
        rebuilt: false,
        staleGPU: false, // 非表示の間に変更があった → 次に見えたとき全体を送る
      };
      pool.mesh = this._createMesh(def, pool, def.cap);
      arch.pools.push(pool);
    }
    return arch;
  }

  _createMesh(def, pool, capacity) {
    const part = pool.part;
    const mesh = new THREE.InstancedMesh(part.geo, pool.material, capacity);
    mesh.name = `building:${def.name}:${pool.index}`;
    mesh.count = 0;
    mesh.visible = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = part.shadow !== false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    // 不透明パスで建物を道路・地面より先に描く（大きな遮蔽物が先に深度を埋めると、隠れる地面・歩道の
    // フラグメントが早期深度テストで捨てられる）。three は renderOrder → マテリアル ID の順に並べる
    mesh.renderOrder = RENDER_ORDER;
    if (pool.depthMaterial) mesh.customDepthMaterial = pool.depthMaterial;
    this.group.add(mesh);
    return mesh;
  }

  _grow(arch, pool) {
    const cap = pool.capacity * 2;
    const old = pool.mesh;
    const mesh = this._createMesh(arch.def, pool, cap);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    mesh.instanceColor.array.set(old.instanceColor.array);
    mesh.count = pool.count;
    mesh.visible = old.visible;
    this.group.remove(old);
    old.dispose();
    pool.mesh = mesh;
    for (let i = pool.capacity; i < cap; i++) pool.owners.push(null);
    pool.capacity = cap;
    pool.rebuilt = true;
  }

  _assign(arch, e) {
    e.arch = arch;
    if (!e.slots || e.slots.length !== arch.pools.length) e.slots = new Int32Array(arch.pools.length);
    e.slots.fill(-1);
  }

  _allocSlot(arch, pool, e) {
    if (pool.count >= pool.capacity) this._grow(arch, pool);
    const slot = pool.count++;
    pool.owners[slot] = e;
    e.slots[pool.index] = slot;
    pool.mesh.count = pool.count;
    return slot;
  }

  _freeSlot(pool, slot) {
    const last = pool.count - 1;
    if (slot !== last) {
      const m = pool.mesh;
      m.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      m.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      const moved = pool.owners[last];
      pool.owners[slot] = moved;
      moved.slots[pool.index] = slot;
      this._markDirty(pool, slot);
      this._markColor(pool, slot);
    }
    pool.owners[last] = null;
    pool.count = last;
    pool.mesh.count = last;
  }

  _free(e) {
    const arch = e.arch;
    if (!arch) return;
    const slots = e.slots;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] >= 0) this._freeSlot(arch.pools[i], slots[i]);
      slots[i] = -1;
    }
    e.arch = null;
  }

  _markDirty(pool, slot) {
    if (slot < pool.dirtyMin) pool.dirtyMin = slot;
    if (slot > pool.dirtyMax) pool.dirtyMax = slot;
    if (pool.dirtyN < DIRTY_LIST) pool.dirtySlots[pool.dirtyN] = slot;
    pool.dirtyN++;
  }

  _markColor(pool, slot) {
    if (slot < pool.colorMin) pool.colorMin = slot;
    if (slot > pool.colorMax) pool.colorMax = slot;
  }

  _writeColor(pool, slot, Cs) {
    const a = pool.mesh.instanceColor.array;
    const i = pool.index * 3;
    const o = slot * 3;
    a[o] = Cs[i];
    a[o + 1] = Cs[i + 1];
    a[o + 2] = Cs[i + 2];
    this._markColor(pool, slot);
  }

  _writeColors(e) {
    const arch = e.arch;
    arch.def.colors(e.b, arch.Cs);
    for (let i = 0; i < arch.pools.length; i++) {
      if (e.slots[i] >= 0) this._writeColor(arch.pools[i], e.slots[i], arch.Cs);
    }
  }

  // 行列 = T(セル中心 + R·p) · R(angle + ry) · S(sx, sy·s, sz)（Y 回転のみなので直接書く）
  // レイアウトで表示/非表示が変わったパーツはここでスロットを確保/解放する
  _writeMatrices(e) {
    const arch = e.arch;
    const T = arch.T;
    const b = e.b;
    arch.def.layout(b, T);
    const s = this._scaleOf(e);
    const ang = rotationToAngle(b.rotation);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    cellToWorld(b.x, b.z, this._pos);
    const bx = this._pos.x;
    const bz = this._pos.z;
    const slots = e.slots;
    let colorsReady = false;
    for (let i = 0; i < arch.pools.length; i++) {
      const pool = arch.pools[i];
      const t = i * STRIDE;
      let slot = slots[i];
      if (T[t + 7] === 0) {
        if (slot >= 0) {
          this._freeSlot(pool, slot);
          slots[i] = -1;
        }
        continue;
      }
      if (slot < 0) {
        slot = this._allocSlot(arch, pool, e);
        if (!colorsReady) {
          arch.def.colors(b, arch.Cs);
          colorsReady = true;
        }
        this._writeColor(pool, slot, arch.Cs);
      }
      const m = pool.mesh.instanceMatrix.array;
      const o = slot * 16;
      const px = T[t], pz = T[t + 2];
      const sx = T[t + 3], sz = T[t + 5], ry = T[t + 6];
      const sy = Math.max(T[t + 4] * s, 1e-4);
      let c = ca, sn = sa;
      if (ry !== 0) {
        c = Math.cos(ang + ry);
        sn = Math.sin(ang + ry);
      }
      m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -sn * sx; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn * sz; m[o + 9] = 0; m[o + 10] = c * sz; m[o + 11] = 0;
      m[o + 12] = bx + ca * px + sa * pz;
      m[o + 13] = T[t + 1] * s;
      m[o + 14] = bz - sa * px + ca * pz;
      m[o + 15] = 1;
      if (pool.lod) {
        const top = m[o + 13] + sy * 2;
        if (top > pool.maxY) pool.maxY = top;
        const sc = Math.cbrt(sx * sy * sz);
        if (sc > pool.maxScale) pool.maxScale = sc;
      }
      this._markDirty(pool, slot);
    }
  }

  // 変更スロットだけ GPU へ
  _flush() {
    for (const arch of this.archetypes) {
      for (const pool of arch.pools) {
        const hasM = pool.dirtyN > 0;
        const hasC = pool.colorMax >= 0;
        const changed = hasM || hasC || pool.rebuilt;
        const mesh = pool.mesh;
        if (!mesh.visible) {
          // 描かれないメッシュに updateRange を積まない（three は描画時にしか消費・クリアしないので溜まり続ける）。
          // 変更があったことだけ覚えておき、見えるようになったら全体を送る
          if (changed) {
            pool.staleGPU = true;
            pool.dirtyN = 0;
            pool.dirtyMin = Infinity;
            pool.dirtyMax = -1;
            pool.colorMin = Infinity;
            pool.colorMax = -1;
            pool.rebuilt = false;
          }
          continue;
        }
        if (!changed && !pool.staleGPU) continue;
        if (pool.rebuilt || pool.staleGPU) {
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.needsUpdate = true;
        } else {
          if (hasM) {
            const attr = mesh.instanceMatrix;
            if (pool.dirtyN <= DIRTY_LIST) {
              for (let k = 0; k < pool.dirtyN; k++) attr.addUpdateRange(pool.dirtySlots[k] * 16, 16);
            } else {
              attr.addUpdateRange(pool.dirtyMin * 16, (pool.dirtyMax - pool.dirtyMin + 1) * 16);
            }
            attr.needsUpdate = true;
          }
          if (hasC) {
            const attr = mesh.instanceColor;
            attr.addUpdateRange(pool.colorMin * 3, (pool.colorMax - pool.colorMin + 1) * 3);
            attr.needsUpdate = true;
          }
        }
        pool.dirtyN = 0;
        pool.dirtyMin = Infinity;
        pool.dirtyMax = -1;
        pool.colorMin = Infinity;
        pool.colorMax = -1;
        pool.rebuilt = false;
        pool.staleGPU = false;
      }
    }
  }
}
