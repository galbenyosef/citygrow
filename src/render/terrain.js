import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, TILE, ZONE, ROAD, ZONE_COLORS, cellToWorld, clamp } from '../config.js';
import { hash2, createNoise2D, fbm } from '../core/rng.js';

const G = CONFIG.GRID;
const CELL = CONFIG.CELL;
const HALF = (G * CELL) / 2;
const N1 = G + 1;
const Y_WATER = -0.6;
const Y_BOTTOM = -1.8;
const Y_ZONE = 0.03;
// マップ外の地形（マップ端からの距離、セル単位）: 1セル刻み → 2セル刻み → 粗いリング
const OUT_FINE = 56;
const OUT_MID = 120;
const OUT_FAR = [132, 146, 162, 182, 206, 236, 272, 318, 376, 450, 545, 665, 820, 1010, 1250];
const OUT_MAX = OUT_FAR[OUT_FAR.length - 1];
const SHORE_EXT = OUT_MID; // 岸距離テクスチャのマップ外マージン（セル）
const TREE_RING = 44; // マップ外に木を植える幅（セル）
const TREE_SHADOW_RING = 18; // これより内側の木だけ影を落とす
const WATER_SIZE = 2 * (HALF + OUT_MAX * CELL);

const col = (hex) => new THREE.Color(hex);
const PAL = {
  grassA: col(0x66904a),
  grassB: col(0x7f9e58),
  dry: col(0x9c9e68),
  lush: col(0x5a8a40),
  marsh: col(0x5b7a4c),
  forest: col(0x4d7236),
  sand: col(0xc2b490),
  wetSand: col(0xa09372),
  deep: col(0x41574f),
  waterDeep: col(0x24698a),
  waterShallow: col(0x4aa6a8),
};

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = { x: 0, z: 0 };

function sstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- outside-the-map field

const EDGE_N = 0;
const EDGE_E = 1;
const EDGE_S = 2;
const EDGE_W = 3;
const RIVER = 0;
const LAKE = 1;
const SEA = 2;

// マップ端に接する水域をマップ外へ自然に延長する。座標は頂点単位（0..G がマップ、セル中心は +0.5）。
// value() > 0 が水（1 で最深部）。川は蛇行しながら細くなって数百ユニット先で陸に消え、
// 湖は端のすぐ外で丸く閉じ、長い海岸線は沖へ広がる。
class OuterField {
  constructor(world, seed) {
    this.world = world;
    this.seed = seed >>> 0;
    this.nMeander = createNoise2D((seed + 0x3c6ef372) >>> 0);
    this.nShore = createNoise2D((seed + 0x7f4a7c15) >>> 0);
    this.nHill = createNoise2D((seed + 0x2545f491) >>> 0);
    this.runs = [[], [], [], []];
    this.wet = 0; // value() の副出力: 川が消えていく湿地の度合い
    for (let e = 0; e < 4; e++) this._scanEdge(e);
    // 海岸線が角を回り込む場合、隣の辺の角に接する水域も海として沖へ広げる（細いフィヨルド状にしない）
    const cornerSea = (e, atStart) => this.runs[e].some((r) => r.type === SEA && (atStart ? r.a === 0 : r.b === G));
    // 各辺の t=0 側 / t=G 側の角で接する辺と、その辺側で角が t=0 か
    const adj = [
      [EDGE_W, EDGE_E], // N: NW → W の t=0, NE → E の t=0
      [EDGE_N, EDGE_S], // E: NE → N の t=G, SE → S の t=G
      [EDGE_W, EDGE_E], // S: SW → W の t=G, SE → E の t=G
      [EDGE_N, EDGE_S], // W: NW → N の t=0, SW → S の t=0
    ];
    const startOfAdj = [true, false, false, true];
    for (let e = 0; e < 4; e++) {
      for (const run of this.runs[e]) {
        if (run.type === SEA) continue;
        const lo = run.a === 0 && cornerSea(adj[e][0], startOfAdj[e]);
        const hi = run.b === G && cornerSea(adj[e][1], startOfAdj[e]);
        if (lo || hi) {
          run.type = SEA;
          run.span = Infinity;
        }
      }
    }
    // 両側の辺が角で海なら、その角の外側の象限は丸ごと海（三角の岬を作らない）
    for (let e = 0; e < 4; e++) {
      for (const run of this.runs[e]) {
        if (run.type !== SEA) continue;
        run.openLo = run.a === 0 && cornerSea(adj[e][0], startOfAdj[e]);
        run.openHi = run.b === G && cornerSea(adj[e][1], startOfAdj[e]);
      }
    }
  }

  _water(e, t, k) {
    if (t < 0 || t >= G || k < 0 || k >= G) return false;
    let x;
    let z;
    if (e === EDGE_N) {
      x = t;
      z = k;
    } else if (e === EDGE_S) {
      x = t;
      z = G - 1 - k;
    } else if (e === EDGE_W) {
      x = k;
      z = t;
    } else {
      x = G - 1 - k;
      z = t;
    }
    return this.world.terrain[z * G + x] === TILE.WATER;
  }

  _scanEdge(e) {
    for (let t = 0; t < G; ) {
      if (!this._water(e, t, 0)) {
        t++;
        continue;
      }
      const a = t;
      while (t < G && this._water(e, t, 0)) t++;
      this.runs[e].push(this._makeRun(e, a, t));
    }
  }

  _makeRun(e, a, b) {
    const len = b - a;
    const c0 = (a + b) / 2;
    const rnd = (k) => hash2(e * 131 + a * 7 + k, b * 13 - k * 5, this.seed + 991);

    // マップ内へ辿って流れの向き（傾き）と本来の幅を推定
    let cen = c0;
    let reach = 0;
    let n = 1;
    let sk = 0;
    let sc = c0;
    let skk = 0;
    let skc = 0;
    const widths = [len];
    for (let k = 1; k <= 16; k++) {
      const t0 = Math.floor(cen);
      let f = -1;
      for (let o = 0; o <= 3 && f < 0; o++) {
        if (this._water(e, t0 + o, k)) f = t0 + o;
        else if (this._water(e, t0 - o, k)) f = t0 - o;
      }
      if (f < 0) break;
      let lo = f;
      let hi = f;
      while (this._water(e, lo - 1, k)) lo--;
      while (this._water(e, hi + 1, k)) hi++;
      const w = hi - lo + 1;
      if (w > len * 2.5 + 8) break; // 大きな水域に合流
      cen = (lo + hi + 1) / 2;
      reach = k;
      n++;
      sk += k;
      sc += cen;
      skk += k * k;
      skc += k * cen;
      widths.push(w);
    }
    let slopeIn = 0;
    if (n >= 4) {
      const den = n * skk - sk * sk;
      if (den > 1e-6) slopeIn = (n * skc - sk * sc) / den;
    }
    slopeIn = clamp(slopeIn, -1.5, 1.5);
    widths.sort((p, q) => p - q);
    const wMed = Math.min(len, widths[(widths.length / 2) | 0]);
    const hwTrue = wMed / 2 / Math.sqrt(1 + slopeIn * slopeIn);

    const run = { e, a, b, c0, hw: len / 2, s0: -slopeIn, type: RIVER, span: 0 };
    if (len >= G * 0.4) {
      run.type = SEA;
      run.span = Infinity;
    } else if (reach < 5 || hwTrue > 5.5) {
      run.type = LAKE;
      run.L = clamp(run.hw * (0.9 - 0.35 * sstep(6, 24, run.hw)), 2.5, 16) + rnd(1) * 4;
      run.span = run.hw + Math.abs(run.s0) * run.L + 4;
    } else {
      // 本流の幅 → 細い小川 → 地面に消える、の3段階
      run.hwT = Math.max(1.3, hwTrue);
      const hwS = Math.min(run.hwT, 1.25 + rnd(6) * 0.35);
      const Lw0 = 6 + rnd(7) * 14;
      const Lw1 = Lw0 + 12 + rnd(8) * 16;
      run.L0 = Lw1 + 8 + rnd(1) * 22;
      run.L1 = run.L0 + 18 + rnd(2) * 16;
      run.dMax = Math.ceil(run.L1 + 32);
      const cnt = run.dMax * 2 + 2;
      run.cen = new Float32Array(cnt);
      run.inv = new Float32Array(cnt);
      run.hwd = new Float32Array(cnt);
      const ph = rnd(3) * 100;
      const ph2 = rnd(4) * 100;
      const amp = 11 + rnd(5) * 9;
      const S = 30;
      let span = 0;
      for (let i = 0; i < cnt; i++) {
        const d = i * 0.5;
        const wiggle = 2.5 * sstep(Lw0, Lw1, d) * this.nMeander(d / 9 + ph, ph2 + 3.7);
        const c = c0 + run.s0 * S * (1 - Math.exp(-d / S)) + amp * sstep(0, 34, d) * fbm(this.nMeander, d / 26 + ph, ph2, 2) + wiggle;
        run.cen[i] = c;
        const base = hwS + (run.hwT - hwS) * (1 - sstep(Lw0, Lw1, d));
        // 細くなりきったら岸（砂）ごと地面に沈める（乾いた水路の筋を残さない）
        const taper = 1 - sstep(run.L0, run.L1, d);
        const sink = 2.5 * sstep(0.45, 0.9, 1 - taper);
        run.hwd[i] = Math.max(0, base * taper * (1 + 0.2 * this.nMeander(d / 9 + ph2, ph + 5.5))) - sink;
        span = Math.max(span, Math.abs(c - c0));
      }
      for (let i = 0; i < cnt; i++) {
        const s = (run.cen[Math.min(cnt - 1, i + 1)] - run.cen[Math.max(0, i - 1)]) / (i > 0 && i < cnt - 1 ? 1 : 0.5);
        run.inv[i] = 1 / Math.sqrt(1 + s * s);
      }
      run.span = span + run.hwT + 8;
    }
    return run;
  }

  value(vx, vz) {
    let v = -1e9;
    let wet = 0;
    for (let e = 0; e < 4; e++) {
      let d;
      let u;
      if (e === EDGE_N) {
        d = -vz;
        u = vx;
      } else if (e === EDGE_S) {
        d = vz - G;
        u = vx;
      } else if (e === EDGE_W) {
        d = -vx;
        u = vz;
      } else {
        d = vx - G;
        u = vz;
      }
      if (d <= 0) continue;
      const runs = this.runs[e];
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        const du = Math.abs(u - run.c0);
        let rv;
        if (run.type === SEA) {
          const inner = Math.min(run.openLo ? Infinity : u - run.a, run.openHi ? Infinity : run.b - u);
          rv = Math.min(inner, 1e4) + d * 0.3 + fbm(this.nShore, vx * 0.017 + 3.3, vz * 0.017 - 8.1, 3) * 16 * sstep(0, 30, d);
        } else if (run.type === LAKE) {
          if (du > run.span) continue;
          const dd = Math.min(d, run.L);
          const k = dd / run.L;
          const hwc = run.hw * Math.sqrt(Math.max(0, 1 - k * k));
          rv = hwc - Math.abs(u - (run.c0 + run.s0 * 0.6 * dd)) - Math.max(0, d - run.L);
          rv += fbm(this.nShore, vx * 0.04 + 7.7, vz * 0.04 - 1.3, 3) * Math.min(9, run.hw * 0.5) * sstep(0, 8, d);
        } else {
          if (d >= run.dMax || du > run.span) continue;
          const fi = d * 2;
          const i0 = fi | 0;
          const t = fi - i0;
          const cen = run.cen[i0] + (run.cen[i0 + 1] - run.cen[i0]) * t;
          const inv = run.inv[i0] + (run.inv[i0 + 1] - run.inv[i0]) * t;
          const lat = Math.abs(u - cen) * inv;
          const hw = run.hwd[i0] + (run.hwd[i0 + 1] - run.hwd[i0]) * t;
          rv = hw - lat;
          if (d > run.L0) {
            const w = sstep(-6, 0, 1.5 - lat) * sstep(run.L0 + 4, run.L1, d) * (1 - sstep(run.L1, run.L1 + 30, d));
            if (w > wet) wet = w;
          }
        }
        if (rv > v) v = rv;
      }
    }
    this.wet = wet;
    return v;
  }

  // 岸線ノイズ込みの値
  sample(vx, vz) {
    let v = this.value(vx, vz);
    if (v > -6 && v < 8) {
      const dOut = Math.max(-vx, vx - G, -vz, vz - G);
      v += fbm(this.nShore, vx * 0.09, vz * 0.09, 3) * 1.8 * sstep(1, 12, dOut);
    }
    return v;
  }

  // なだらかな丘（マップ近傍と水辺は平ら）
  height(vx, vz, v) {
    if (v > 0) return Y_BOTTOM * Math.min(1, v);
    const dOut = Math.max(-vx, vx - G, -vz, vz - G);
    if (dOut < 3 || dOut > 260 || v > -0.05) return 0;
    const hill = fbm(this.nHill, vx / 55, vz / 55, 3) + 0.12;
    if (hill <= 0) return 0;
    return hill * 15 * sstep(3, 30, dOut) * (1 - sstep(160, 260, dOut)) * sstep(0, 16, -v);
  }
}

// ---------------------------------------------------------------- shaders

const WATER_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const WATER_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform sampler2D uShore;
uniform float uShoreSize;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSpec;
uniform float uLight;
varying vec3 vWPos;

void main() {
  vec2 p = vWPos.xz;
  float t = uTime;
  float fw = length(fwidth(p));
  float aa = 1.0 - smoothstep(0.2, 1.2, fw);
  float aaLow = 1.0 - smoothstep(0.8, 4.0, fw);
  vec2 g = vec2(0.0);
  vec2 d1 = vec2(0.83, 0.56);
  vec2 d2 = vec2(-0.47, 0.88);
  vec2 d3 = vec2(0.99, -0.12);
  vec2 d4 = vec2(-0.70, -0.71);
  vec2 q = p + vec2(sin(p.y * 0.13 + t * 0.3), cos(p.x * 0.11 - t * 0.25)) * 2.5;
  g += d1 * cos(dot(q, d1) * 0.90 + t * 1.2) * 0.024 * aaLow;
  g += d2 * cos(dot(q, d2) * 1.30 + t * 1.5) * 0.020 * aaLow;
  g += d3 * cos(dot(q, d3) * 2.30 + t * 2.1) * 0.016 * aa;
  g += d4 * cos(dot(q, d4) * 3.70 + t * 2.9) * 0.012 * aa;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  // 遠景ほど平らにした法線（フレネル・照り返し用。低周波の波が市松模様に見えないように）
  vec3 Nf = normalize(vec3(-g.x * 0.4 * aa, 1.0, -g.y * 0.4 * aa));

  float shore = texture2D(uShore, p / uShoreSize + 0.5).r;
  vec3 V = normalize(cameraPosition - vWPos);
  float ndv = max(dot(Nf, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, normalize(mix(Nf, N, aa)));
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.5));
  vec3 base = mix(uDeep, uShallow, smoothstep(0.1, 0.9, shore)) * uLight;
  vec3 c = mix(base, sky, clamp(fres * 1.2 + 0.1, 0.0, 1.0));

  // 太陽/月の照り返し: 鋭いきらめきは近景だけ（遠景の低周波の波で白い市松模様にならないように）、
  // 遠景は平滑化した法線でやわらかい光の帯にし、合計を上限でクランプ
  float sp = max(dot(R, uSunDir), 0.0);
  float spF = max(dot(reflect(-V, Nf), uSunDir), 0.0);
  float sparkleAA = 1.0 - smoothstep(0.12, 0.5, fw);
  float glint = pow(sp, 220.0) * 1.2 * sparkleAA + pow(spF, 300.0) * 0.5 + pow(spF, 30.0) * 0.05;
  c += uSunColor * min(glint * uSpec, 1.6);

  float fn = sin(p.x * 1.3 + t * 0.9 + sin(p.y * 0.7)) * sin(p.y * 1.1 - t * 0.7 + sin(p.x * 0.5));
  float foam = smoothstep(0.78, 0.93, shore + fn * 0.05 * aa) * (0.55 + 0.45 * aa);
  c = mix(c, vec3(0.86, 0.9, 0.92) * max(uLight, 0.14), foam * 0.45);

  float alpha = mix(0.8, 0.96, fres);
  alpha = mix(alpha, 0.6, smoothstep(0.55, 0.95, shore) * 0.7);
  alpha = max(alpha, foam * 0.55);
  gl_FragColor = vec4(c, alpha);
  #include <fog_fragment>
}`;

function patchGroundMaterial(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDusk = uniforms.uDusk;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aGround;\nvarying vec3 vGWorld;\nvarying vec2 vGround;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGround = aGround;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDusk;
varying vec3 vGWorld;
varying vec2 vGround;
float gHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 gp = vGWorld.xz;
  float gfw = length(fwidth(gp));
  float g1 = (gNoise(gp * 0.33) - 0.5) * (1.0 - smoothstep(1.5, 5.0, gfw));
  float g2 = (gNoise(gp * 1.3 + 17.0) - 0.5) * (1.0 - smoothstep(0.3, 1.2, gfw));
  float g3 = gNoise(gp * 0.06 - 5.0) - 0.5;
  diffuseColor.rgb *= 1.0 + g1 * 0.13 + g2 * 0.1 + g3 * 0.1;

  // マップ外の田園: 生垣で区切られた畑のパッチワーク
  if (vGround.x > 0.01) {
    vec2 wq = gp + (vec2(gNoise(gp * 0.011), gNoise(gp * 0.011 + 31.0)) - 0.5) * 26.0;
    float rowH = 46.0;
    float ry = floor(wq.y / rowH);
    float fy = fract(wq.y / rowH) * rowH;
    // 一部の列は細い2本の区画に分ける（レンガ積みの規則性を崩す）
    float cut = gHash(vec2(ry, 41.0)) < 0.45 ? rowH * (0.35 + 0.3 * gHash(vec2(ry, 43.0))) : rowH;
    float sub = step(cut, fy);
    float rH = mix(cut, rowH - cut, sub);
    fy -= cut * sub;
    ry += sub * 0.5;
    float colW = 50.0 + 46.0 * gHash(vec2(ry, 17.0));
    float cx = (wq.x + gHash(vec2(ry, 5.0)) * colW) / colW;
    vec2 id = vec2(floor(cx), ry);
    vec2 lp = vec2(fract(cx) * colW, fy);
    float edge = min(min(lp.x, colW - lp.x), min(lp.y, rH - lp.y));
    float h = gHash(id * 1.37 + 0.71);
    float h2 = gHash(id * 2.11 + 4.3);
    vec3 crop = diffuseColor.rgb;
    float amt = 0.0;
    float rows = 0.0;
    if (h < 0.34) { crop *= 1.06; amt = 0.5; }
    else if (h < 0.52) { crop = vec3(0.25, 0.32, 0.05); amt = 0.62; rows = 0.5; }
    else if (h < 0.67) { crop = vec3(0.46, 0.35, 0.10); amt = 0.62; rows = 1.0; }
    else if (h < 0.79) { crop = vec3(0.20, 0.13, 0.065); amt = 0.6; rows = 1.0; }
    else { crop = vec3(0.075, 0.17, 0.03); amt = 0.55; rows = 1.0; }
    float rc = h2 < 0.5 ? lp.x : lp.y;
    crop *= 1.0 - (0.5 + 0.5 * sin(rc * 2.6)) * rows * 0.2 * (1.0 - smoothstep(0.25, 0.8, gfw));
    crop *= 0.9 + 0.2 * gNoise(gp * 0.045 + id * 7.0);
    amt *= vGround.x * mix(0.5, 1.0, 1.0 - smoothstep(8.0, 40.0, gfw));
    diffuseColor.rgb = mix(diffuseColor.rgb, crop, amt);
    float hw = 0.9 + gfw * 0.5;
    float hedge = (1.0 - smoothstep(hw * 0.4, hw, edge)) * (1.0 - smoothstep(2.0, 9.0, gfw)) * vGround.x;
    hedge *= step(0.25, gHash(id * 3.7 + 1.9));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.09, 0.035), hedge * 0.5);
  }

  // 夕方の暖色光で砂浜が蛍光オレンジに光らないよう、砂を少しくすませる
  float gl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(gl) * vec3(0.72, 0.76, 0.82), vGround.y * uDusk * 0.85);
}`,
      );
  };
}

function patchTreeMaterial(mat) {
  // 幹にはインスタンスカラーを掛けない
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCanopy;')
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3(1.0);
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor *= mix(vec3(1.0), instanceColor.rgb, aCanopy);
#endif`,
      );
  };
}

// ---------------------------------------------------------------- tree geometry

function treePart(geo, r, g, b, canopy, y0, y1) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  if (out !== geo) geo.dispose();
  out.deleteAttribute('uv');
  out.computeVertexNormals();
  const pos = out.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  const can = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ao = canopy ? 0.62 + 0.5 * clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1) : 1;
    colors[i * 3] = r * ao;
    colors[i * 3 + 1] = g * ao;
    colors[i * 3 + 2] = b * ao;
    can[i] = canopy;
  }
  out.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  out.setAttribute('aCanopy', new THREE.BufferAttribute(can, 1));
  return out;
}

function makeConifer() {
  const trunk = new THREE.CylinderGeometry(0.09, 0.14, 0.8, 5, 1, true).translate(0, 0.4, 0);
  const c1 = new THREE.ConeGeometry(0.95, 1.8, 7, 1, true).translate(0, 1.45, 0);
  const c2 = new THREE.ConeGeometry(0.68, 1.45, 7, 1, true).translate(0, 2.35, 0);
  return mergeGeometries([
    treePart(trunk, 0.16, 0.09, 0.045, 0, 0, 1),
    treePart(c1, 1, 1, 1, 1, 0.55, 3.1),
    treePart(c2, 1, 1, 1, 1, 0.55, 3.1),
  ]);
}

function makeBroadleaf() {
  const trunk = new THREE.CylinderGeometry(0.1, 0.15, 1.1, 5, 1, true).translate(0, 0.55, 0);
  const c1 = new THREE.IcosahedronGeometry(1.0, 0).scale(1, 0.88, 1).translate(0, 1.85, 0);
  const c2 = new THREE.IcosahedronGeometry(0.62, 0).translate(0.5, 1.45, 0.25);
  return mergeGeometries([
    treePart(trunk, 0.17, 0.1, 0.05, 0, 0, 1),
    treePart(c1, 1, 1, 1, 1, 0.9, 2.75),
    treePart(c2, 1, 1, 1, 1, 0.9, 2.75),
  ]);
}

function makeZoneTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y);
      const o = (y * S + x) * 4;
      let v = 255;
      let a = 88;
      if (e < 3) {
        v = 120; // 暗めの縁
        a = 215;
      } else if (e < 7) {
        a = 88 + (7 - e) * 10;
      }
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = a;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- view

export class TerrainView {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.world = city.world;
    this.seed = (Number.isFinite(city.seed) ? city.seed : 12345) >>> 0;
    this._time = 0;

    this.group = new THREE.Group();
    this.group.name = 'TerrainView';
    scene.add(this.group);

    this._noise = createNoise2D((this.seed ^ 0x9e3779b9) >>> 0);
    this._noise2 = createNoise2D((this.seed + 0x51ed27) >>> 0);
    this._groundUniforms = { uDusk: { value: 0 } };

    this._dirtyFlag = new Uint8Array(G * G);
    this._dirtyList = [];

    this._field = new OuterField(this.world, this.seed);
    this._buildOuterCells();
    this._buildGround();
    this._buildWater();
    this._buildTrees();
    this._buildZones();

    const ev = city.events;
    const mark = (p) => {
      if (p) this._mark(p.x, p.z);
    };
    const markB = (p) => {
      if (p && p.building) this._mark(p.building.x, p.building.z);
    };
    ev.on('zone:set', mark);
    ev.on('road:add', mark);
    ev.on('trees:remove', mark);
    ev.on('building:add', markB);
    ev.on('building:remove', markB);
  }

  _mark(x, z) {
    if (!this.world.inBounds(x, z)) return;
    const i = z * G + x;
    if (this._dirtyFlag[i]) return;
    this._dirtyFlag[i] = 1;
    this._dirtyList.push(i);
  }

  // マップ外セル（SHORE_EXT 幅）の水/陸と森
  _buildOuterCells() {
    const W = this.world;
    const F = this._field;
    const T = G + 2 * SHORE_EXT;
    const water = new Uint8Array(T * T);
    const trees = new Uint8Array(T * T);
    const R = TREE_RING;
    for (let tz = 0; tz < T; tz++) {
      const z = tz - SHORE_EXT;
      for (let tx = 0; tx < T; tx++) {
        const x = tx - SHORE_EXT;
        const ti = tz * T + tx;
        if (x >= 0 && z >= 0 && x < G && z < G) {
          water[ti] = W.terrain[z * G + x] === TILE.WATER ? 1 : 0;
          continue;
        }
        const v = F.sample(x + 0.5, z + 0.5);
        if (v > 1 / 3) {
          water[ti] = 1;
          continue;
        }
        const dOut = Math.max(-x - 0.5, x + 0.5 - G, -z - 0.5, z + 0.5 - G);
        if (dOut > R || v > -2.5) continue;
        let n = 0;
        // マップ内の森を端から少しだけ連続させる
        if (dOut < 7) {
          const et = W.trees[clamp(z, 0, G - 1) * G + clamp(x, 0, G - 1)];
          if (et > 0 && hash2(x, z, this.seed + 5) < 1 - dOut / 7) n = et;
        }
        const f = fbm(this._noise2, x * 0.06 + 50.3, z * 0.06 - 20.7, 3);
        const thr = 0.1 + 0.2 * sstep(6, R, dOut);
        if (f > thr) n = Math.max(n, f > thr + 0.16 ? 3 : f > thr + 0.07 ? 2 : 1);
        else if (hash2(x, z, this.seed + 3) < 0.016 * (1 - dOut / R)) n = Math.max(n, 1);
        if (dOut > R - 8 && hash2(x, z, this.seed + 9) < (dOut - (R - 8)) / 8) n = 0;
        trees[ti] = n;
      }
    }
    this._outerT = T;
    this._outerWater = water;
    this._outerTrees = trees;
  }

  // マップ外の仮想セルも含めた木の本数（初期状態）
  _cellTrees(x, z) {
    if (x >= 0 && z >= 0 && x < G && z < G) return this.world.trees[z * G + x];
    const tx = x + SHORE_EXT;
    const tz = z + SHORE_EXT;
    const T = this._outerT;
    if (tx < 0 || tz < 0 || tx >= T || tz >= T) return 0;
    return this._outerTrees[tz * T + tx];
  }

  // ------------------------------------------------------------ ground

  _buildGround() {
    const W = this.world;
    const F = this._field;
    const cornerH = new Float32Array(N1 * N1);
    const touch = new Uint8Array(N1 * N1);
    for (let vz = 0; vz <= G; vz++) {
      for (let vx = 0; vx <= G; vx++) {
        let water = 0;
        let land = 0;
        for (let dz = -1; dz <= 0; dz++) {
          for (let dx = -1; dx <= 0; dx++) {
            const cx = vx + dx;
            const cz = vz + dz;
            if (cx < 0 || cz < 0 || cx >= G || cz >= G) continue;
            if (W.terrain[cz * G + cx] === TILE.WATER) water++;
            else land++;
          }
        }
        const i = vz * N1 + vx;
        cornerH[i] = land === 0 && water > 0 ? Y_BOTTOM : 0;
        touch[i] = land > 0 && water > 0 ? 1 : 0;
      }
    }
    // 砂浜の帯（水に接する頂点 = 1、その隣 = 弱め）
    const shore = new Float32Array(N1 * N1);
    for (let vz = 0; vz <= G; vz++) {
      for (let vx = 0; vx <= G; vx++) {
        const i = vz * N1 + vx;
        if (cornerH[i] < 0) continue;
        if (touch[i]) {
          shore[i] = 1;
          continue;
        }
        let near = 0;
        for (let dz = -1; dz <= 1 && !near; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = vx + dx;
            const nz = vz + dz;
            if (nx < 0 || nz < 0 || nx > G || nz > G) continue;
            if (touch[nz * N1 + nx]) {
              near = 1;
              break;
            }
          }
        }
        shore[i] = near ? 0.16 : 0;
      }
    }

    // 外周グリッドの列（行と共通）。単位は頂点座標
    const outs = [];
    for (let k = 1; k <= OUT_FINE; k++) outs.push(k);
    for (let k = OUT_FINE + 2; k <= OUT_MID; k += 2) outs.push(k);
    for (const k of OUT_FAR) outs.push(k);
    const cols = [];
    for (let k = outs.length - 1; k >= 0; k--) cols.push(-outs[k]);
    for (let v = 0; v <= G; v++) cols.push(v);
    for (let k = 0; k < outs.length; k++) cols.push(G + outs[k]);
    const OFF = outs.length;
    const M = cols.length;
    const inner = (i) => i >= OFF && i <= OFF + G;

    const nCorner = N1 * N1;
    const nCenter = G * G;
    const nSkirt = M * M - nCorner;
    const nVert = nCorner + nCenter + nSkirt;
    const pos = new Float32Array(nVert * 3);
    const colors = new Float32Array(nVert * 3);
    const gattr = new Float32Array(nVert * 2); // (田園, 砂)

    const setV = (vi, x, y, z, color) => {
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      colors[vi * 3] = color.r;
      colors[vi * 3 + 1] = color.g;
      colors[vi * 3 + 2] = color.b;
    };
    const sandOf = (h, sh) => (h < -0.001 ? 1 - clamp((-h - 0.6) / 1.2, 0, 1) : sh);

    // corners
    for (let vz = 0; vz <= G; vz++) {
      for (let vx = 0; vx <= G; vx++) {
        const i = vz * N1 + vx;
        const forest = (this._cellTrees(vx - 1, vz - 1) + this._cellTrees(vx, vz - 1) + this._cellTrees(vx - 1, vz) + this._cellTrees(vx, vz)) / 12;
        this._groundColor(_c, vx, vz, cornerH[i], shore[i], forest, 0, false);
        setV(i, vx * CELL - HALF, cornerH[i], vz * CELL - HALF, _c);
        gattr[i * 2 + 1] = sandOf(cornerH[i], shore[i]);
      }
    }
    // cell centers
    for (let z = 0; z < G; z++) {
      for (let x = 0; x < G; x++) {
        const vi = nCorner + z * G + x;
        cellToWorld(x, z, _p);
        let h = 0;
        let sh = 0;
        if (W.terrain[z * G + x] === TILE.WATER) {
          const avg = (cornerH[z * N1 + x] + cornerH[z * N1 + x + 1] + cornerH[(z + 1) * N1 + x] + cornerH[(z + 1) * N1 + x + 1]) / 4;
          h = Math.min(avg, -1.1);
        } else {
          sh = (shore[z * N1 + x] + shore[z * N1 + x + 1] + shore[(z + 1) * N1 + x] + shore[(z + 1) * N1 + x + 1]) / 4;
        }
        this._groundColor(_c, x + 0.5, z + 0.5, h, sh, this._cellTrees(x, z) / 3, 0, false);
        setV(vi, _p.x, h, _p.z, _c);
        gattr[vi * 2 + 1] = sandOf(h, sh);
      }
    }
    // マップ外の頂点
    const skirtIdx = new Int32Array(M * M);
    const skirtH = new Float32Array(M * M);
    let next = nCorner + nCenter;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        if (inner(i) && inner(j)) {
          const k = (j - OFF) * N1 + (i - OFF);
          skirtIdx[j * M + i] = k;
          skirtH[j * M + i] = cornerH[k];
          continue;
        }
        const vx = cols[i];
        const vz = cols[j];
        const dOut = Math.max(-vx, vx - G, -vz, vz - G);
        const v = F.sample(vx, vz);
        const wet = F.wet;
        const h = F.height(vx, vz, v);
        const sh = v > 0 ? 0 : v > -1 ? 1 + 0.84 * v : v > -1.6 ? 0.16 * (1 - (-v - 1) / 0.6) : 0;
        let forest = 0;
        if (dOut <= TREE_RING + 1) {
          forest = (this._cellTrees(vx - 1, vz - 1) + this._cellTrees(vx, vz) + this._cellTrees(vx - 1, vz) + this._cellTrees(vx, vz - 1)) / 12;
        }
        this._groundColor(_c, vx, vz, h, sh, forest, wet, true);
        skirtIdx[j * M + i] = next;
        skirtH[j * M + i] = h;
        setV(next, vx * CELL - HALF, h, vz * CELL - HALF, _c);
        let rural = 0;
        if (v < -3.5 && dOut > 4) {
          const farm = fbm(F.nHill, vx / 60 + 13.1, vz / 60 - 7.7, 2) + 0.1;
          rural = sstep(4, 14, dOut) * (1 - clamp(forest * 2.2, 0, 1)) * (1 - sstep(-8, -3.5, v)) * sstep(-0.12, 0.12, farm) * (1 - wet);
        }
        gattr[next * 2] = rural;
        gattr[next * 2 + 1] = sandOf(h, sh);
        next++;
      }
    }

    // indices
    const nSkirtQuads = (M - 1) * (M - 1) - G * G;
    const index = new Uint32Array(G * G * 12 + nSkirtQuads * 6);
    let o = 0;
    for (let z = 0; z < G; z++) {
      for (let x = 0; x < G; x++) {
        const c00 = z * N1 + x;
        const c10 = c00 + 1;
        const c01 = c00 + N1;
        const c11 = c01 + 1;
        const ct = nCorner + z * G + x;
        index[o++] = c00; index[o++] = ct; index[o++] = c10;
        index[o++] = c10; index[o++] = ct; index[o++] = c11;
        index[o++] = c11; index[o++] = ct; index[o++] = c01;
        index[o++] = c01; index[o++] = ct; index[o++] = c00;
      }
    }
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < M - 1; i++) {
        if (i >= OFF && i < OFF + G && j >= OFF && j < OFF + G) continue;
        const ka = j * M + i;
        const kb = ka + 1;
        const kc = ka + M;
        const kd = kc + 1;
        const a = skirtIdx[ka];
        const b = skirtIdx[kb];
        const c = skirtIdx[kc];
        const d = skirtIdx[kd];
        // 高さの差が小さい方の対角線で分割（岸がギザギザにならないように）
        if (Math.abs(skirtH[ka] - skirtH[kd]) <= Math.abs(skirtH[kb] - skirtH[kc])) {
          index[o++] = a; index[o++] = c; index[o++] = d;
          index[o++] = a; index[o++] = d; index[o++] = b;
        } else {
          index[o++] = a; index[o++] = c; index[o++] = b;
          index[o++] = b; index[o++] = c; index[o++] = d;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aGround', new THREE.BufferAttribute(gattr, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal.array;
    for (let v = 0; v < nVert; v++) {
      if (pos[v * 3 + 1] === 0) {
        nrm[v * 3] = 0;
        nrm[v * 3 + 1] = 1;
        nrm[v * 3 + 2] = 0;
      }
    }
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchGroundMaterial(mat, this._groundUniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.group.add(mesh);
    this.ground = mesh;
  }

  _groundColor(out, vx, vz, h, shore, forest, wet, outside) {
    if (h < -0.001) {
      const d = -h;
      if (d <= 0.6) out.lerpColors(PAL.sand, PAL.wetSand, d / 0.6);
      else out.lerpColors(PAL.wetSand, PAL.deep, Math.min(1, (d - 0.6) / 1.2));
      return out;
    }
    const n1 = fbm(this._noise, vx * 0.045, vz * 0.045, 4);
    const n2 = this._noise(vx * 0.19 + 31.7, vz * 0.19 - 11.3);
    out.lerpColors(PAL.grassA, PAL.grassB, clamp(0.5 + n1 * 1.1, 0, 1));
    out.lerp(PAL.dry, clamp(n2 * 0.9 - 0.15, 0, 0.5));
    if (outside) {
      // マップ外: 大きなスケールの色むら（青々とした草地／乾いた草地）と川の消える湿地
      const n3 = fbm(this._field.nHill, vx * 0.021 + 71.3, vz * 0.021 - 33.1, 3);
      out.lerp(PAL.lush, clamp(n3 * 1.5, 0, 0.5));
      out.lerp(PAL.dry, clamp(-n3 * 1.3, 0, 0.4));
      if (wet > 0) out.lerp(PAL.marsh, wet * 0.45);
    }
    out.lerp(PAL.forest, clamp(forest, 0, 1) * 0.5);
    out.multiplyScalar(0.95 + hash2(Math.round(vx * 2), Math.round(vz * 2), 913) * 0.1);
    if (shore > 0) out.lerp(PAL.sand, shore);
    return out;
  }

  // ------------------------------------------------------------ water

  _buildWater() {
    // 岸からの距離テクスチャ（浅瀬の色と泡）。マップ外の水域も含む
    const T = this._outerT;
    const water = this._outerWater;
    const TT = T * T;
    const dist = new Uint8Array(TT).fill(255);
    const queue = new Int32Array(TT);
    let qh = 0;
    let qt = 0;
    for (let i = 0; i < TT; i++) {
      if (!water[i]) {
        dist[i] = 0;
        queue[qt++] = i;
      }
    }
    while (qh < qt) {
      const i = queue[qh++];
      const d = dist[i];
      if (d >= 5) continue;
      const x = i % T;
      const z = (i / T) | 0;
      if (x > 0 && dist[i - 1] > d + 1) { dist[i - 1] = d + 1; queue[qt++] = i - 1; }
      if (x < T - 1 && dist[i + 1] > d + 1) { dist[i + 1] = d + 1; queue[qt++] = i + 1; }
      if (z > 0 && dist[i - T] > d + 1) { dist[i - T] = d + 1; queue[qt++] = i - T; }
      if (z < T - 1 && dist[i + T] > d + 1) { dist[i + T] = d + 1; queue[qt++] = i + T; }
    }
    const LUT = [255, 190, 125, 70, 25, 0];
    const data = new Uint8Array(TT * 4);
    for (let i = 0; i < TT; i++) {
      const x = i % T;
      const z = (i / T) | 0;
      // テクスチャ外周は 0 に寄せる（クランプで浅瀬の筋が沖へ伸びないように）
      const b = Math.min(x, z, T - 1 - x, T - 1 - z);
      const v = LUT[Math.min(dist[i], 5)] * Math.min(1, b / 8);
      data[i * 4] = v;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, T, T, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this._shoreTex = tex;

    const uniforms = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      uShore: { value: tex },
      uShoreSize: { value: T * CELL },
      uDeep: { value: PAL.waterDeep.clone() },
      uShallow: { value: PAL.waterShallow.clone() },
      uZenith: { value: new THREE.Color(0x4b8fe2) },
      uHorizon: { value: new THREE.Color(0xc6dcee) },
      uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff0da) },
      uSpec: { value: 5 },
      uLight: { value: 1 },
    });
    this.waterUniforms = uniforms;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    const geo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Water';
    mesh.position.y = Y_WATER;
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;
    this.group.add(mesh);
    this.water = mesh;
  }

  _updateWater(env, dt) {
    const u = this.waterUniforms;
    u.uTime.value = this._time;
    const sky = this.scene.userData.citySky;
    if (sky) {
      u.uZenith.value.copy(sky.zenith);
      u.uHorizon.value.copy(sky.horizon);
      u.uSunDir.value.copy(sky.lightDir);
      u.uSunColor.value.copy(sky.lightColor);
      u.uSpec.value = sky.specular;
      u.uLight.value = sky.ambient;
      this._groundUniforms.uDusk.value = Number.isFinite(sky.dusk) ? sky.dusk : 0;
    } else {
      const night = env && Number.isFinite(env.night) ? env.night : 0;
      if (env && env.sunDirection) u.uSunDir.value.copy(env.sunDirection);
      u.uZenith.value.setRGB(0.07, 0.27, 0.76).lerp(_c.setRGB(0.002, 0.004, 0.012), night);
      u.uHorizon.value.setRGB(0.56, 0.72, 0.84).lerp(_c.setRGB(0.01, 0.02, 0.06), night);
      u.uSpec.value = 5 * (1 - night) + 0.8 * night;
      u.uLight.value = 1 - 0.74 * night;
    }
  }

  // ------------------------------------------------------------ trees

  _buildTrees() {
    const W = this.world;
    const F = this._field;
    const seed = this.seed;
    const nS = createNoise2D((seed + 77) >>> 0);
    // [conifer, broadleaf, 遠方 conifer, 遠方 broadleaf]: flat [key, wx, wy, wz, s, sy, rot, r, g, b]
    const lists = [[], [], [], []];
    const QX = [-1, 1, 1, -1];
    const QZ = [-1, -1, 1, 1];

    const plant = (x, z, n, cellIndex, far) => {
      cellToWorld(x, z, _p);
      const outside = cellIndex < 0;
      const coniferP = clamp(0.45 + fbm(nS, x * 0.05, z * 0.05, 3) * 1.3, 0.08, 0.92);
      const start = Math.floor(hash2(x, z, seed + 1) * 4);
      for (let k = 0; k < n; k++) {
        const h1 = hash2(x * 4 + k, z * 4 - k, seed + 11);
        const h2 = hash2(x * 4 - k, z * 4 + k, seed + 23);
        const h3 = hash2(x + k * 31, z - k * 17, seed + 37);
        const h4 = hash2(x - k * 13, z + k * 29, seed + 41);
        let ox;
        let oz;
        if (n === 1) {
          ox = (h1 - 0.5) * 1.8;
          oz = (h2 - 0.5) * 1.8;
        } else {
          const q = (start + k) % 4;
          ox = QX[q] * 0.95 + (h1 - 0.5) * 0.9;
          oz = QZ[q] * 0.95 + (h2 - 0.5) * 0.9;
        }
        const wx = _p.x + ox;
        const wz = _p.z + oz;
        let wy = 0;
        if (outside) {
          const vx = wx / CELL + G / 2;
          const vz = wz / CELL + G / 2;
          const v = F.sample(vx, vz);
          if (v > -1) continue;
          wy = F.height(vx, vz, v) - 0.08;
        }
        const conifer = h3 < coniferP;
        const s = 0.8 + h4 * 0.55;
        const sy = s * (0.9 + h1 * 0.25);
        const rot = h2 * Math.PI * 2;
        if (conifer) {
          _c.setHSL(0.29 + h1 * 0.07, 0.36 + h2 * 0.16, 0.2 + h3 * 0.09, THREE.SRGBColorSpace);
        } else if (h4 > 0.97) {
          _c.setHSL(0.12 + h1 * 0.04, 0.5 + h2 * 0.12, 0.38 + h3 * 0.08, THREE.SRGBColorSpace);
        } else {
          _c.setHSL(0.2 + h1 * 0.1, 0.4 + h2 * 0.18, 0.28 + h3 * 0.12, THREE.SRGBColorSpace);
        }
        const key = cellIndex >= 0 ? cellIndex * 3 + k : -1;
        lists[(conifer ? 0 : 1) + (far ? 2 : 0)].push(key, wx, wy, wz, s, sy, rot, _c.r, _c.g, _c.b);
      }
    };

    for (let z = 0; z < G; z++) {
      for (let x = 0; x < G; x++) {
        const i = z * G + x;
        const n = Math.min(3, W.trees[i]);
        if (n > 0 && W.terrain[i] !== TILE.WATER) plant(x, z, n, i, false);
      }
    }
    const R = TREE_RING;
    for (let z = -R; z < G + R; z++) {
      for (let x = -R; x < G + R; x++) {
        if (x >= 0 && z >= 0 && x < G && z < G) continue;
        const n = this._cellTrees(x, z);
        if (n <= 0) continue;
        const dOut = Math.max(-x, x + 1 - G, -z, z + 1 - G);
        plant(x, z, n, -1, dOut > TREE_SHADOW_RING);
      }
    }

    this._treeCellSlot = new Int32Array(G * G * 3).fill(-1);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchTreeMaterial(mat);
    const geos = [makeConifer(), makeBroadleaf()];
    this.trees = [];
    this.farTrees = [];
    for (let li = 0; li < 4; li++) {
      const mi = li & 1;
      const far = li >= 2;
      const L = lists[li];
      const count = L.length / 10;
      const cap = Math.max(1, count);
      const mesh = new THREE.InstancedMesh(geos[mi], mat, cap);
      mesh.name = (mi === 0 ? 'TreesConifer' : 'TreesBroadleaf') + (far ? 'Far' : '');
      mesh.instanceMatrix.setUsage(far ? THREE.StaticDrawUsage : THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      if (!far) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const slotKey = far ? null : new Int32Array(cap).fill(-1);
      const ma = mesh.instanceMatrix.array;
      const ca = mesh.instanceColor.array;
      for (let t = 0; t < count; t++) {
        const b = t * 10;
        _m.makeRotationY(L[b + 6]);
        _m.scale(_s.set(L[b + 4], L[b + 5], L[b + 4]));
        _m.setPosition(L[b + 1], L[b + 2], L[b + 3]);
        _m.toArray(ma, t * 16);
        ca[t * 3] = L[b + 7];
        ca[t * 3 + 1] = L[b + 8];
        ca[t * 3 + 2] = L[b + 9];
        if (far) continue;
        const key = L[b];
        slotKey[t] = key;
        if (key >= 0) this._treeCellSlot[key] = (t << 1) | mi;
      }
      mesh.count = count;
      mesh.castShadow = !far;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      if (far) this.farTrees.push(mesh);
      else this.trees.push({ mesh, slotKey, dirty: false });
    }
  }

  // セルの木を world.trees[i] 本まで減らす（swap-remove）
  _syncTrees(i) {
    const cs = this._treeCellSlot;
    const b = i * 3;
    let have = (cs[b] >= 0) + (cs[b + 1] >= 0) + (cs[b + 2] >= 0);
    const want = this.world.trees[i];
    for (let k = 2; k >= 0 && have > want; k--) {
      const key = b + k;
      const enc = cs[key];
      if (enc < 0) continue;
      have--;
      cs[key] = -1;
      const mi = enc & 1;
      const s = enc >> 1;
      const tr = this.trees[mi];
      const mesh = tr.mesh;
      const last = mesh.count - 1;
      if (s !== last) {
        const ma = mesh.instanceMatrix.array;
        const ca = mesh.instanceColor.array;
        ma.copyWithin(s * 16, last * 16, last * 16 + 16);
        ca.copyWithin(s * 3, last * 3, last * 3 + 3);
        const moved = tr.slotKey[last];
        tr.slotKey[s] = moved;
        if (moved >= 0) cs[moved] = (s << 1) | mi;
      }
      tr.slotKey[last] = -1;
      mesh.count = last;
      tr.dirty = true;
    }
  }

  // ------------------------------------------------------------ zone overlays

  _buildZones() {
    this._zoneGeo = new THREE.PlaneGeometry(CELL * 0.96, CELL * 0.96).rotateX(-Math.PI / 2);
    this._zoneMat = new THREE.MeshLambertMaterial({
      map: makeZoneTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this._zoneColors = {};
    for (const z of [ZONE.RES, ZONE.COM, ZONE.IND, ZONE.PARK]) this._zoneColors[z] = new THREE.Color(ZONE_COLORS[z]);
    this._zoneSlot = new Int32Array(G * G).fill(-1);
    this._zoneSlotCell = new Int32Array(0);
    this._zoneCap = 0;
    this.zoneMesh = null;
    this._zoneDirty = false;
    this._zoneEnsure(2048);

    const W = this.world;
    for (let i = 0; i < G * G; i++) {
      if (W.zone[i] !== ZONE.NONE) {
        this._dirtyFlag[i] = 1;
        this._dirtyList.push(i);
      }
    }
    this._flushCells();
  }

  _zoneEnsure(n) {
    if (n <= this._zoneCap) return;
    let cap = Math.max(2048, this._zoneCap);
    while (cap < n) cap *= 2;
    const old = this.zoneMesh;
    const mesh = new THREE.InstancedMesh(this._zoneGeo, this._zoneMat, cap);
    mesh.name = 'ZoneOverlay';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const slotCell = new Int32Array(cap).fill(-1);
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, old.count * 16));
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, old.count * 3));
      slotCell.set(this._zoneSlotCell.subarray(0, old.count));
      mesh.count = old.count;
      this.group.remove(old);
      old.dispose();
    } else {
      mesh.count = 0;
    }
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.zoneMesh = mesh;
    this._zoneSlotCell = slotCell;
    this._zoneCap = cap;
  }

  _flushCells() {
    const W = this.world;
    const list = this._dirtyList;
    for (let n = 0; n < list.length; n++) {
      const i = list[n];
      this._dirtyFlag[i] = 0;
      this._syncTrees(i);

      const zone = W.zone[i];
      const color = this._zoneColors[zone];
      const show = !!color && W.terrain[i] === TILE.LAND && W.road[i] === ROAD.NONE && W.building[i] === -1;
      let slot = this._zoneSlot[i];
      if (show) {
        if (slot < 0) {
          this._zoneEnsure(this.zoneMesh.count + 1);
          const mesh = this.zoneMesh;
          slot = mesh.count++;
          this._zoneSlot[i] = slot;
          this._zoneSlotCell[slot] = i;
          cellToWorld(i % G, (i / G) | 0, _p);
          _m.makeTranslation(_p.x, Y_ZONE, _p.z).toArray(mesh.instanceMatrix.array, slot * 16);
        }
        const ca = this.zoneMesh.instanceColor.array;
        ca[slot * 3] = color.r;
        ca[slot * 3 + 1] = color.g;
        ca[slot * 3 + 2] = color.b;
        this._zoneDirty = true;
      } else if (slot >= 0) {
        const mesh = this.zoneMesh;
        const last = mesh.count - 1;
        if (slot !== last) {
          mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
          mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
          const moved = this._zoneSlotCell[last];
          this._zoneSlotCell[slot] = moved;
          this._zoneSlot[moved] = slot;
        }
        this._zoneSlotCell[last] = -1;
        this._zoneSlot[i] = -1;
        mesh.count = last;
        this._zoneDirty = true;
      }
    }
    list.length = 0;
  }

  // ------------------------------------------------------------ frame

  update(env) {
    const dt = env && Number.isFinite(env.dt) ? env.dt : 1 / 60;
    this._time += dt;

    if (this._dirtyList.length) this._flushCells();

    if (this._zoneDirty) {
      this._zoneDirty = false;
      this.zoneMesh.instanceMatrix.needsUpdate = true;
      this.zoneMesh.instanceColor.needsUpdate = true;
    }
    for (const tr of this.trees) {
      if (!tr.dirty) continue;
      tr.dirty = false;
      tr.mesh.instanceMatrix.needsUpdate = true;
      tr.mesh.instanceColor.needsUpdate = true;
    }

    this._updateWater(env, dt);
  }
}
