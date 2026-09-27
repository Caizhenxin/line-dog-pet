'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 用户空闲检测（idle-system.js）
   -----------------------------------------------------------------------------
   检测用户是否离开（规范 §25/§26/§36 对齐，三模式）：
     · 120 秒无输入   → quiet（安静：降频降概率）
     · 600 秒无输入  → dnd（勿扰：主动台词/事件/捣蛋/弹窗 =0，基础行为保留）
     · 用户重新操作  → 立即回 normal
   输入信号来源：
     · main.js 每 1 秒采样一次光标位置喂给 sampleCursor（位置变 = 活跃）
     · core/index.js recordInteract 转发（用户摸狗/点控制台 = 活跃）
   落地：
     · idle-system 只负责判定与广播；落地由 main.js 的 onModeChange 执行
       （goose.setQuietLevel —— 见 main.js 接入）
   ============================================================================= */

const { CONFIG } = require('./config');
const IDLE = CONFIG.idle;

class IdleSystem {
  /**
   * @param {object} runtime
   * @param {object} opts
   *   onModeChange: (mode) => void   模式切换回调（'normal'|'quiet'|'dnd'）
   */
  constructor(runtime, opts) {
    this.tickMs = IDLE.checkMs;
    this.runtime = runtime;
    this.onModeChange = (opts && opts.onModeChange) || (() => {});
    this.mode = 'normal';
    this.lastInputAt = Date.now();
    this.lastCursor = null;
  }

  /** main.js 每 1s 喂光标位置（位置变 → 活跃） */
  sampleCursor(x, y) {
    if (x == null || y == null) return;
    if (this.lastCursor && (x !== this.lastCursor[0] || y !== this.lastCursor[1])) {
      this.lastInputAt = Date.now();
      this._backToNormal();
    }
    this.lastCursor = [x, y];
  }

  /** 用户互动（core/index.js recordInteract 转发） */
  onInput() {
    this.lastInputAt = Date.now();
    this._backToNormal();
  }

  /** 节拍：判定 quiet / dnd（§25：120s / 600s） */
  tick(now) {
    const idleMs = now - this.lastInputAt;
    let target = 'normal';
    if (idleMs >= IDLE.deepIdleAtMs) target = 'dnd';      // 600s → 勿扰
    else if (idleMs >= IDLE.idleAtMs) target = 'quiet';   // 120s → 安静
    if (target !== this.mode) {
      this.mode = target;
      this.onModeChange(target);
    }
  }

  _backToNormal() {
    if (this.mode === 'normal') return;
    this.mode = 'normal';
    this.onModeChange('normal');
  }

  /** 是否处于安静类模式（quiet / dnd） */
  isQuiet() {
    return this.mode === 'quiet' || this.mode === 'dnd';
  }

  /** 是否处于勿扰模式 */
  isDnd() {
    return this.mode === 'dnd';
  }

  snapshot() {
    return { mode: this.mode, idleMs: Date.now() - this.lastInputAt };
  }
}

function create(runtime, opts) {
  return new IdleSystem(runtime, opts);
}

module.exports = { IdleSystem, create };
