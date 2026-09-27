'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 行为决策引擎（behavior-engine.js）
   -----------------------------------------------------------------------------
   按《V2 改造执行规范》§7-§10 重构：
     · 每 5 秒一次行为决策（decisionInterval），页面动作未结束不重新决策
     · 权重计算：9 类基础权重（§8）+ 状态加权（§9），加权随机（禁止纯随机）
     · 状态强制行为（饥饿/疲劳/清洁）独立于无聊度门槛，不被 boredom 挡住
     · 防重复（§10）：保存最近 8 个；最近一次 <15s → 权重 -80%；
       连续两次 → 第三次禁止立即重复；用户触发/状态强制/特殊事件例外
     · 抽象行为 → 页面动作映射（兼容层：只下发页面认识的动作名）
     · 三模式联动（§26/§36）：quiet 决策间隔 15s、dnd 仅允许基础行为
   介入方式（影子兼容架构，规范 §45）：
     页面自带 auto 决策不动；本引擎只在两类时机介入：
       ① 状态强制行为（饿/脏/累，§10 例外，不受 boredom 门槛限制）
       ② boredom ≥ 阈值（狗闲太久，主进程帮它找事做）
       ③ 随机事件/关系互动触发的指定行为（Phase 3/4 调用 issue）
   ============================================================================= */

const { CONFIG } = require('./config');

const B = CONFIG.behavior;
const ST = CONFIG.state;
const QU = CONFIG.quiet;

class BehaviorEngine {
  /**
   * @param {object} runtime  V2Runtime 实例（读 states）
   * @param {object} opts
   *   sendToPet: (id, msg) => void   下发指令的真实通道
   *   quietMode: () => boolean       dnd 生效时暂停自发行为（Phase 6）
   */
  constructor(runtime, opts) {
    this.tickMs = B.decisionInterval;
    this.runtime = runtime;
    this.sendToPet = (opts && opts.sendToPet) || (() => {});
    this.quiet = (opts && opts.quietMode) || (() => false);
    this.recent = { 1: [], 2: [] };            // 防重复环形记录（最近 8 个）
    this.lastActAt = { 1: {}, 2: {} };         // 各行为最近执行时间（sameActionCooldown 用）
    this.beats = 0;                            // 节拍计数（idle 模式降频）
  }

  /** 节拍入口（scheduler 每 decisionInterval 调用一次） */
  tick(now) {
    const mode = this._mode();
    // dnd：行为引擎仅允许基础行为（§36），仍按 30s 间隔决策；
    // 不得因 quiet 判断提前 return（isQuiet 对 quiet/dnd 均 true，会阻断 dndAllowed 基础行为）
    if (mode === 'dnd') {
      if (!this._beatOk(now, QU.behaviorDeepInterval)) return;
      for (const id of [1, 2]) this._maybeAct(id, now, true);
      return;
    }
    // quiet：决策间隔 15s（§26），自发行为降频
    if (mode === 'quiet') {
      if (!this._beatOk(now, QU.behaviorIdleInterval)) return;
    }
    for (const id of [1, 2]) this._maybeAct(id, now, false);
  }

  /** 直接触发一个指定行为（事件引擎/关系引擎用，绕过节拍） */
  issue(id, act, { record = true } = {}) {
    this._do(id, act, record);
  }

  // ---------------------------------------------------------------------------

  /** 当前 idle 模式（读 idle-system） */
  _mode() {
    const idle = this.runtime.engines && this.runtime.engines.idle;
    return idle ? idle.mode : 'normal';
  }

  /** 降频：按 intervalMs 节拍数决定是否本次决策 */
  _beatOk(now, intervalMs) {
    this._lastBeatAt = this._lastBeatAt || 0;
    if (now - this._lastBeatAt < intervalMs) return false;
    this._lastBeatAt = now;
    return true;
  }

  _maybeAct(id, now, dndOnly) {
    const st = this.runtime.states.get(id);
    // 页面正忙（动画状态非 idle/sit/walk）时不打断（§7：当前动作未结束不重新决策）
    if (st.state && st.state !== 'idle' && st.state !== 'sit' && st.state !== 'walk') return;
    // 距上次自发行为最小间隔（防同一节拍连发）
    if (now - st.lastActionAt < this.tickMs) return;

    // —— ① 状态强制行为（§10 例外：状态强制可重复，不被 boredom 门槛挡住）——
    const forced = this._forcedAct(st);
    if (forced) { this._do(id, forced, true, now); return; }

    // dnd：仅基础行为（§36）
    if (dndOnly) {
      const act = this._pick(id, st, QU.dndAllowed);
      if (act) this._do(id, act, true, now);
      return;
    }

    // —— ② 影子介入门槛：无聊度够高才介入 ——
    if (st.boredom < ST.boredAt) return;
    const act = this._pick(id, st);
    if (!act) return;
    this._do(id, act, true, now);
  }

  /** 状态强制行为：饥饿/清洁/疲劳（项目现有生命周期系统 + 规范 §9 energy 强制） */
  _forcedAct(st) {
    if (st.hunger >= 85) return 'foodSeeking';          // 很饿 → 强制找食物（§9 hunger>=85）
    if (st.clean <= B.washAt) return 'wash';            // 脏 → 强制去洗（项目清洁系统）
    if (st.strain >= B.sleepStrainAt) return 'sleep';   // 疲劳 → 强制睡觉（项目疲劳系统）
    if (st.energy <= 15) return 'sleep';                // 精力耗尽 → 优先睡觉（§9）
    return null;
  }

  /** 权重抽样：baseWeights + mods 状态加权 + 防重复（§8/§9/§10） */
  _pick(id, st, onlyKeys) {
    const w = {};
    // 基础权重
    for (const name in B.baseWeights) {
      if (onlyKeys && onlyKeys.indexOf(name) < 0) continue;
      w[name] = B.baseWeights[name];
    }
    // 状态加权（§9）
    for (const m of B.mods) {
      if (!m.test(st)) continue;
      if (m.add) for (const k in m.add) {
        if (!onlyKeys || onlyKeys.indexOf(k) >= 0) w[k] = (w[k] || 0) + m.add[k];
      }
      if (m.sub) for (const k in m.sub) {
        if (w[k]) w[k] = Math.max(0, w[k] - m.sub[k]);
      }
    }
    // 防重复（§10）
    const recent = this.recent[id] || [];
    const lastAt = this.lastActAt[id] || {};
    for (const name in w) {
      // 最近一次执行 <15s → 权重 -80%
      if (lastAt[name] && Date.now() - lastAt[name] < B.sameActionCooldown) w[name] *= 0.2;
      // 连续两次 → 第三次禁止立即重复
      const lastTwo = recent.slice(-2);
      if (lastTwo.length === 2 && lastTwo[0] === name && lastTwo[1] === name) w[name] = 0;
    }
    // 加权随机
    let total = 0;
    for (const name in w) total += w[name];
    if (total <= 0) return null;
    let x = Math.random() * total, out = null;
    for (const name in w) { x -= w[name]; if (x <= 0) { out = name; break; } }
    return out;
  }

  /** 下发：抽象行为 → 页面动作（actMap），记录防重复/统计/记忆 */
  _do(id, act, record, now) {
    const pageAct = B.actMap[act] || act;          // 映射到页面认识的动作名
    this.sendToPet(id, { type: 'act', act: pageAct });
    if (!record) return;
    this.runtime.states.recordActivity(id);        // 自发行为=活动记录（不触发用户互动逻辑）
    const st = this.runtime.states.get(id);
    st.lastActionAt = now || Date.now();
    // 防重复记录（环形 8）
    const r = this.recent[id];
    r.push(act);
    if (r.length > B.recentActionHistorySize) r.shift();
    this.lastActAt[id][act] = now || Date.now();
    // 统计
    st.stats.actions += 1;
    // 记忆
    const mem = this.runtime.engines && this.runtime.engines.memory;
    if (mem) mem.record(id, 'action', act);
  }
}

/** 工厂：main.js 一行创建 */
function create(runtime, opts) {
  return new BehaviorEngine(runtime, opts);
}

module.exports = { BehaviorEngine, create };
