'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 双狗关系引擎（relationship-engine.js）
   -----------------------------------------------------------------------------
   管理两只狗之间的关系数值与事件（规范 §12/§15/§16/§17 对齐）：
     · affection 双狗好感（0~100）：互动 +（安慰类更多），久不互动自然降温
     · friendship 双狗友谊（0~100，初始 50）：互动 +，吵架 -，和好 +；
       用于吵架门槛（<30）与互动概率联动
     · jealousy 吃醋（每狗 0~100）：用户连续 3 次以上只跟一只玩 → 另一只 +10；
       高了那只狗会「找存在感」（蹭用户/贴贴），每 10 分钟最多一次
     · 吵架/和好：friendship <30 且概率触发（冷却 10 分钟）；
       吵架 friendship -3 / affection -2 / mood -5；
       吵架后至少 5 分钟自动和好：friendship +5 / affection +5 / mood +8
   接入点：
     · recordMeet(kind)：main.js 的 startMeet 互动结束（meetEnd）时调用
     · onUserInteract(id)：core/index.js 的 recordInteract 里转发（用户摸谁）
     · tick：5s 节拍做结算与事件
   ============================================================================= */

const { CONFIG } = require('./config');
const R = CONFIG.relationship;

class RelationshipEngine {
  /**
   * @param {object} runtime
   * @param {object} opts
   *   sendToPet: (id, msg) => void   吵架/和好/吃醋的表现动作走这里
   *   getPetState: (id) => obj       可选的页面状态读取（判断忙不忙）
   */
  constructor(runtime, opts) {
    this.tickMs = R.tickMs;
    this.runtime = runtime;
    this.sendToPet = (opts && opts.sendToPet) || (() => {});
    this.affection = R.initAffection;
    this.friendship = R.initFriendship;        // 初始 50（规范 §12）
    this.jealousy = { 1: 0, 2: 0 };
    this.fighting = false;
    this.fightUntil = 0;
    this.lastMeetAt = 0;
    this.lastFightAt = 0;                      // 吵架冷却（§15：10 分钟）
    this.lastJealousActAt = { 1: 0, 2: 0 };    // 吃醋行为冷却（§17：10 分钟）
    this.focusStreak = { 1: 0, 2: 0 };         // 各狗连续被用户互动的次数（§17）
  }

  /** 一次双狗互动完成（meetEnd 调用） */
  recordMeet(kind) {
    const comfort = !!kind && (kind.indexOf('comfort') >= 0 || kind.indexOf('hug') >= 0);
    this.affection = Math.min(100, this.affection + (comfort ? R.meetGainComfort : R.meetGain));
    this.friendship = Math.min(100, this.friendship + (comfort ? R.friendshipGainComfort : R.friendshipGain));
    this.lastMeetAt = Date.now();
    this.fighting = false;                     // 互动即破冰
  }

  /** 用户互动（core/index.js recordInteract 转发：用户摸了/点了某只） */
  onUserInteract(id) {
    const other = id === 1 ? 2 : 1;
    // 连续互动计数（§17）：只清另一只的连续计数，自己的累加
    this.focusStreak[other] = 0;
    this.focusStreak[id] += 1;
    // 连续 3 次以上只摸这一只 → 另一只吃醋 +10（§17）
    if (this.focusStreak[id] >= 3) {
      this.jealousy[other] = Math.min(100, this.jealousy[other] + R.jealousyRise);
      this.focusStreak[id] = 0;                // 触发后重置（防连续刷）
    }
  }

  /** 5s 节拍 */
  tick(now) {
    // —— 好感自然降温 ——
    if (now - this.lastMeetAt > R.decayAtMs) {
      this.affection = Math.max(0, this.affection - R.decayPerTick);
    }
    // —— 吵架中：至少 5 分钟后自动和好（§16）——
    if (this.fighting) {
      if (now >= this.fightUntil) this._makeUp(now);
      return;
    }
    // —— 吃醋回落 ——
    for (const id of [1, 2]) {
      if (this.jealousy[id] > 0) {
        this.jealousy[id] = Math.max(0, this.jealousy[id] - R.jealousyDecay);
      }
    }
    // —— 吃醋行为：冷落那只去蹭用户（§17，每 10 分钟最多一次）——
    for (const id of [1, 2]) {
      if (this.jealousy[id] < R.jealousActAt) continue;
      if (now - this.lastJealousActAt[id] < R.jealousCooldownMs) continue;
      const st = this.runtime.states.get(id);
      if (st.state && ['sleep', 'run', 'meet', 'wash', 'eat'].indexOf(st.state) >= 0) continue;   // 忙时不打断
      if (Math.random() < 0.3) {
        this.sendToPet(id, { type: 'act', act: 'rub' });
        this.runtime.states.recordInteract(id);
        this.jealousy[id] = Math.max(0, this.jealousy[id] - 15);
        this.lastJealousActAt[id] = now;
        return;                                // 每节拍至多一只吃醋
      }
    }
    // —— 吵架检查（§15）：友谊 <30 + 概率 + 冷却 10 分钟 ——
    if (this.friendship < R.fightAt
        && Math.random() < R.fightChance
        && now - this.lastFightAt >= R.fightCooldownMs) {
      this._startFight(now);
    }
  }

  _startFight(now) {
    this.fighting = true;
    this.fightUntil = now + R.makeUpAfterMs;   // 至少 5 分钟后才允许和好（§16）
    this.lastFightAt = now;
    this.runtime.states.get(1).stats.fights += 1;
    this.runtime.states.get(2).stats.fights += 1;
    const mem = this.runtime.engines && this.runtime.engines.memory;
    if (mem) { mem.record(1, 'fight'); mem.record(2, 'fight'); }
    // 数值结算（§15）：friendship -3 / affection -2 / mood -5（影子层）
    this.friendship = Math.max(0, this.friendship - R.fightFriendshipLoss);
    this.affection = Math.max(0, this.affection - R.fightAffectionLoss);
    const s1 = this.runtime.states.get(1), s2 = this.runtime.states.get(2);
    s1.mood = Math.max(0, s1.mood - R.fightMoodLoss);
    s2.mood = Math.max(0, s2.mood - R.fightMoodLoss);
    // 两只互相生气（小白窗口演双狗画面由主进程编排，这里只做单狗生气动作）
    this.sendToPet(1, { type: 'act', act: 'wrong' });
    this.sendToPet(1, { type: 'say', text: '哼！不理你了！', ms: 1600 });
    this.sendToPet(2, { type: 'act', act: 'wrong' });
    this.sendToPet(2, { type: 'say', text: '我生气了！', ms: 1600 });
  }

  _makeUp(now) {
    this.fighting = false;
    // 数值结算（§16）：friendship +5 / affection +5 / mood +8
    this.friendship = Math.min(100, this.friendship + R.makeUpFriendshipGain);
    this.affection = Math.min(100, this.affection + R.makeUpAffectionGain);
    const s1 = this.runtime.states.get(1), s2 = this.runtime.states.get(2);
    s1.mood = Math.min(100, s1.mood + R.makeUpMoodGain);
    s2.mood = Math.min(100, s2.mood + R.makeUpMoodGain);
    this.runtime.states.get(1).stats.makeups += 1;
    this.runtime.states.get(2).stats.makeups += 1;
    const mem = this.runtime.engines && this.runtime.engines.memory;
    if (mem) { mem.record(1, 'makeup'); mem.record(2, 'makeup'); }
    this.sendToPet(1, { type: 'act', act: 'rub' });
    this.sendToPet(1, { type: 'say', text: '好啦好啦 和好啦～', ms: 1600 });
    this.sendToPet(2, { type: 'act', act: 'excited' });
    this.sendToPet(2, { type: 'say', text: '我们还是好朋友！', ms: 1600 });
    this.lastMeetAt = now;                     // 和好也算一次「互动」
  }

  /** 关系快照（控制台 Phase 8 用 / 存档） */
  snapshot() {
    return {
      affection: Math.round(this.affection),
      friendship: Math.round(this.friendship),
      jealousy: { 1: Math.round(this.jealousy[1]), 2: Math.round(this.jealousy[2]) },
      fighting: this.fighting,
      lastMeetAt: this.lastMeetAt,
    };
  }

  /** 从存档恢复关系数值（core/index.js init 调用） */
  restore(saved) {
    if (!saved) return;
    const n = (v, d) => (Number.isFinite(Number(v)) ? Math.min(100, Math.max(0, Number(v))) : d);
    this.affection = n(saved.affection, this.affection);
    this.friendship = n(saved.friendship, this.friendship);
    if (saved.jealousy) {
      this.jealousy[1] = n(saved.jealousy[1], this.jealousy[1]);
      this.jealousy[2] = n(saved.jealousy[2], this.jealousy[2]);
    }
    this.fighting = !!saved.fighting;
  }
}

function create(runtime, opts) {
  return new RelationshipEngine(runtime, opts);
}

module.exports = { RelationshipEngine, create };
