import { CONFIG, TILE, ROAD, ZONE, DIRS } from '../config.js';

// グリッド状態。全配列は idx(x, z) = z * size + x でアクセス
export class World {
  constructor(size = CONFIG.GRID) {
    this.size = size;
    const n = size * size;
    this.terrain = new Uint8Array(n).fill(TILE.LAND);
    this.road = new Uint8Array(n); // ROAD.*（水上なら橋）
    this.zone = new Uint8Array(n); // ZONE.*
    this.building = new Int32Array(n).fill(-1); // 建物ID
    this.trees = new Uint8Array(n); // 0..3
    this.landValue = new Float32Array(n); // 0..1
  }

  idx(x, z) {
    return z * this.size + x;
  }

  inBounds(x, z) {
    return x >= 0 && z >= 0 && x < this.size && z < this.size;
  }

  isWater(x, z) {
    return this.inBounds(x, z) && this.terrain[this.idx(x, z)] === TILE.WATER;
  }

  isLand(x, z) {
    return this.inBounds(x, z) && this.terrain[this.idx(x, z)] === TILE.LAND;
  }

  isRoad(x, z) {
    return this.inBounds(x, z) && this.road[this.idx(x, z)] !== ROAD.NONE;
  }

  // 隣接道路のビットマスク（N=1, E=2, S=4, W=8）
  roadMask(x, z) {
    let mask = 0;
    for (let i = 0; i < 4; i++) {
      const d = DIRS[i];
      if (this.isRoad(x + d.dx, z + d.dz)) mask |= d.bit;
    }
    return mask;
  }

  // 陸地・道路なし・建物なし
  isVacantLot(x, z) {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    return this.terrain[i] === TILE.LAND && this.road[i] === ROAD.NONE && this.building[i] === -1;
  }

  isZonedVacant(x, z) {
    return this.isVacantLot(x, z) && this.zone[this.idx(x, z)] !== ZONE.NONE;
  }

  forEachNeighbor(x, z, fn) {
    for (let i = 0; i < 4; i++) {
      const d = DIRS[i];
      const nx = x + d.dx;
      const nz = z + d.dz;
      if (this.inBounds(nx, nz)) fn(nx, nz, d, i);
    }
  }
}
