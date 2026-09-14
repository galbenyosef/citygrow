// 全モジュール共通の定数と座標ヘルパー（sim層からも使うので three/DOM に依存しないこと）

export const CONFIG = Object.freeze({
  GRID: 160, // 1辺のセル数
  CELL: 4, // 1セルのワールド単位
  TICKS_PER_SECOND: 10, // 1倍速でのシミュレーション tick / 秒
  MAX_TICKS_PER_UPDATE: 40,
  DAYS_PER_TICK: 0.2, // 暦の進み（1倍速で 2日/秒）
  START_YEAR: 2026,
  DAY_LENGTH: 150, // 昼夜1サイクルのシム秒
  SPEEDS: Object.freeze([0, 1, 3, 8]),
});

export const TILE = Object.freeze({ WATER: 0, LAND: 1 });
export const ZONE = Object.freeze({ NONE: 0, RES: 1, COM: 2, IND: 3, PARK: 4 });
export const ROAD = Object.freeze({ NONE: 0, STREET: 1, AVENUE: 2, HIGHWAY: 3 });

// N は -z 方向
export const DIRS = Object.freeze([
  Object.freeze({ dx: 0, dz: -1, bit: 1, name: 'N' }),
  Object.freeze({ dx: 1, dz: 0, bit: 2, name: 'E' }),
  Object.freeze({ dx: 0, dz: 1, bit: 4, name: 'S' }),
  Object.freeze({ dx: -1, dz: 0, bit: 8, name: 'W' }),
]);

export const ZONE_COLORS = Object.freeze({
  [ZONE.RES]: 0x6fd35a,
  [ZONE.COM]: 0x4aa3ff,
  [ZONE.IND]: 0xf2c94c,
  [ZONE.PARK]: 0x3fa34d,
});

export function cellToWorld(x, z, out = { x: 0, z: 0 }) {
  out.x = (x - CONFIG.GRID / 2 + 0.5) * CONFIG.CELL;
  out.z = (z - CONFIG.GRID / 2 + 0.5) * CONFIG.CELL;
  return out;
}

export function worldToCell(wx, wz, out = { x: 0, z: 0 }) {
  out.x = Math.floor(wx / CONFIG.CELL + CONFIG.GRID / 2);
  out.z = Math.floor(wz / CONFIG.CELL + CONFIG.GRID / 2);
  return out;
}

// rotation r の建物は正面（ローカル +Z）が DIRS[r] を向く
const ROTATION_ANGLES = Object.freeze([Math.PI, Math.PI / 2, 0, -Math.PI / 2]);
export function rotationToAngle(r) {
  return ROTATION_ANGLES[((r % 4) + 4) % 4];
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
