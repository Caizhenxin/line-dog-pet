'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 随机事件引擎（event-engine.js）
   -----------------------------------------------------------------------------
   18 个「小狗自发生成的小剧场」：满足条件的事件按节拍概率触发，演一段
   动作 + 台词，并可能带数值影响（兴致/好感/亲密度）。
   设计约束：
     · 忙时不打断：正在睡/洗澡/吃饭/互动时不触发
     · 冷却 + 概率双重防刷屏
     · 单狗事件挑「更闲的那只」演；双狗事件两只一起演
     · 事件效果即时结算到影子状态 + 统计
   ============================================================================= */

const { CONFIG } = require('./config');
const EV = CONFIG.event;
const QU = CONFIG.quiet;

// 忙状态（不打断）
const BUSY = ['sleep', 'wash', 'eat', 'meet', 'drag', 'drop'];

// ---------------------------------------------------------------------------
// 事件表：cond(ctx) 为触发条件；ctx = { states, relationship }
// ---------------------------------------------------------------------------
const EVENTS = [
  // —— 单狗事件（12 个）——
  {
    id: 'dig', name: '挖宝',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'scratch' }); send(id, { type: 'say', text: '这里好像埋着什么…挖到了！', ms: 1800 }); },
    effect: (id, st, rt) => { st.happiness = Math.min(150, st.happiness + 1); },
  },
  {
    id: 'sneeze', name: '打喷嚏',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'jump' }); send(id, { type: 'say', text: '阿嚏！谁在想我？', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'butterfly', name: '追蝴蝶',
    cond: (ctx) => (ctx.states.get(1).mood + ctx.states.get(2).mood) / 2 >= 55,
    play: (id, st, send) => { send(id, { type: 'act', act: 'run' }); send(id, { type: 'say', text: '蝴蝶别跑！等我一下！', ms: 1600 }); },
    effect: (id, st) => { st.energy = Math.max(0, st.energy - 2); },
  },
  {
    id: 'sing', name: '哼歌',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'dance' }); send(id, { type: 'say', text: '啦啦啦～今天心情不错～', ms: 1600 }); },
    effect: (id, st) => { st.mood = Math.min(100, st.mood + 3); },
  },
  {
    id: 'window', name: '看窗外',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'sit' }); send(id, { type: 'say', text: '外面的云好好看…', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'peek', name: '偷看你',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'bored' }); send(id, { type: 'say', text: '你在忙什么呀？我也想看！', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'cute', name: '撒娇',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'rub' }); send(id, { type: 'say', text: '蹭蹭你～今天也要开开心心哦！', ms: 1600 }); },
    effect: (id, st) => { st.happiness = Math.min(150, st.happiness + 1); },
  },
  {
    id: 'bug', name: '发现小虫子',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'jump' }); send(id, { type: 'say', text: '呜哇——有虫子！吓我一跳！', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'yawn', name: '打哈欠',
    cond: (ctx) => ctx.states.get(1).strain + ctx.states.get(2).strain >= 80,
    play: (id, st, send) => { send(id, { type: 'act', act: 'sit' }); send(id, { type: 'say', text: '哈啊——有点困了…', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'tail', name: '追尾巴',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'spin' }); send(id, { type: 'say', text: '转晕了…尾巴你站住！', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'mirror', name: '对镜子打招呼',
    cond: () => true,
    play: (id, st, send) => { send(id, { type: 'act', act: 'greet' }); send(id, { type: 'say', text: '嗨！镜子里的我！', ms: 1600 }); },
    effect: null,
  },
  {
    id: 'zoomies', name: '突然兴奋',
    cond: (ctx) => (ctx.states.get(1).mood + ctx.states.get(2).mood) / 2 >= 60,
    play: (id, st, send) => { send(id, { type: 'act', act: 'excited' }); send(id, { type: 'say', text: '好耶！我超有精神！冲鸭！', ms: 1600 }); },
    effect: (id, st) => { st.mood = Math.min(100, st.mood + 2); },
  },

  // —— 双狗事件（6 个）——
  {
    id: 'duo-window', name: '一起看窗外', duo: true,
    cond: () => true,
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'sit' }); send(1, { type: 'say', text: '小白你看！外面有鸟！', ms: 1700 });
      send(2, { type: 'act', act: 'sit' }); send(2, { type: 'say', text: '哇！真的！', ms: 1700 });
    },
    effect: (id, st, rt) => { const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-window'); },
  },
  {
    id: 'duo-chase', name: '互相追逐', duo: true,
    cond: (ctx) => (ctx.states.get(1).mood + ctx.states.get(2).mood) / 2 >= 55,
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'run' }); send(1, { type: 'say', text: '来追我呀！', ms: 1500 });
      send(2, { type: 'act', act: 'run' }); send(2, { type: 'say', text: '别跑！看我的！', ms: 1500 });
    },
    effect: (id, st, rt) => { const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-chase'); },
  },
  {
    id: 'duo-share', name: '分享零食', duo: true,
    cond: (ctx) => ctx.states.get(1).hunger >= 40 || ctx.states.get(2).hunger >= 40,
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'eat' }); send(1, { type: 'say', text: '给你一半！', ms: 1500 });
      send(2, { type: 'act', act: 'eat' }); send(2, { type: 'say', text: '好吃！你真好！', ms: 1500 });
    },
    effect: (id, st, rt) => {
      const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-share');
      st.hunger = Math.max(0, st.hunger - 10);
    },
  },
  {
    id: 'duo-hug', name: '依偎贴贴', duo: true,
    cond: (ctx) => { const r = ctx.relationship; return r ? r.affection >= 45 : true; },
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'rub' }); send(1, { type: 'say', text: '贴贴～', ms: 1500 });
      send(2, { type: 'act', act: 'excited' }); send(2, { type: 'say', text: '最喜欢你了！', ms: 1500 });
    },
    effect: (id, st, rt) => { const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-hug'); },
  },
  {
    id: 'duo-nap', name: '一起打盹', duo: true,
    cond: (ctx) => ctx.states.get(1).strain + ctx.states.get(2).strain >= 100,
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'sit' }); send(1, { type: 'say', text: '一起眯一会儿…', ms: 1500 });
      send(2, { type: 'act', act: 'sit' }); send(2, { type: 'say', text: '呼…呼…', ms: 1500 });
    },
    effect: (id, st, rt) => { const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-nap'); },
  },
  {
    id: 'duo-cheer', name: '一起庆祝', duo: true,
    cond: () => true,
    play: (id, st, send) => {
      send(1, { type: 'act', act: 'celebrate' }); send(1, { type: 'say', text: '好耶！双狗同乐！', ms: 1500 });
      send(2, { type: 'act', act: 'dance' }); send(2, { type: 'say', text: '转圈圈！', ms: 1500 });
    },
    effect: (id, st, rt) => {
      const rel = rt.engines.relationship; if (rel) rel.recordMeet('duo-cheer');
      st.mood = Math.min(100, st.mood + 1);
    },
  },
];

class EventEngine {
  /**
   * @param {object} runtime
   * @param {object} opts  sendToPet: (id, msg) => void
   */
  constructor(runtime, opts) {
    this.tickMs = EV.checkMs;
    this.runtime = runtime;
    this.sendToPet = (opts && opts.sendToPet) || (() => {});
    this.quiet = (opts && opts.quietMode) || (() => false);
    this.lastEventAt = 0;
    this.hourStamp = [];                       // 最近 1 小时触发时间戳（§18 每小时 ≤4）
    this.dayStamp = [];                        // 最近 24 小时触发时间戳（§18 每天 ≤20）
    this.events = EVENTS;
  }

  /** 节拍入口（§18/§19：30s 检查、3min 冷却、每小时 4 次/每天 20 次、动态概率） */
  tick(now) {
    const mode = this._mode();
    if (mode === 'dnd') return;                // 勿扰：随机事件 =0（§36）
    if (now - this.lastEventAt < EV.cooldownMs) return;   // 事件之间至少 3 分钟（§18）
    if (!this._capsOk(now)) return;            // 每小时 4 次 / 每天 20 次（§18）
    if (Math.random() > this._chance(now, mode)) return; // 动态概率（§19）
    const ctx = this._ctx();
    // 忙时全局让路
    for (const id of [1, 2]) {
      const st = ctx.states.get(id);
      if (st.state && BUSY.indexOf(st.state) >= 0) return;
    }
    const candidates = this.events.filter((e) => e.cond(ctx));
    if (!candidates.length) return;
    const ev = candidates[(Math.random() * candidates.length) | 0];
    this.play(ev, ctx);
    this.lastEventAt = now;
    this.hourStamp.push(now);
    this.dayStamp.push(now);
  }

  /** 当前 idle 模式（读 idle-system） */
  _mode() {
    const idle = this.runtime.engines && this.runtime.engines.idle;
    return idle ? idle.mode : 'normal';
  }

  /** 动态触发概率（§19）：基础 5%；5min 无互动 8%；10min 无互动 12%；quiet ×0.5 */
  _chance(now, mode) {
    const idle = this.runtime.engines && this.runtime.engines.idle;
    const lastInput = idle ? idle.lastInputAt : Date.now();
    let c = EV.chance;
    const gap = now - lastInput;
    if (gap > 10 * 60 * 1000) c = EV.chanceIdle10m;
    else if (gap > 5 * 60 * 1000) c = EV.chanceIdle5m;
    if (mode === 'quiet') c *= QU.eventMul;    // 安静：随机事件 ×0.5（§36）
    return c;
  }

  /** 每小时/每天上限（滑动窗口，§18） */
  _capsOk(now) {
    this.hourStamp = this.hourStamp.filter((t) => now - t < 3600000);
    this.dayStamp = this.dayStamp.filter((t) => now - t < 86400000);
    return this.hourStamp.length < EV.hourCap && this.dayStamp.length < EV.dayCap;
  }

  /** 执行一个事件（外部引擎也可直接调用） */
  play(ev, ctx) {
    ctx = ctx || this._ctx();
    if (ev.duo) {
      ev.play(null, null, this.sendToPet);
      const s1 = this.runtime.states.get(1), s2 = this.runtime.states.get(2);
      if (ev.effect) ev.effect(null, s2, this.runtime);
      s1.stats.events += 1; s2.stats.events += 1;
      this.runtime.states.recordActivity(1);
      this.runtime.states.recordActivity(2);
      const mem = this.runtime.engines && this.runtime.engines.memory;
      if (mem) { mem.record(1, 'event', ev.name); mem.record(2, 'event', ev.name); }
    } else {
      const id = this._pickDog();
      const st = this.runtime.states.get(id);
      ev.play(id, st, this.sendToPet);
      if (ev.effect) ev.effect(id, st, this.runtime);
      st.stats.events += 1;
      this.runtime.states.recordActivity(id);
      const mem = this.runtime.engines && this.runtime.engines.memory;
      if (mem) mem.record(id, 'event', ev.name);
    }
  }

  /** 挑更闲的那只演单狗事件（优先 boredom 高 + 空闲） */
  _pickDog() {
    const s1 = this.runtime.states.get(1), s2 = this.runtime.states.get(2);
    const busy1 = s1.state && BUSY.indexOf(s1.state) >= 0;
    const busy2 = s2.state && BUSY.indexOf(s2.state) >= 0;
    if (busy1 && !busy2) return 2;
    if (busy2 && !busy1) return 1;
    return s1.boredom >= s2.boredom ? 1 : 2;
  }

  _ctx() {
    return { states: this.runtime.states, relationship: this.runtime.engines.relationship || null };
  }

  snapshot() {
    return { events: this.events.length, lastEventAt: this.lastEventAt };
  }
}

function create(runtime, opts) {
  return new EventEngine(runtime, opts);
}

module.exports = { EventEngine, create, EVENTS };
