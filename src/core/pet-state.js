'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 宠物状态系统（pet-state.js）
   -----------------------------------------------------------------------------
   主进程侧的状态模型。真源在渲染端（index.html 的 pet / drive.d，100ms 汇报
   一次），这里维护「影子状态」：
     · 从 pet:report / pet2:report 同步真源字段（mood/energy/hunger/clean/
       strain/happiness/state/facing/why）
     · 自行推算真源没有的量：boredom（无聊度）、lastInteractAt（互动时间戳）
     · 30 秒节拍（tick）做影子量结算与门槛判断
   供 behavior-engine / relationship-engine / event-engine / memory-manager
   读取与决策。不直接写回页面状态 —— 避免与页面自带的驱动逻辑打架
   （规范 §45：优先保证现有功能正常）。
   ============================================================================= */

const { CONFIG } = require('./config');

function makeState(id) {
  const now = Date.now();
  return {
    id,                         // 1 = 小金毛，2 = 小白
    // ---- 真源字段（从页面 report 同步）----
    state: 'idle',              // 当前动画状态
    facing: 1,                  // 朝向（1 右 / -1 左）
    why: null,                  // 当前行为原因
    happiness: 8,               // 亲密度（页面 happiness，0~无限，通常 0~100+）
    hunger: 18,                 // 饥饿（0~100，0=饱）
    mood: 56,                   // 兴致（0~100）
    energy: 74,                 // 精力（0~100）
    strain: 0,                  // 疲劳（0~100）
    clean: 100,                 // 清洁度（0~100，100=干净）
    // ---- 影子字段（主进程推算）----
    boredom: 0,                 // 无聊度（0~100，互动会重置）
    lastInteractAt: now,        // 最近一次用户互动时间戳（摸头/喂食/动作等）
    lastReportAt: now,          // 最近一次页面汇报时间戳
    lastActionAt: 0,            // 最近一次自发行为时间戳（behavior-engine 用）
    lastEventAt: 0,             // 最近一次事件时间戳（event-engine 用）
    // ---- 运行时统计（memory-manager 用）----
    stats: {
      petted: 0, fed: 0, actions: 0, events: 0, fights: 0, makeups: 0,
    },
    history: [],                // 记忆环形缓冲（Phase 5 填充）
  };
}

/** 从存档恢复影子字段（core/index.js 的 init 调用） */
function restoreInto(state, src) {
  if (!src) return;
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  state.boredom = n(src.boredom, state.boredom);
  state.lastInteractAt = n(src.lastInteractAt, state.lastInteractAt);
  state.happiness = n(src.happiness, state.happiness);
  if (src.stats) Object.assign(state.stats, src.stats);
  if (Array.isArray(src.history)) {
    state.history = src.history.slice(-CONFIG.memory.cap);
  }
}

function intimacyTier(value) {
  const v = Math.max(0, Number(value) || 0);
  let name = '刚认识';
  for (const t of CONFIG.state.intimacyTiers) {
    if (v >= t.at) name = t.name;
  }
  return { value: Math.round(v), name };
}

class PetStateManager {
  constructor() {
    this.states = { 1: makeState(1), 2: makeState(2) };
  }

  /** 从渲染端汇报同步真源（pet:report / pet2:report 的 snap） */
  sync(id, snap) {
    const s = this.states[id];
    if (!s || !snap) return s;
    const now = Date.now();
    const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    s.state = snap.state || s.state;
    s.facing = n(snap.facing, s.facing);
    s.why = snap.why != null ? snap.why : s.why;
    s.happiness = n(snap.happiness, s.happiness);
    s.hunger = n(snap.hunger, s.hunger);
    s.mood = n(snap.mood, s.mood);
    s.energy = n(snap.energy, s.energy);
    s.strain = n(snap.strain, s.strain);
    s.clean = snap.clean != null ? n(snap.clean, s.clean) : 100;
    s.lastReportAt = now;
    return s;
  }

  /** 记录一次用户互动（摸头/喂食/控制台动作等），重置无聊度 */
  recordInteract(id) {
    const s = this.states[id];
    if (!s) return;
    s.lastInteractAt = Date.now();
    s.boredom = 0;
  }

  /** 30 秒节拍：影子量结算（速率对齐规范 §5：boredom +0.6/min、energy -0.25/min、hunger +0.8/min） */
  tick(now) {
    const st = CONFIG.state;
    for (const id of [1, 2]) {
      const s = this.states[id];
      if (!s) continue;
      // 无聊度：无互动每分钟 +0.6（线性，规范 §5）
      s.boredom = Math.min(100, s.boredom + st.boredomRise);
      // 影子衰减（仅供决策参考，真源以页面为准）
      s.energy = Math.max(0, s.energy - st.shadowEnergyDecay);
      s.hunger = Math.min(100, s.hunger + st.shadowHungerRise);
    }
  }

  /** 取出某狗状态（决策引擎只读用） */
  get(id) {
    return this.states[id] || this.states[1];
  }

  /** 两只狗状态的只读快照（控制台/统计用） */
  snapshot() {
    return {
      1: Object.assign({}, this.states[1], {
        intimacy: intimacyTier(this.states[1].happiness),
      }),
      2: Object.assign({}, this.states[2], {
        intimacy: intimacyTier(this.states[2].happiness),
      }),
    };
  }
}

module.exports = { PetStateManager, makeState, intimacyTier, restoreInto };
