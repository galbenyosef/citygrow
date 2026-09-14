import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG, clamp } from '../config.js';

const HALF = (CONFIG.GRID * CONFIG.CELL) / 2;
const TAU = Math.PI * 2;
const SHADOW_SIZE = 4096;
const SHADOW_FADE = 0.78; // 影カメラの端 22% で影をフェードアウト（下のチャンクパッチと一致させる）
const SHADOW_CASTER_H = 140; // 影を落とす物体の最大高さ（塔 + アンテナ）
const LOG_STEP = Math.log(1.08);
const UP = new THREE.Vector3(0, 1, 0);

// 影の範囲の端でくっきり切れないよう、directional/spot の getShadow() に端フェードを入れる。
// （全マテリアルの初回コンパイル前＝このモジュール評価時に一度だけ）
{
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const ret = 'return mix( 1.0, shadow, shadowIntensity );';
  if (chunk.includes(ret) && !chunk.includes('cityShadowKeep')) {
    // 引きの画（影テクセルが画面ピクセルより細かい）では PCFSoft の 16 タップを 2x2 バイリニアに落とす。
    // PCF_SOFT では未使用の shadow.radius をスイッチに使う（< 0.5 で軽量版）
    let c = chunk;
    const a = c.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )');
    const b = c.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )', a);
    if (a >= 0 && b > a) {
      const head = '#elif defined( SHADOWMAP_TYPE_PCF_SOFT )';
      const body = c.slice(a + head.length, b);
      c =
        c.slice(0, a) +
        head +
        `
			if ( shadowRadius < 0.5 ) {
				vec2 cityTexel = vec2( 1.0 ) / shadowMapSize;
				vec2 cityF = fract( shadowCoord.xy * shadowMapSize + 0.5 );
				vec2 cityUv = shadowCoord.xy - cityF * cityTexel;
				shadow = mix(
					mix( texture2DCompare( shadowMap, cityUv, shadowCoord.z ), texture2DCompare( shadowMap, cityUv + vec2( cityTexel.x, 0.0 ), shadowCoord.z ), cityF.x ),
					mix( texture2DCompare( shadowMap, cityUv + vec2( 0.0, cityTexel.y ), shadowCoord.z ), texture2DCompare( shadowMap, cityUv + cityTexel, shadowCoord.z ), cityF.x ),
					cityF.y );
			} else {` +
        body +
        `			}
		` +
        c.slice(b);
    }
    THREE.ShaderChunk.shadowmap_pars_fragment = c.replace(
      ret,
      `vec2 cityShadowEdge = smoothstep( vec2( ${SHADOW_FADE.toFixed(3)} ), vec2( 0.985 ), abs( shadowCoord.xy * 2.0 - 1.0 ) );
		float cityShadowKeep = ( 1.0 - cityShadowEdge.x ) * ( 1.0 - cityShadowEdge.y );
		return mix( 1.0, shadow, shadowIntensity * cityShadowKeep );`,
    );
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _sph = new THREE.Spherical();

function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const damp = (dt, rate) => 1 - Math.exp(-rate * dt);
const col = (hex) => new THREE.Color(hex);

function mix3(out, a, b, c, wa, wb, wc) {
  return out.setRGB(a.r * wa + b.r * wb + c.r * wc, a.g * wa + b.g * wb + c.g * wc, a.b * wa + b.b * wb + c.b * wc);
}

// 時間帯ごとのパレット（sRGB hex → リニア）
const PAL = {
  day: {
    zenith: col(0x4b8fe2), horizon: col(0xc6dcee), hemiSky: col(0xd6e6ff), hemiGround: col(0x857a58),
    light: col(0xfff0da), hemiI: 1.25, lightI: 2.9, ambient: 1.0, glow: 0.3,
  },
  dusk: {
    zenith: col(0x3a4c8a), horizon: col(0xeeab88), hemiSky: col(0xe2c0b0), hemiGround: col(0x5a4b47),
    light: col(0xffae78), hemiI: 1.0, lightI: 2.1, ambient: 0.62, glow: 1.5,
  },
  night: {
    zenith: col(0x050b1d), horizon: col(0x1a2748), hemiSky: col(0x6a82c2), hemiGround: col(0x232a3e),
    light: col(0xa4bbff), hemiI: 0.95, lightI: 0.75, ambient: 0.26, glow: 0.0,
  },
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
  gl_Position.z = p.w * 0.99999;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uGlow;
uniform float uDisc;
uniform float uMoon;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float t = clamp(y, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(t, 0.5));
  c = mix(uGround, c, smoothstep(-0.06, 0.0, y));
  float above = smoothstep(-0.03, 0.04, y);

  float sd = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (pow(sd, 5.0) * 0.28 + pow(sd, 40.0) * 0.55) * uGlow * above * (1.0 - 0.7 * t);
  c += uSunColor * smoothstep(0.99935, 0.9997, sd) * uDisc * above;

  float md = max(dot(d, uMoonDir), 0.0);
  c += vec3(0.82, 0.88, 1.0) * (smoothstep(0.99950, 0.99978, md) * 1.4 + pow(md, 600.0) * 0.35 + pow(md, 16.0) * 0.035) * uMoon * above;

  if (uStars > 0.001 && y > 0.0) {
    vec3 sp = d * 170.0;
    vec3 cell = floor(sp);
    float h = hash13(cell);
    if (h > 0.975) {
      vec3 j = hash33(cell) * 0.6 + 0.2;
      float r = length(fract(sp) - j);
      float tw = 0.6 + 0.4 * sin(uTime * (1.3 + h * 3.0) + h * 91.0);
      float b = 0.35 + (h - 0.975) * 50.0;
      c += vec3(0.86, 0.9, 1.0) * smoothstep(0.16, 0.0, r) * tw * b * uStars * smoothstep(0.03, 0.3, y);
    }
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export class Stage {
  constructor(container) {
    this.container = container || document.body;
    this.onUserCamera = null;
    this._cinematic = true;
    this._time = 0;
    this._size = { w: 0, h: 0, pr: 0 };
    // 影マップの更新間隔（フレーム）。太陽が速く動く時・カメラが大きく跳んだ時は毎フレーム
    this.shadowInterval = 2;
    this._shadowAge = 1e9;
    this._shadowBox = { l: 0, r: 0, t: 0, b: 0, n: 0, f: 0 };

    // renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // scene / camera
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(PAL.day.horizon.clone(), 400, 1500);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / Math.max(1, window.innerHeight), 0.5, 3000);
    camera.position.setFromSphericalCoords(120, Math.PI * 0.305, 0.6);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    // lights
    this.hemi = new THREE.HemisphereLight(PAL.day.hemiSky.clone(), PAL.day.hemiGround.clone(), PAL.day.hemiI);
    scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xffffff, PAL.day.lightI);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    sun.shadow.bias = -0.00012;
    sun.shadow.normalBias = 0.05;
    sun.shadow.autoUpdate = false; // _updateShadow が needsUpdate を立てる
    scene.add(sun, sun.target);
    this.sun = sun;

    // sky dome (camera-following, always behind everything)
    this.skyUniforms = {
      uZenith: { value: PAL.day.zenith.clone() },
      uHorizon: { value: PAL.day.horizon.clone() },
      uGround: { value: PAL.day.horizon.clone() },
      uSunColor: { value: PAL.day.light.clone() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uGlow: { value: 0.3 },
      uDisc: { value: 4.0 },
      uMoon: { value: 0 },
      uStars: { value: 0 },
      uTime: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.name = 'SkyDome';
    scene.add(sky);
    this.sky = sky;

    // 他のビュー（水面）と共有する空の状態
    this._skyState = {
      zenith: this.skyUniforms.uZenith.value,
      horizon: this.skyUniforms.uHorizon.value,
      lightColor: new THREE.Color(),
      lightDir: new THREE.Vector3(0, 1, 0),
      specular: 1,
      ambient: 1,
      night: 0,
      dusk: 0,
    };
    scene.userData.citySky = this._skyState;

    // controls
    const controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.minDistance = 25;
    controls.maxDistance = 900;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.45;
    controls.zoomToCursor = true;
    controls.zoomSpeed = 1.2;
    controls.rotateSpeed = 0.6;
    controls.target.set(0, 0, 0);
    controls.listenToKeyEvents(window);
    controls.update();
    this.controls = controls;

    // post-processing: RenderPass(linear HDR) → Bloom → OutputPass(tone map + sRGB)
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(window.innerWidth * pr, window.innerHeight * pr, {
      type: THREE.HalfFloatType,
      samples: pr > 1.5 ? 2 : 4,
    });
    rt.texture.name = 'Stage.rt';
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.12, 0.3, 1.5);
    const bloomSetSize = this.bloomPass.setSize.bind(this.bloomPass);
    this.bloomPass.setSize = (w, h) => {
      const s = w > 1600 ? 0.5 : 1; // 高解像度ではブルームを縮小バッファで
      bloomSetSize(Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s)));
    };
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);

    this._lighting = { night: 0, daylight: 1, sunDirection: new THREE.Vector3(0, 1, 0) };
    this._sunRaw = new THREE.Vector3();
    this._moonRaw = new THREE.Vector3();
    this._shadowCenter = new THREE.Vector3();
    this._shadowDir = new THREE.Vector3(0, -1, 0); // 最後に影マップを描いた時の光の向き
    this._shadowTarget = new THREE.Vector3(); // 同じく注視点

    // user interaction → cinematic off
    const onUser = () => this._userInteract();
    renderer.domElement.addEventListener('pointerdown', onUser);
    renderer.domElement.addEventListener('wheel', onUser, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.key && e.key.startsWith('Arrow')) onUser();
    });

    // 動的解像度: 重い環境（高 DPR + 後半の1万棟）では pixel ratio を段階的に下げる。
    // 解像度が行ったり来たりしないよう、下げる方向のみ（最低 1.0）
    this._prCap = 2;
    this._perf = { last: -1, start: -1, acc: 0, frames: 0, slow: 0 };

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  _adaptResolution() {
    const p = this._perf;
    const now = performance.now();
    if (p.last < 0) {
      p.last = p.start = now;
      return;
    }
    const ms = now - p.last;
    p.last = now;
    // 起動直後（シェーダのコンパイル等）とタブ復帰直後の長いフレームは無視
    if (now - p.start < 8000 || ms > 250) {
      p.acc = 0;
      p.frames = 0;
      return;
    }
    p.acc += ms;
    p.frames++;
    if (p.acc < 2500) return;
    const fps = (p.frames * 1000) / p.acc;
    p.acc = 0;
    p.frames = 0;
    p.slow = fps < 48 ? p.slow + 1 : 0;
    const pr = this._size.pr;
    if (p.slow >= 2 && pr > 1) {
      p.slow = 0;
      this._prCap = Math.max(1, pr - 0.25);
      this._onResize();
    }
  }

  get cinematic() {
    return this._cinematic;
  }

  set cinematic(v) {
    this._cinematic = !!v;
  }

  _userInteract() {
    if (!this._cinematic) return;
    this._cinematic = false;
    if (typeof this.onUserCamera === 'function') this.onUserCamera();
  }

  _onResize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 2, this._prCap);
    const s = this._size;
    if (s.w === w && s.h === h && s.pr === pr) return;
    s.w = w;
    s.h = h;
    s.pr = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  update(dt, opts = {}) {
    dt = Math.max(0, dt || 0);
    this._time += dt;
    this._adaptResolution();
    const tod = Number.isFinite(opts.timeOfDay) ? opts.timeOfDay : 0.5;
    this._updateLighting(tod);
    const dist = this._updateCamera(dt, opts.focus, opts.focusRadius);
    this._updateRanges(dist);
    this._updateShadow(dist);
    this.sky.position.copy(this.camera.position);
    this.skyUniforms.uTime.value = this._time;
    return this._lighting;
  }

  _updateLighting(tod) {
    const ang = (tod - 0.25) * TAU;
    const e = Math.sin(ang); // 太陽高度 (-1..1)
    const sunRaw = this._sunRaw.set(Math.cos(ang), e * 0.9, 0.38).normalize();
    const moonRaw = this._moonRaw.set(-Math.cos(ang) * 0.8, -e * 0.85, 0.3).normalize();

    const wDay = smooth(0.0, 0.35, e);
    const wNight = 1 - smooth(-0.28, -0.02, e);
    const wDusk = Math.max(0, 1 - wDay - wNight);
    const { day, dusk, night: nt } = PAL;

    const night = 1 - smooth(-0.3, 0.05, e);
    const daylight = smooth(-0.08, 0.3, e);

    // sky + fog
    const u = this.skyUniforms;
    mix3(u.uZenith.value, day.zenith, dusk.zenith, nt.zenith, wDay, wDusk, wNight);
    mix3(u.uHorizon.value, day.horizon, dusk.horizon, nt.horizon, wDay, wDusk, wNight);
    u.uGround.value.copy(u.uHorizon.value);
    this.scene.fog.color.copy(u.uHorizon.value);

    // sun glow color (dusk tinted)
    const sw = wDay + wDusk || 1;
    u.uSunColor.value.lerpColors(dusk.light, day.light, wDay / sw);
    u.uSunDir.value.copy(sunRaw);
    u.uMoonDir.value.copy(moonRaw);
    u.uGlow.value = day.glow * wDay + dusk.glow * wDusk;
    u.uDisc.value = 5.0 * smooth(-0.06, 0.02, e);
    u.uMoon.value = smooth(0.25, 0.8, night);
    u.uStars.value = smooth(0.4, 1.0, night);

    // hemisphere
    mix3(this.hemi.color, day.hemiSky, dusk.hemiSky, nt.hemiSky, wDay, wDusk, wNight);
    mix3(this.hemi.groundColor, day.hemiGround, dusk.hemiGround, nt.hemiGround, wDay, wDusk, wNight);
    this.hemi.intensity = day.hemiI * wDay + dusk.hemiI * wDusk + nt.hemiI * wNight;

    // directional: sun by day, moon by night (crossfade through zero at the horizon)
    const isDay = e >= 0;
    const lightDir = this._skyState.lightDir.copy(isDay ? sunRaw : moonRaw);
    if (lightDir.y < 0.28) {
      lightDir.y = 0.28;
      lightDir.normalize();
    }
    const sun = this.sun;
    if (isDay) {
      sun.color.lerpColors(dusk.light, day.light, smooth(0.05, 0.4, e));
      sun.intensity = smooth(0.0, 0.18, e) * (dusk.lightI + (day.lightI - dusk.lightI) * smooth(0.1, 0.5, e));
    } else {
      sun.color.copy(nt.light);
      sun.intensity = smooth(0.0, 0.22, -e) * nt.lightI;
    }

    // exposure + bloom
    this.renderer.toneMappingExposure = 0.98 + 0.18 * night;
    const bp = this.bloomPass;
    bp.strength = 0.12 + 0.06 * wDusk + 0.28 * night;
    bp.threshold = 1.5 - 0.55 * night;
    bp.radius = 0.3 + 0.05 * night;

    const st = this._skyState;
    st.lightColor.copy(sun.color);
    st.specular = sun.intensity * (isDay ? 2.0 : 1.4);
    st.ambient = day.ambient * wDay + dusk.ambient * wDusk + nt.ambient * wNight;
    st.night = night;
    st.dusk = wDusk;

    const L = this._lighting;
    L.night = night;
    L.daylight = daylight;
    L.sunDirection.copy(lightDir);
  }

  _updateCamera(dt, focus, focusRadius) {
    const cam = this.camera;
    const controls = this.controls;
    const target = controls.target;

    if (this._cinematic) {
      _v1.copy(cam.position).sub(target);
      _sph.setFromVector3(_v1);
      if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.z)) {
        const k = damp(dt, 0.7);
        target.x += (clamp(focus.x, -HALF, HALF) - target.x) * k;
        target.z += (clamp(focus.z, -HALF, HALF) - target.z) * k;
      }
      target.y += (0 - target.y) * damp(dt, 2);
      const fr = Number.isFinite(focusRadius) ? focusRadius : 40;
      // 引きすぎると夜景の窓明かりが潰れるので上限は控えめに
      const wantR = clamp(fr * 2.4, 70, 520);
      _sph.radius += (wantR - _sph.radius) * damp(dt, 0.4);
      const wantPhi = Math.PI * 0.305 + Math.sin(this._time * 0.06) * 0.035;
      _sph.phi += (wantPhi - _sph.phi) * damp(dt, 0.6);
      _sph.theta += 0.04 * dt;
      _sph.radius = clamp(_sph.radius, controls.minDistance, controls.maxDistance);
      _sph.phi = clamp(_sph.phi, controls.minPolarAngle, controls.maxPolarAngle);
      _sph.makeSafe();
      cam.position.setFromSpherical(_sph).add(target);
      cam.lookAt(target);
    } else {
      controls.update();
    }

    // keep the target inside the map
    const cx = clamp(target.x, -HALF, HALF);
    const cz = clamp(target.z, -HALF, HALF);
    const dx = cx - target.x;
    const dz = cz - target.z;
    if (dx !== 0 || dz !== 0) {
      target.x = cx;
      target.z = cz;
      cam.position.x += dx;
      cam.position.z += dz;
    }
    return cam.position.distanceTo(target);
  }

  _updateRanges(dist) {
    const fog = this.scene.fog;
    fog.near = 220 + dist * 0.9;
    fog.far = Math.min(950 + dist * 2.4, 3200);
    const cam = this.camera;
    const near = clamp(dist * 0.012, 0.3, 10);
    const far = fog.far + 400;
    if (Math.abs(cam.near - near) > 1e-4 || Math.abs(cam.far - far) > 1e-2) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  _updateShadow(dist) {
    const sun = this.sun;
    const f = this._skyState.lightDir; // 光源方向（y >= 0.28）
    const target = this.controls.target;
    const raw = clamp(dist * 1.05, 40, 900);
    const R = 40 * Math.pow(1.08, Math.round(Math.log(raw / 40) / LOG_STEP)); // 地面上のカバー半径

    // 影マップの描画は間引く（前回の影行列と影マップは整合したまま残るので、ずれは出ない）。
    // 太陽が速く動く（高速再生・昼夜の切替）かカメラが大きく跳んだら毎フレーム描く
    this._shadowAge++;
    const turn = 1 - f.dot(this._shadowDir);
    const jump = target.distanceToSquared(this._shadowTarget) > R * R * 0.04;
    const interval = this.shadowInterval + (dist > 380 && this.shadowInterval > 1 ? 1 : 0); // 引きの画では車も建設中の建物も数px
    if (this._shadowAge < interval && turn < 5e-6 && !jump) return;
    this._shadowAge = 0;
    this._shadowDir.copy(f);
    this._shadowTarget.copy(target);
    sun.shadow.needsUpdate = true;

    // 光源空間の基底: right（水平）, up, f
    _right.crossVectors(UP, f);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(f, _right);
    const fy = Math.max(f.y, 0.05);
    const fh = Math.sqrt(Math.max(0, 1 - fy * fy));

    // 視線方向に少し寄せた地面上の中心
    const c = this._shadowCenter.copy(target);
    this.camera.getWorldDirection(_v1);
    _v1.y = 0;
    if (_v1.lengthSq() > 1e-6) c.addScaledVector(_v1.normalize(), R * 0.3);
    c.y = 0;
    const cr = c.dot(_right);
    const cu = c.dot(_up);
    const cd = c.dot(f);

    // 地面の半径 R の範囲 + 建物の壁面（高さ方向は光源空間の up 側に伸びる）
    const wallH = Math.min(110, R);
    let r0 = cr - R;
    let r1 = cr + R;
    let u0 = cu - R * fy;
    let u1 = cu + R * fy + wallH * fh;

    // マップ（+フェード帯）の外側は描いても無駄なので切り詰める → 引きの画でも解像度を保つ
    const mx = HALF + 12;
    const er = mx * (Math.abs(_right.x) + Math.abs(_right.z));
    const eu = mx * (Math.abs(_up.x) + Math.abs(_up.z));
    const k = 1 / SHADOW_FADE;
    r0 = Math.max(r0, -er * k);
    r1 = Math.min(r1, er * k);
    const um = wallH * fh * 0.5;
    u0 = Math.max(u0, um - (eu + um) * k);
    u1 = Math.min(u1, um + (eu + um) * k);
    if (r1 - r0 < 20) {
      const m = (r0 + r1) / 2;
      r0 = m - 10;
      r1 = m + 10;
    }
    if (u1 - u0 < 20) {
      const m = (u0 + u1) / 2;
      u0 = m - 10;
      u1 = m + 10;
    }

    // 半幅は段階的に（毎フレームの伸縮でちらつかないように）、中心はテクセル単位でスナップ
    const q = (h) => 10 * Math.pow(1.08, Math.ceil(Math.log(Math.max(h, 10) / 10) / LOG_STEP - 1e-6));
    const hx = q((r1 - r0) / 2);
    const hy = q((u1 - u0) / 2);
    const tx = (2 * hx) / SHADOW_SIZE;
    const ty = (2 * hy) / SHADOW_SIZE;
    const mr = Math.round((r0 + r1) / 2 / tx) * tx;
    const mu = Math.round((u0 + u1) / 2 / ty) * ty;

    // 奥行き: 箱の中の地面〜高さ SHADOW_CASTER_H までを包む。D = p·f = (y - U·fh) / fy
    const pad = 20;
    const dMax = (SHADOW_CASTER_H - (mu - hy) * fh) / fy + pad;
    const dMin = (-2 - (mu + hy) * fh) / fy - pad;
    const lightDist = dMax - cd;
    const depth = dMax - dMin;

    const sc = sun.shadow.camera;
    const box = this._shadowBox;
    const near = 1;
    const far = depth + near;
    if (box.l !== -hx || box.t !== hy || Math.abs(box.f - far) > 0.5) {
      box.l = -hx;
      box.t = hy;
      box.f = far;
      sc.left = -hx;
      sc.right = hx;
      sc.top = hy;
      sc.bottom = -hy;
      sc.near = near;
      sc.far = far;
      sc.updateProjectionMatrix();
    }
    const texel = (2 * Math.max(hx, hy)) / SHADOW_SIZE;
    sun.shadow.normalBias = texel * 0.9;
    sun.shadow.bias = -(0.04 + texel * 0.45) / (far - near);
    // 影テクセルが画面ピクセル程度以下なら 16 タップの PCFSoft と見分けがつかないので軽量フィルタ（ヒステリシス付き）
    const cam = this.camera;
    const px = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, this._size.h * this._size.pr);
    const ratio = (2 * hx) / SHADOW_SIZE / px;
    if (ratio < 1.6) sun.shadow.radius = 0;
    else if (ratio > 1.9) sun.shadow.radius = 1;

    _v2.copy(_right).multiplyScalar(mr).addScaledVector(_up, mu).addScaledVector(f, cd);
    sun.target.position.copy(_v2);
    sun.position.copy(_v2).addScaledVector(f, lightDist + near);
  }

  render() {
    this.composer.render();
  }
}
