'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 统一配置中心（CONFIG）
   -----------------------------------------------------------------------------
   V2 新系统的参数全部收拢到这里，一处改、全局生效。旧系统（官方逆向的
   main.js / index.html 原有参数）保持原位不动 —— 本文件只服务新系统，
   避免迁移过程中破坏既有功能（规范 §45：优先保证现有功能正常）。

   本版按《V2 改造执行规范》重新对齐参数：
     · 状态速率（§5）：hunger +0.8/min、boredom +0.6/min、energy -0.25/min
     · 行为决策（§7-§10）：每 5 秒一次、9 类基础权重 + 状态加权、防重复 cap 8
     · 双狗关系（§12/§15/§16）：friendship 初始 50、0~100、吵架/和好数值
     · 事件（§18/§19）：30s 检查、3min 冷却、每小时 4 次 / 每天 20 次、动态概率
     · Idle（§25/§26）：120s / 600s，决策间隔 15s / 30s
     · 存档（§33）：debounce 3000ms
     · 模式（§36）：normal / quiet / dnd（勿扰）
   ============================================================================= */

const CONFIG = {
  // 版本信息
  version: 2,
  schemaVersion: 1,             // 存档 schema 版本（save-manager 用）

  // -------------------------------------------------------------------------
  // 宠物状态系统（pet-state.js）
  // 节拍：每 30 秒结算一次影子状态。真源（mood/energy/hunger/clean/strain/
  // happiness）来自渲染端 100ms 汇报，主进程只负责「真源没有的量」：
  // boredom（无聊度）、idle（用户空闲）、影子衰减与门槛判断。
  // 速率对齐规范 §5：hunger +0.8/min、boredom +0.6/min、energy -0.25/min。
  // -------------------------------------------------------------------------
  state: {
    tickMs: 30000,              // 状态节拍间隔
    // 无聊度：影子量，0~100。无互动时每分钟 +0.6（规范 §5），即每节拍 +0.3；
    // 摸头/喂食/互动会重置。高于 boredAt 后行为决策倾向「找事做/发呆」。
    boredomRise: 0.3,           // 每节拍（30s）基础上升 = 0.6/min
    boredAt: 60,                // 无聊阈值（行为决策影子介入门槛）
    // 影子精力/饱腹衰减（仅供行为决策参考；页面真源仍以页面为准）
    shadowEnergyDecay: 0.125,   // 每节拍影子精力下降 = 0.25/min（规范 §5）
    shadowHungerRise: 0.4,      // 每节拍影子饥饿上升 = 0.8/min（规范 §5）
    // 亲密度（intimacy）：真源为页面 happiness（可超 100），主进程影子仅做分档
    // 与事件用；规范 §6 的 0~100 模型与页面 happiness 体系冲突，按兼容层保留。
    intimacyTiers: [            // 分档名（与 console.html levelName 同阈值）
      { at: 0,   name: '刚认识' },
      { at: 20,  name: '有点熟' },
      { at: 45,  name: '好朋友' },
      { at: 70,  name: '超级黏人' },
      { at: 90,  name: '形影不离' },
      { at: 150, name: '心意相通' },
      { at: 300, name: '灵魂伴侣' },
      { at: 600, name: '一生相伴' },
      { at: 1200,name: '永远在一起' },
    ],
  },

  // -------------------------------------------------------------------------
  // 行为决策（behavior-engine，Phase 2 接入；§7-§10 对齐）
  // -------------------------------------------------------------------------
  behavior: {
    decisionInterval: 5000,     // 每 5 秒一次行为决策（§7）
    minActionDuration: 3000,    // 动作最短时长（页面动画约束参考）
    maxActionDuration: 15000,   // 动作最长时长（页面动画约束参考）
    sameActionCooldown: 15000,  // 同一动作冷却：最近一次 <15s → 权重 -80%（§10）
    maxSameActionInRow: 2,      // 连续两次后第三次禁止立即重复（§10）
    recentActionHistorySize: 8, // 行为防重复：保存最近 8 个（§10）
    recentDialogueHistorySize: 10, // 台词防重复：最近 10 条（§11，页面台词体系未接管，声明用）
    // 基础权重（§8 正常状态），抽象行为键
    baseWeights: {
      idle: 20, wander: 20, sit: 12, sleep: 5, look: 10,
      play: 8, interact: 8, partner: 7, prank: 3,
    },
    // 状态加权（§9）：test 通过 → add 加权重 / sub 减权重；force 直接强制
    mods: [
      { test: (st) => st.hunger >= 85, add: { foodSeeking: 60 } },   // 很饿：找食物 +60
      { test: (st) => st.hunger >= 70, add: { foodSeeking: 30 } },   // 饿：找食物 +30
      { test: (st) => st.energy <= 30, add: { sleep: 40, sit: 15 }, sub: { play: 15, wander: 10, prank: 5 } },
      { test: (st) => st.energy <= 15, force: 'sleep' },             // 精力耗尽：优先睡觉（§9）
      { test: (st) => st.boredom >= 80, add: { prank: 15 } },
      { test: (st) => st.boredom >= 60, add: { play: 25, interact: 15, partner: 15, wander: 10 } },
      { test: (st) => st.intimacy >= 70, add: { interact: 20, followUser: 10 } },
      { test: (st) => st.intimacy <= 20, sub: { interact: 10 } },
    ],
    // 抽象行为 → 页面动作（兼容层：V2 只下发页面认识的动作名）
    actMap: {
      idle: 'idle', wander: 'walk', sit: 'sit', sleep: 'sleep', look: 'sit',
      play: 'spin', interact: 'greet', partner: 'rub', prank: 'walk',
      foodSeeking: 'hungry', followUser: 'walk', approachUser: 'walk',
    },
    // 项目特有硬需求（兼容现有生命周期系统：清洁度）——服务现有功能
    washAt: 40,                 // clean <= 40 → 强制去洗
    sleepStrainAt: 76,          // strain >= 76 → 强制睡觉
  },

  // -------------------------------------------------------------------------
  // 双狗关系（relationship-engine，Phase 3 接入；§12/§15/§16 对齐）
  // -------------------------------------------------------------------------
  relationship: {
    tickMs: 5000,               // 关系节拍
    // 双狗好感（affection）：互动 +，吵架/吃醋 -，范围 0~100
    initAffection: 50,          // 初始好感（§12）
    meetGain: 2,                // 一次双狗互动好感 +（含自动/手动）
    meetGainComfort: 6,         // 安慰类互动额外 +
    decayAtMs: 10 * 60 * 1000,  // 超过 10 分钟无互动开始自然降温
    decayPerTick: 0.3,          // 每节拍自然降温
    // 双狗友谊（friendship）：0~100，初始 50（§12），互动 +，吵架 -，和好 +
    initFriendship: 50,         // 初始友谊（§12）
    friendshipGain: 1,          // 一次双狗互动友谊 +（普通）
    friendshipGainComfort: 2,   // 安慰类互动友谊 +
    // 吵架（§15）：friendship < fightAt 可能吵架
    fightAt: 30,                // 友谊低于此值容易吵架
    fightChance: 0.12,          // 每节拍吵架概率（条件满足时）
    fightCooldownMs: 10 * 60 * 1000,  // 吵架冷却 10 分钟
    fightFriendshipLoss: 3,     // 吵架友谊 -3
    fightAffectionLoss: 2,      // 吵架好感 -2
    fightMoodLoss: 5,           // 吵架心情 -5（影子层）
    // 和好（§16）：吵架后至少 5 分钟才允许和好
    makeUpAfterMs: 5 * 60 * 1000,     // 至少 5 分钟后
    makeUpFriendshipGain: 5,    // 和好友谊 +5
    makeUpAffectionGain: 5,     // 和好好感 +5
    makeUpMoodGain: 8,          // 和好心情 +8（影子层）
    // 吃醋（§17）：单狗被过度关注，另一只 jealousy 上升
    jealousyRise: 10,           // 冷落那只 jealousy +10（用户连续 3 次以上只摸一只）
    jealousyDecay: 2,           // 每节拍自然回落
    jealousActAt: 60,           // jealousy 至此触发「找存在感」（approachUser）
    jealousStrongAt: 80,        // jealousy 至此触发吃醋台词/挤开（影子预留）
    jealousCooldownMs: 10 * 60 * 1000, // 吃醋行为每 10 分钟最多一次（§17）
  },

  // -------------------------------------------------------------------------
  // 随机事件（event-engine，Phase 4 接入；§18/§19 对齐）
  // -------------------------------------------------------------------------
  event: {
    checkMs: 30000,             // 每 30 秒检查一次（§18）
    chance: 0.05,               // 基础触发概率 5%（§19）
    chanceIdle5m: 0.08,         // 用户连续 5 分钟没互动 → 8%
    chanceIdle10m: 0.12,        // 用户连续 10 分钟没互动 → 12%
    cooldownMs: 180000,         // 事件之间至少间隔 3 分钟（§18）
    hourCap: 4,                 // 普通事件每小时最多 4 次（§18）
    dayCap: 20,                 // 每天最多 20 次（§18）
  },

  // -------------------------------------------------------------------------
  // 用户空闲检测（idle 系统，Phase 6 接入；§25/§26 对齐）
  // -------------------------------------------------------------------------
  idle: {
    checkMs: 20000,             // 检测间隔
    idleAtMs: 120000,           // 120 秒没有用户操作 → quiet（§25）
    deepIdleAtMs: 600000,       // 600 秒 → dnd（§25）
    decisionInterval: 15000,    // quiet 时行为决策间隔 15 秒（§26）
    deepDecisionInterval: 30000, // dnd 时行为决策间隔 30 秒（§26）
  },

  // -------------------------------------------------------------------------
  // 记忆（memory-manager，Phase 5 接入）
  // 规范 §29 要求分类上限（events 30 / interactions 30 / actions 20）；
  // 当前实现为单环形 cap=200，与存档结构兼容，分类上限暂保留现状（见报告）。
  // -------------------------------------------------------------------------
  memory: {
    cap: 200,                   // 每狗记忆上限（环形覆盖）
    flushMs: 60000,             // 记忆固化到存档的间隔
  },

  // -------------------------------------------------------------------------
  // 存档（save-manager.js；§33 对齐）
  // -------------------------------------------------------------------------
  save: {
    file: 'line-dog-v2.json',   // 存档文件名（userData 下；与旧 desktop-pet.json 并存）
    autoSaveMs: 60000,          // 自动存档兜底间隔（防 debounce 窗口漏存）
    debounceMs: 3000,           // 状态变化后 3000ms 合并写一次（§33）
  },

  // -------------------------------------------------------------------------
  // 性能治理（Phase 7 接入）
  // -------------------------------------------------------------------------
  perf: {
    reportThrottleMs: 200,      // 控制台快照推送节流（当前 200ms，保持不变）
    consolePollMs: 1000,        // 控制台轮询间隔（现有 1000ms 保持）
  },

  // -------------------------------------------------------------------------
  // 模式（§36 对齐）：normal / quiet / dnd（勿扰）
  // quiet（安静）：主动台词 ×0.5、随机事件 ×0.5、捣蛋 ×0.25、主动靠近 ×0.5
  // dnd（勿扰）：主动台词 =0、随机事件 =0、主动捣蛋 =0、主动弹窗 =0；
  //              基础移动/睡觉/坐下/双狗互动仍允许
  // -------------------------------------------------------------------------
  quiet: {
    levels: ['normal', 'quiet', 'dnd'],   // 三模式枚举（idle-system 输出）
    quietMul: 4,                // quiet：捣蛋调度间隔 ×4 ≈ 概率 ×0.25（§24/§36）
    eventMul: 0.5,              // quiet：随机事件概率 ×0.5（§36）
    behaviorIdleInterval: 15000, // quiet：行为决策间隔 15s（§26）
    behaviorDeepInterval: 30000, // dnd：行为决策间隔 30s（§26）
    // dnd 时行为引擎仅允许的基础行为（§36：移动/睡觉/坐下/双狗互动）
    dndAllowed: ['idle', 'wander', 'sit', 'sleep', 'partner'],
  },
};

module.exports = { CONFIG };
