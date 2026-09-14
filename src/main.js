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

function showFatal(err) {
  stopped = true;
  const el = document.getElementById('fatal');
  if (!el) return;
  el.hidden = false;
  el.textContent = `エラーが発生しました\n\n${err && err.stack ? err.stack : String(err)}`;
  console.error(err);
}

window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

function readSeed() {
  const raw = new URLSearchParams(location.search).get('seed');
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >>> 0 : (Math.random() * 1e9) >>> 0;
}

function main() {
  const seed = readSeed();
  const city = new City({ seed });
  const stage = new Stage(document.getElementById('app'));
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
      const url = new URL(location.href);
      url.searchParams.set('seed', String((Math.random() * 1e9) >>> 0));
      location.href = url.toString();
    },
  });

  stage.cinematic = ui.cinematic;
  stage.onUserCamera = () => {
    ui.cinematic = false;
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
    try {
      const dt = Math.min(clock.getDelta(), 0.1);
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

      stage.render();
    } catch (err) {
      showFatal(err);
      return;
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
