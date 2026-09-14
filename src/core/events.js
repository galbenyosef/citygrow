// 最小のイベントエミッタ
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(name, fn) {
    let list = this._handlers.get(name);
    if (!list) this._handlers.set(name, (list = []));
    list.push(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    const list = this._handlers.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(name, payload) {
    const list = this._handlers.get(name);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) fn(payload);
  }
}
