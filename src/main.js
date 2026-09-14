import * as THREE from 'three';
import { CONFIG, cellToWorld, clamp } from './config.js';
import { City } from './sim/city.js';
import { Stage } from './render/stage.js';
import { TerrainView } from './render/terrain.js';
import { RoadView } from './render/roads.js';
import { BuildingView } from './render/buildings.js';
import { TrafficView } from './render/traffic.js';
import { Hud } from './ui/hud.js';

let stopped = false;
let leaving = false; // ページを離れる途中（GPU 解放済み）
let activeStage = null;

function errorText(err) {
  if (!err || typeof err !== 'object') return String(err);
  const head = err.name ? `${err.name}: ${err.message}` : String(err);
  if (!err.stack) return head;
  // Safari の stack にはメッセージが含まれない
  return err.message && err.stack.includes(err.message) ? err.stack : `${head}\n${err.stack}`;
}

function showFatal(err) {
  if (leaving) return;
  stopped = true;
  const el = document.getElementById('fatal');
  if (!el) return;
  el.hidden = false;
  el.textContent = `エラーが発生しました\n\n${errorText(err)}`;
  console.error(err);
}

// 致命的ではない案内（コンテキストロストからの復帰待ちなど）。null で閉じる
function setNotice(text) {
  const el = document.getElementById('fatal');
  if (!el) return;
  el.hidden = !text;
  if (text) el.textContent = text;
}

// 旧ページが大きな GPU バッファを抱えたまま次のページがコンテキストを作ると、
// GPU メモリ不足でコンテキストが失われることがある。ページを離れる時は描画を止めて先に解放する
function releaseGpu() {
  if (leaving) return;
  leaving = true;
  stopped = true;
  try {
    activeStage?.release();
  } catch (err) {
    console.warn(err);
  }
}

window.addEventListener('error', (e) => {
  // three.js の復帰処理中に再びコンテキストが失われた場合などは、復帰を待つ
  if (activeStage?.contextLost) {
    console.warn('Error while WebGL context is lost:', e.error || e.message);
    return;
  }
  showFatal(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));
window.addEventListener('pagehide', releaseGpu);
// GPU を解放したページが「戻る」で bfcache から復元されたら読み込み直す
window.addEventListener('pageshow', (e) => {
  if (e.persisted && leaving) location.reload();
});

function readSeed() {
  const raw = new URLSearchParams(location.search).get('seed');
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >>> 0 : (Math.random() * 1e9) >>> 0;
}

function main() {
  const seed = readSeed();
  const city = new City({ seed });
  const stage = new Stage(document.getElementById('app'));
  activeStage = stage;
  const views = [
    new TerrainView(stage.scene, city),
    new RoadView(stage.scene, city),
    new BuildingView(stage.scene, city),
    new TrafficView(stage.scene, city),
  ];

  const ui = { speedIndex: 1, cinematic: true, dayCycle: true, timeOfDay: 0.3, seed, fps: 60 };

  const hud = new Hud(document.getElementById('hud'), {
    onSpeed: (i) => {
      ui.speedIndex = clamp(i | 0, 0, CONFIG.SPEEDS.length - 1);
    },
    onToggleCinematic: () => {
      ui.cinematic = !ui.cinematic;
      stage.cinematic = ui.cinematic;
    },
    onToggleDayCycle: () => {
      ui.dayCycle = !ui.dayCycle;
    },
    onNewCity: () => {
      if (leaving) return;
      const url = new URL(location.href);
      url.searchParams.set('seed', String((Math.random() * 1e9) >>> 0));
      releaseGpu();
      location.assign(url.toString());
      // 読み込みが中断された場合は、描画を止めたままなので案内を出す
      setTimeout(() => setNotice('新しい街を読み込めませんでした\n\nページを再読み込みしてください。'), 10000);
    },
  });

  stage.cinematic = ui.cinematic;
  stage.onUserCamera = () => {
    ui.cinematic = false;
  };

  let lostTimer = 0;
  stage.onContextLost = () => {
    hud.log('描画が一時停止しました（GPU のリソース不足）。復帰を待っています…', 'info');
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      if (stage.contextLost && !stopped) {
        setNotice(
          '描画を再開できませんでした\n\nGPU のリソースが不足している可能性があります。\n他のタブを閉じてから、ページを再読み込みしてください。',
        );
      }
    }, 6000);
  };
  stage.onContextRestored = () => {
    clearTimeout(lostTimer);
    if (!stopped) setNotice(null);
    hud.log('描画が復帰しました', 'info');
  };
  city.events.on('log', ({ text, kind }) => hud.log(text, kind));
  city.start();

  window.__city = city;
  window.__stage = stage;

  const env = {
    dt: 0,
    simDt: 0,
    speed: 1,
    timeOfDay: ui.timeOfDay,
    night: 0,
    daylight: 1,
    sunDirection: new THREE.Vector3(0, 1, 0),
    camera: stage.camera,
  };
  const focus = { x: 0, z: 0 };
  const clock = new THREE.Clock();

  function frame() {
    if (stopped) return;
    const dt = Math.min(clock.getDelta(), 0.1);

    // コンテキストロスト中は描画できないので街の更新も止める（GPU への更新が溜まり続けないように）。HUD だけ動かす
    if (stage.contextLost) {
      try {
        hud.update(city.stats, ui);
      } catch (err) {
        showFatal(err);
        return;
      }
      requestAnimationFrame(frame);
      return;
    }

    try {
      const speed = CONFIG.SPEEDS[ui.speedIndex];
      const simDt = dt * speed;

      city.update(simDt);

      if (ui.dayCycle) {
        ui.timeOfDay = (ui.timeOfDay + simDt / CONFIG.DAY_LENGTH) % 1;
      } else {
        ui.timeOfDay += (0.42 - ui.timeOfDay) * Math.min(1, dt * 1.5);
      }

      const stats = city.stats;
      cellToWorld(stats.center.x, stats.center.z, focus);
      const lighting = stage.update(dt, {
        timeOfDay: ui.timeOfDay,
        focus,
        focusRadius: stats.radius * CONFIG.CELL,
      });

      env.dt = dt;
      env.simDt = simDt;
      env.speed = speed;
      env.timeOfDay = ui.timeOfDay;
      env.night = lighting.night;
      env.daylight = lighting.daylight;
      env.sunDirection.copy(lighting.sunDirection);
      env.camera = stage.camera;
      for (const view of views) view.update(env);

      if (dt > 0) ui.fps += (1 / dt - ui.fps) * 0.05;
      ui.cinematic = stage.cinematic;
      hud.update(stats, ui);
    } catch (err) {
      showFatal(err);
      return;
    }

    try {
      stage.render();
    } catch (err) {
      // フレームの途中でコンテキストが失われると three.js 内部で例外になる。致命的扱いせず復帰を待つ
      if (!stage.contextLost) {
        showFatal(err);
        return;
      }
      console.warn('WebGL context lost during frame:', err);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

try {
  main();
} catch (err) {
  showFatal(err);
}
