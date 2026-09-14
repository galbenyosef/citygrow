// HUD: 街の情報・速度/トグル・RCI 需要・ニュースフィード
import { CONFIG } from '../config.js';
import { mulberry32 } from '../core/rng.js';

const WRITE_INTERVAL_MS = 125; // DOM 書き込みは ~8回/秒
const TITLE_INTERVAL_MS = 1000;
const FEED_MAX = 4;
const FEED_STALE_MS = 12000;
const FEED_TTL_MS = 25000; // info は 25 秒で消える（milestone は押し出されるまで残る）
const FEED_LEAVE_MS = 480;
const FEED_STAGGER_MS = 90;
const TOAST_MS = 4200;
const HINT_DIM_MS = 30000;
const KBD_FLASH_MS = 180;
const METERS_PER_UNIT = 3; // 表示用: 1 ワールド単位 ≈ 3m

const RANKS = [
  { max: 300, name: '集落' },
  { max: 1500, name: '村' },
  { max: 8000, name: '町' },
  { max: 40000, name: '市' },
  { max: 150000, name: '大都市' },
  { max: Infinity, name: 'メガロポリス' },
];

const SPEED_NAMES = ['一時停止', '標準', '高速', '超高速'];

const NAME_PREFIX = [
  '青葉', '桜', '緑', '若葉', '朝日', '光', '星', '白鳥', '若松', '鶴', '春日', '花見', '泉', '清水',
  '月見', '旭', '新', '東雲', '柏', '楓', '萩', '紅葉', '琴', '雲雀', '風見', '秋津', '翠', '杉', '藤',
  '菊', '椿', '霞', '虹', '蛍', '白樺', '夕陽', '松', '梅', '鈴蘭', '若草', '常盤', '瑞穂', '千歳',
  '八雲', '小春', '水城', '美咲', '陽向', '銀河', '宮',
];
const NAME_SUFFIX = [
  '台', 'ヶ丘', '野', '川', '原', '浜', '崎', '沢', '山', '田', '谷', '森', '島', '橋', '坂', '里',
  '浦', '瀬', '江', '平', '園', '丘', 'が浜', '岡',
];

// シードから決定論的に街の名前と紋章の色相を作る
export function cityIdentity(seed) {
  const r = mulberry32(((seed >>> 0) ^ 0x5bd1e995) >>> 0);
  r();
  const prefix = NAME_PREFIX[Math.floor(r() * NAME_PREFIX.length)];
  const suffix = NAME_SUFFIX[Math.floor(r() * NAME_SUFFIX.length)];
  const hue = Math.floor(r() * 360);
  return { name: `${prefix}${suffix}市`, hue };
}

export function cityNameFromSeed(seed) {
  return cityIdentity(seed).name;
}

// ---- icons (inline SVG) ----
const svgStroke = (body, vb = '0 0 24 24') =>
  `<svg class="i" viewBox="${vb}" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const svgFill = (body, vb = '0 0 24 24') =>
  `<svg class="i" viewBox="${vb}" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">${body}</svg>`;
const tri = (x) =>
  `<path d="M${x} 3.6v8.8c0 .45.5.7.9.45l6.3-4.4c.35-.25.35-.65 0-.9L${x + 0.9} 3.15c-.4-.25-.9 0-.9.45z"/>`;

const ICON = {
  pause: svgFill('<rect x="3.6" y="3" width="3.2" height="10" rx="1"/><rect x="9.2" y="3" width="3.2" height="10" rx="1"/>', '0 0 16 16'),
  play1: svgFill('<path d="M5 3.2v9.6c0 .5.6.8 1 .5l6.9-4.8c.4-.3.4-.8 0-1L6 2.7c-.4-.3-1 0-1 .5z"/>', '0 0 16 16'),
  play2: svgFill(tri(2) + tri(10.5), '0 0 20 16'),
  play3: svgFill(tri(1.5) + tri(9.5) + tri(17.5), '0 0 26 16'),
  camera: svgStroke('<rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 10.5l6-3.2v9.4l-6-3.2z"/>'),
  daynight: svgStroke('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>'),
  dice: svgStroke('<rect x="3" y="3" width="18" height="18" rx="4.5"/><g fill="currentColor" stroke="none"><circle cx="8.2" cy="8.2" r="1.6"/><circle cx="15.8" cy="8.2" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="8.2" cy="15.8" r="1.6"/><circle cx="15.8" cy="15.8" r="1.6"/></g>'),
  sun: svgStroke('<circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/><path d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M5.1 5.1l1.7 1.7M17.2 17.2l1.7 1.7M5.1 18.9l1.7-1.7M17.2 6.8l1.7-1.7"/>'),
  moon: svgFill('<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/>'),
  people: svgStroke('<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20.5c.6-3.7 3.2-5.9 6.5-5.9s5.9 2.2 6.5 5.9"/><path d="M16 4.6a3.4 3.4 0 0 1 0 6.6M18.3 14.9c1.8.8 2.9 2.7 3.2 5.6"/>'),
  jobs: svgStroke('<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.2c0-1 .8-1.7 1.7-1.7h3.6c1 0 1.7.8 1.7 1.7V7M3 12.5h18"/>'),
  buildings: svgStroke('<path d="M2.5 21h19M5 21V10l6-3v14M11 21V3.5h8V21"/><path d="M14.5 7.5h1.5M14.5 11.5h1.5M14.5 15.5h1.5M7.5 13h1M7.5 17h1"/>'),
  tower: svgStroke('<path d="M12 2v3.5M8.5 21V9l3.5-3.5L15.5 9v12M5 21h14M11 12h2M11 16h2"/>'),
  star: svgFill('<path d="M12 2.6l2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.1l-5.7 3 1.1-6.3-4.6-4.5 6.4-.9z"/>'),
  bridge: svgStroke('<path d="M2 15h20M4.5 15v5M19.5 15v5M2 9.5c4.2 0 5.6 5.5 10 5.5s5.8-5.5 10-5.5M7 12.2V15M17 12.2V15"/>'),
  factory: svgStroke('<path d="M3 21V11l5 3v-3l5 3V5h3.5l1.5 16M2 21h20"/>'),
  shop: svgStroke('<path d="M4.5 11v9.5h15V11M3 11l2.2-6.5h13.6L21 11zM10 20.5v-5h4v5"/>'),
  tree: svgStroke('<path d="M12 21.5v-5M12 2.5l6.5 8.5h-3.2l4.2 5.5H4.5L8.7 11H5.5z"/>'),
  calendar: svgStroke('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  road: svgStroke('<path d="M8.5 3L5 21M15.5 3L19 21M12 4v2.5M12 10.5v3M12 17.5v2.5"/>'),
  dot: svgFill('<circle cx="12" cy="12" r="4"/>'),
  skyline: svgFill('<path d="M5 26h22v1.4H5zM6.2 26V17.5h4.2V26zM11.4 26V11.2h5V26zM17.4 26V6.8h4.6V26zM19.4 6.8V3.6h.6v3.2zM23 26V14h3.8V26z"/><g fill="rgba(0,0,0,.28)"><rect x="12.6" y="13" width="1.1" height="1.4"/><rect x="14.3" y="13" width="1.1" height="1.4"/><rect x="12.6" y="16.4" width="1.1" height="1.4"/><rect x="14.3" y="19.8" width="1.1" height="1.4"/><rect x="18.6" y="9" width="1.1" height="1.4"/><rect x="20.3" y="12.4" width="1.1" height="1.4"/><rect x="18.6" y="15.8" width="1.1" height="1.4"/><rect x="20.3" y="19.2" width="1.1" height="1.4"/><rect x="7.3" y="19.6" width="1" height="1.3"/><rect x="24.2" y="16.2" width="1" height="1.3"/></g>', '0 0 32 32'),
};

const FEED_ICON_RULES = [
  [/人口|住民|人$/, ICON.people],
  [/橋/, ICON.bridge],
  [/高層|ビル|タワー|超高層/, ICON.tower],
  [/工業|工場/, ICON.factory],
  [/商業|店|オフィス/, ICON.shop],
  [/公園|緑|森/, ICON.tree],
  [/年|月/, ICON.calendar],
  [/道路|高速|大通り|通り|道/, ICON.road],
];

function feedIcon(text, kind) {
  if (kind === 'milestone') return ICON.star;
  for (const [re, icon] of FEED_ICON_RULES) if (re.test(text)) return icon;
  return ICON.dot;
}

// ---- helpers ----
const NF = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const fmt = (n) => NF.format(Math.round(Number(n) || 0));
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const pct = (v) => `${Math.round(clamp01(Number(v) || 0) * 100)}%`;

function rankIndex(pop) {
  let i = 0;
  while (i < RANKS.length - 1 && pop >= RANKS[i].max) i++;
  return i;
}

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const CODE_KEYS = {
  Space: ' ', KeyC: 'c', KeyN: 'n', KeyH: 'h',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
};

function keyOf(e) {
  let k = e.key;
  if (!k || k === 'Process' || k === 'Unidentified' || e.isComposing || k.length !== 1) {
    k = CODE_KEYS[e.code] || k || '';
  }
  if (k === 'Spacebar' || k === '　') k = ' ';
  return k.length === 1 ? k.toLowerCase() : '';
}

function buildTemplate() {
  const n = CONFIG.SPEEDS.length;
  const speedIcons = [ICON.pause, ICON.play1, ICON.play2, ICON.play3];
  const speedBtns = CONFIG.SPEEDS.map((s, i) => {
    const label = i === 0 ? '一時停止' : `${SPEED_NAMES[i] || '速度'} ×${s}`;
    const key = i === 0 ? 'Space' : String(i);
    return `<button type="button" class="speed-btn" data-speed="${i}" title="${label} (${key})" aria-label="${label}" aria-pressed="false">${speedIcons[Math.min(i, 3)]}</button>`;
  }).join('');

  return `
<section class="hud-layer hud-panel hud-city" data-ref="city" aria-label="街の情報">
  <header class="city-head">
    <div class="city-emblem" data-ref="emblem" aria-hidden="true">${ICON.skyline}</div>
    <div class="city-title">
      <div class="city-name-row">
        <h1 class="city-name" data-ref="name">&nbsp;</h1>
        <span class="city-rank" data-ref="rank" data-tier="0">${RANKS[0].name}</span>
      </div>
      <div class="city-when">
        <span class="city-date" data-ref="date">&nbsp;</span>
        <span class="city-clock" data-ref="clock">
          <span class="clock-icon" aria-hidden="true"><span class="ci-sun">${ICON.sun}</span><span class="ci-moon">${ICON.moon}</span></span>
          <span class="clock-time" data-ref="time">--:--</span>
        </span>
      </div>
    </div>
  </header>
  <div class="day-track" aria-hidden="true"><div class="day-rail" data-ref="dayRail"><i></i></div></div>
  <div class="city-pop">
    <div class="pop-label">${ICON.people}<span>人口</span></div>
    <div class="pop-value"><span data-ref="pop">0</span><small>人</small></div>
    <div class="pop-next" data-ref="popNextWrap">
      <div class="pop-bar"><i data-ref="popBar"></i></div>
      <span class="pop-next-text" data-ref="popNext"></span>
    </div>
  </div>
  <div class="city-stats">
    <div class="stat" data-ref="statJobs">${ICON.jobs}<span class="stat-label">雇用</span><span class="stat-value" data-ref="jobs">0</span></div>
    <div class="stat" data-ref="statBldg">${ICON.buildings}<span class="stat-label">建物</span><span class="stat-value" data-ref="bldg">0</span></div>
    <div class="stat" data-ref="statTall">${ICON.tower}<span class="stat-label">最高</span><span class="stat-value" data-ref="tallest">—</span></div>
  </div>
  <footer class="city-foot"><span data-ref="seed"></span><span class="city-foot-key">H: UI表示切替</span></footer>
</section>

<section class="hud-layer hud-panel hud-controls" aria-label="操作">
  <div class="speed-seg" data-ref="speedSeg" data-speed="1" role="group" aria-label="シミュレーション速度" style="--n:${n}">
    <span class="speed-thumb" data-ref="speedThumb" aria-hidden="true"></span>
    ${speedBtns}
  </div>
  <div class="ctrl-status">
    <span class="speed-label" data-ref="speedLabel">&nbsp;</span>
    <span class="fps" data-ref="fps">-- FPS</span>
  </div>
  <div class="ctrl-list">
    <button type="button" class="ctrl-btn is-toggle" data-action="cinematic" data-ref="btnCine" title="シネマティックカメラ (C)" aria-pressed="false">
      <span class="ctrl-icon">${ICON.camera}</span><span class="ctrl-label">シネマティック</span><span class="switch" aria-hidden="true"><i></i></span>
    </button>
    <button type="button" class="ctrl-btn is-toggle" data-action="daycycle" data-ref="btnDay" title="昼夜サイクル (N)" aria-pressed="false">
      <span class="ctrl-icon">${ICON.daynight}</span><span class="ctrl-label">昼夜サイクル</span><span class="switch" aria-hidden="true"><i></i></span>
    </button>
    <button type="button" class="ctrl-btn is-action" data-action="newcity" data-ref="btnNew" title="別のシードで新しい街をつくる">
      <span class="ctrl-icon">${ICON.dice}</span><span class="ctrl-label">新しい街</span><span class="ctrl-go" aria-hidden="true">›</span>
    </button>
  </div>
</section>

<section class="hud-layer hud-panel hud-rci" aria-label="需要">
  <div class="rci-title">需要</div>
  <div class="rci-bars">
    <div class="rci-col is-r" data-ref="rciR"><div class="rci-track"><i class="rci-fill" data-ref="rciRFill"></i></div><b>R</b></div>
    <div class="rci-col is-c" data-ref="rciC"><div class="rci-track"><i class="rci-fill" data-ref="rciCFill"></i></div><b>C</b></div>
    <div class="rci-col is-i" data-ref="rciI"><div class="rci-track"><i class="rci-fill" data-ref="rciIFill"></i></div><b>I</b></div>
  </div>
</section>

<div class="hud-layer hud-feed" data-ref="feed" role="log" aria-label="ニュース"></div>

<div class="hud-layer hud-hint" aria-hidden="true"><span><b>左ドラッグ</b>: 移動<i>・</i><b>右ドラッグ</b>: 回転<i>・</i><b>ホイール</b>: ズーム<i>・</i><b>Space</b>: 一時停止</span></div>

<div class="hud-layer hud-top">
  <div class="hud-slot hud-slot-paused">
    <button type="button" class="hud-paused" data-action="resume" data-ref="paused" title="再開 (Space)" tabindex="-1">${ICON.pause}<span>一時停止中</span><em>Space で再開</em></button>
  </div>
  <div class="hud-slot hud-slot-toast">
    <div class="hud-toast" data-ref="toast" role="status">${ICON.star}<span data-ref="toastText"></span></div>
  </div>
</div>`;
}

export class Hud {
  constructor(rootEl, callbacks = {}) {
    let root = rootEl;
    if (!root) {
      root = document.createElement('div');
      root.id = 'hud';
      document.body.appendChild(root);
    }
    this.root = root;
    this.cityName = '';
    this._cb = callbacks || {};
    this._cache = Object.create(null);
    this._lastWrite = -Infinity;
    this._lastTitles = -Infinity;
    this._force = true;
    this._booted = false;
    this._bootAt = 0;
    this._seed = null;
    this._rank = -1;
    this._rankPulseUntil = 0;
    this._popShown = -1;
    this._speedIndex = 1;
    this._lastSpeed = 1;
    this._dateShort = '';
    this._pending = [];
    this._items = [];
    this._leaving = [];
    this._toastUntil = 0;
    this._flashEl = null;
    this._flashUntil = 0;

    root.classList.add('is-booting');
    root.innerHTML = buildTemplate();
    this.$ = {};
    for (const el of root.querySelectorAll('[data-ref]')) this.$[el.dataset.ref] = el;
    this._speedBtns = Array.from(root.querySelectorAll('.speed-btn'));

    this._onClick = this._onClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    root.addEventListener('click', this._onClick);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  dispose() {
    this.root.removeEventListener('click', this._onClick);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.root.innerHTML = '';
  }

  log(text, kind) {
    const k = kind === 'milestone' ? 'milestone' : 'info';
    this._pending.push({ text: text == null ? '' : String(text), kind: k, date: this._dateShort });
    if (this._pending.length > FEED_MAX * 3) this._pending.splice(0, this._pending.length - FEED_MAX * 3);
  }

  update(stats, ui) {
    if (!stats || !ui) return;
    const si = ui.speedIndex | 0;
    this._speedIndex = si;
    if (si > 0) this._lastSpeed = si;

    const now = performance.now();
    if (!this._force && now - this._lastWrite < WRITE_INTERVAL_MS) return;
    this._force = false;
    this._lastWrite = now;
    this._write(stats, ui, now);
  }

  // ---- input ----
  _call(name, arg) {
    const fn = this._cb[name];
    if (typeof fn === 'function') fn(arg);
    this._force = true;
  }

  _setSpeed(i) {
    const idx = Math.max(0, Math.min(CONFIG.SPEEDS.length - 1, i | 0));
    this._call('onSpeed', idx);
    this._speedIndex = idx;
    if (idx > 0) this._lastSpeed = idx;
  }

  _togglePause() {
    if (this._speedIndex > 0) {
      this._lastSpeed = this._speedIndex;
      this._setSpeed(0);
    } else {
      this._setSpeed(this._lastSpeed > 0 ? this._lastSpeed : 1);
    }
  }

  _flash(el) {
    if (!el) return;
    if (this._flashEl && this._flashEl !== el) this._flashEl.classList.remove('is-kbd');
    el.classList.add('is-kbd');
    this._flashEl = el;
    this._flashUntil = performance.now() + KBD_FLASH_MS;
    this._force = true;
  }

  _onClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || !this.root.contains(btn)) return;
    if (btn.dataset.speed != null) {
      this._setSpeed(Number(btn.dataset.speed));
    } else {
      switch (btn.dataset.action) {
        case 'cinematic': this._call('onToggleCinematic'); break;
        case 'daycycle': this._call('onToggleDayCycle'); break;
        case 'newcity': this._call('onNewCity'); break;
        case 'resume': this._togglePause(); break;
        default: return;
      }
    }
    // マウス操作ではフォーカスを残さない（Space が効かなくなるのを防ぐ）
    if (e.detail !== 0 && typeof btn.blur === 'function') btn.blur();
  }

  _onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const k = keyOf(e);
    if (!k) return;

    if (k === ' ') {
      e.preventDefault();
      if (e.repeat) return;
      this._togglePause();
      this._flash(this._speedBtns[0]);
      return;
    }
    if (e.repeat) return;
    if (k >= '0' && k <= '9') {
      const i = k.charCodeAt(0) - 48;
      if (i >= CONFIG.SPEEDS.length) return;
      e.preventDefault();
      this._setSpeed(i);
      this._flash(this._speedBtns[i]);
      return;
    }
    switch (k) {
      case 'c':
        this._call('onToggleCinematic');
        this._flash(this.$.btnCine);
        break;
      case 'n':
        this._call('onToggleDayCycle');
        this._flash(this.$.btnDay);
        break;
      case 'h':
        this.root.classList.toggle('is-hidden');
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  _onKeyUp(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    // フォーカス中のボタンが Space の keyup でクリックされないように
    if (keyOf(e) === ' ') e.preventDefault();
  }

  // ---- DOM writes (cached) ----
  _text(el, key, value) {
    if (this._cache[key] !== value) {
      this._cache[key] = value;
      el.textContent = value;
    }
  }

  _class(el, key, cls, on) {
    if (this._cache[key] !== on) {
      this._cache[key] = on;
      el.classList.toggle(cls, on);
    }
  }

  _attr(el, key, name, value) {
    if (this._cache[key] !== value) {
      this._cache[key] = value;
      el.setAttribute(name, value);
    }
  }

  _transform(el, key, value, eps, fn) {
    const prev = this._cache[key];
    if (prev === undefined || Math.abs(prev - value) > eps) {
      this._cache[key] = value;
      el.style.transform = fn(value);
    }
  }

  _write(stats, ui, now) {
    const $ = this.$;

    if (!this._booted) {
      this._booted = true;
      this._bootAt = now;
      // 初回フレームの後にフェードイン
      requestAnimationFrame(() => this.root.classList.remove('is-booting'));
    }

    // 街の名前（シードから決定論的）
    const seed = (Number(ui.seed) || 0) >>> 0;
    if (seed !== this._seed) {
      this._seed = seed;
      const id = cityIdentity(seed);
      this.cityName = id.name;
      $.name.textContent = id.name;
      $.emblem.style.setProperty('--h', String(id.hue));
      $.seed.textContent = `シード ${seed}`;
      try {
        document.title = `${id.name} — CityGrow`;
      } catch (_) {
        /* ignore */
      }
    }

    // 日付
    const date = stats.date;
    if (date) {
      const day = Math.floor(date.day) || 1;
      const key = date.year * 10000 + date.month * 100 + day;
      if (this._cache.dateKey !== key) {
        this._cache.dateKey = key;
        $.date.textContent = `${date.year}年 ${date.month}月 ${day}日`;
        this._dateShort = `${date.month}月${day}日`;
      }
    }

    // 時刻（10分刻み）と太陽/月
    let tod = Number(ui.timeOfDay) || 0;
    tod -= Math.floor(tod);
    const mins = Math.floor(tod * 144) * 10;
    this._text($.time, 'time', `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`);
    this._class($.clock, 'night', 'is-night', !(tod >= 0.25 && tod < 0.75));
    this._transform($.dayRail, 'tod', tod, 0.0008, (v) => `translateX(${(v * 100).toFixed(2)}%)`);

    // 人口（表示値はなめらかに追従）
    const pop = Math.max(0, Number(stats.population) || 0);
    if (this._popShown < 0) this._popShown = pop;
    else {
      const d = pop - this._popShown;
      this._popShown = Math.abs(d) < 3 ? pop : this._popShown + d * 0.5;
    }
    this._text($.pop, 'pop', fmt(this._popShown));

    // ランク
    const ri = rankIndex(pop);
    if (ri !== this._rank) {
      const up = this._rank >= 0 && ri > this._rank;
      this._rank = ri;
      $.rank.textContent = RANKS[ri].name;
      $.rank.setAttribute('data-tier', String(ri));
      if (up) {
        $.rank.classList.remove('is-up');
        $.rank.classList.add('is-up');
        this._rankPulseUntil = now + 1400;
      }
    }
    if (this._rankPulseUntil && now > this._rankPulseUntil) {
      $.rank.classList.remove('is-up');
      this._rankPulseUntil = 0;
    }
    const lo = ri > 0 ? RANKS[ri - 1].max : 0;
    const hi = RANKS[ri].max;
    if (hi === Infinity) {
      this._transform($.popBar, 'popBar', 1, 0.002, () => 'scaleX(1)');
      this._text($.popNext, 'popNext', '最高ランク');
    } else {
      this._transform($.popBar, 'popBar', clamp01((pop - lo) / (hi - lo)), 0.002, (v) => `scaleX(${v.toFixed(3)})`);
      this._text($.popNext, 'popNext', `${RANKS[ri + 1].name}まで あと${fmt(Math.max(1, hi - pop))}人`);
    }

    this._text($.jobs, 'jobs', fmt(stats.jobs));
    this._text($.bldg, 'bldg', fmt(stats.buildings));
    const tall = Number(stats.tallest) || 0;
    this._text($.tallest, 'tall', tall > 0 ? `${fmt(tall * METERS_PER_UNIT)}m` : '—');

    // RCI 需要
    const dem = stats.demand || {};
    this._rci($.rciR, $.rciRFill, 'R', dem.res);
    this._rci($.rciC, $.rciCFill, 'C', dem.com);
    this._rci($.rciI, $.rciIFill, 'I', dem.ind);

    // 速度・トグル
    const si = Math.max(0, Math.min(CONFIG.SPEEDS.length - 1, ui.speedIndex | 0));
    if (this._cache.speed !== si) {
      this._cache.speed = si;
      for (let i = 0; i < this._speedBtns.length; i++) {
        const b = this._speedBtns[i];
        b.classList.toggle('is-active', i === si);
        b.setAttribute('aria-pressed', i === si ? 'true' : 'false');
      }
      $.speedThumb.style.transform = `translateX(${si * 100}%)`;
      $.speedSeg.setAttribute('data-speed', String(si));
      $.speedLabel.textContent = si === 0 ? '一時停止中' : `速度 ×${CONFIG.SPEEDS[si]}`;
      this.root.classList.toggle('is-paused', si === 0);
    }
    this._pressed($.btnCine, 'cine', !!ui.cinematic);
    this._pressed($.btnDay, 'day', !!ui.dayCycle);

    const fps = Math.round(Number(ui.fps) || 0);
    this._text($.fps, 'fps', `${fps} FPS`);
    this._class($.fps, 'fpsWarn', 'is-warn', fps < 50 && fps >= 30);
    this._class($.fps, 'fpsBad', 'is-bad', fps < 30);

    if (this._flashEl && now >= this._flashUntil) {
      this._flashEl.classList.remove('is-kbd');
      this._flashEl = null;
    }

    this._flushFeed(now);

    if (this._toastUntil && now >= this._toastUntil) {
      $.toast.classList.remove('is-show');
      this._toastUntil = 0;
    }

    this._class(this.root, 'hintDim', 'hint-dim', now - this._bootAt > HINT_DIM_MS);

    if (now - this._lastTitles >= TITLE_INTERVAL_MS) {
      this._lastTitles = now;
      this._writeTitles(stats, dem, tall);
    }
  }

  _pressed(el, key, on) {
    if (this._cache[key] !== on) {
      this._cache[key] = on;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  _rci(col, fill, key, value) {
    const v = clamp01(Number(value) || 0);
    this._transform(fill, `rci${key}`, v, 0.004, (x) => `scaleY(${x.toFixed(3)})`);
    this._class(col, `rciHigh${key}`, 'is-high', v > 0.66);
  }

  _writeTitles(stats, dem, tall) {
    const $ = this.$;
    const zc = stats.zoneCounts || {};
    this._attr($.rciR, 'tR', 'title', `住宅の需要 ${pct(dem.res)}（住宅 ${fmt(zc.res)}棟）`);
    this._attr($.rciC, 'tC', 'title', `商業の需要 ${pct(dem.com)}（商業 ${fmt(zc.com)}棟）`);
    this._attr($.rciI, 'tI', 'title', `工業の需要 ${pct(dem.ind)}（工業 ${fmt(zc.ind)}棟）`);
    this._attr($.statJobs, 'tJobs', 'title', `雇用 ${fmt(stats.jobs)} ・ 空き区画 ${fmt(stats.vacantLots)}`);
    this._attr(
      $.statBldg,
      'tBldg',
      'title',
      `住宅 ${fmt(zc.res)} ・ 商業 ${fmt(zc.com)} ・ 工業 ${fmt(zc.ind)} ・ 公園 ${fmt(stats.parks)} ・ 道路 ${fmt(stats.roads)}マス`,
    );
    this._attr($.statTall, 'tTall', 'title', tall > 0 ? `いちばん高い建物: 約${fmt(tall * METERS_PER_UNIT)}m` : 'まだ建物がありません');
  }

  // ---- feed ----
  _flushFeed(now) {
    const feed = this.$.feed;
    if (this._pending.length) {
      const batch = this._pending.length > FEED_MAX ? this._pending.slice(-FEED_MAX) : this._pending.slice();
      this._pending.length = 0;
      let milestone = null;
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        if (!entry.date) entry.date = this._dateShort;
        const delay = j * FEED_STAGGER_MS;
        const el = this._makeFeedItem(entry, delay);
        feed.insertBefore(el, feed.firstChild);
        this._items.unshift({ el, kind: entry.kind, born: now + delay, stale: false });
        if (entry.kind === 'milestone') milestone = entry;
      }
      while (this._items.length > FEED_MAX) this._leave(this._items.pop(), now);
      if (milestone) this._showToast(milestone.text, now);
    }

    for (let i = this._items.length - 1; i >= 0; i--) {
      const it = this._items[i];
      const age = now - it.born;
      if (it.kind === 'info' && age > FEED_TTL_MS) {
        this._items.splice(i, 1);
        this._leave(it, now);
      } else if (!it.stale && age > FEED_STALE_MS) {
        it.stale = true;
        it.el.classList.add('is-stale');
      }
    }

    for (let i = this._leaving.length - 1; i >= 0; i--) {
      const l = this._leaving[i];
      if (now >= l.until) {
        l.el.remove();
        this._leaving.splice(i, 1);
      }
    }
  }

  _makeFeedItem(entry, delayMs) {
    const item = document.createElement('div');
    item.className = `feed-item feed-${entry.kind}`;
    if (delayMs > 0) item.style.animationDelay = `${delayMs}ms`;
    item.innerHTML =
      '<div class="feed-clip"><div class="feed-pad"><div class="feed-card">' +
      `<span class="feed-icon">${feedIcon(entry.text, entry.kind)}</span>` +
      '<span class="feed-text"></span><span class="feed-date"></span>' +
      '</div></div></div>';
    item.querySelector('.feed-text').textContent = entry.text;
    item.querySelector('.feed-date').textContent = entry.date || '';
    return item;
  }

  _leave(it, now) {
    it.el.style.animationDelay = '0ms';
    it.el.classList.add('is-leave');
    this._leaving.push({ el: it.el, until: now + FEED_LEAVE_MS });
  }

  _showToast(text, now) {
    this.$.toastText.textContent = text;
    this.$.toast.classList.add('is-show');
    this._toastUntil = now + TOAST_MS;
  }
}
