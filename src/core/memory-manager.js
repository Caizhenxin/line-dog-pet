'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 记忆管理（memory-manager.js）
   -----------------------------------------------------------------------------
   每只狗的「记忆」：环形缓冲（cap=200），记录它经历过的事——
     · action  自发/下发的行为
     · event   随机事件
     · interact 用户互动（摸头/喂食/控制台动作）
     · fight / makeup 吵架与和好
   记忆通过存档（line-dog-v2.json）随 saveVersion 持久化；控制台可读
   最近记忆（Phase 8）。memory-manager 自身只做记录与查询，不主动发起
   行为 —— 它是其它引擎的「记忆库」。
   ============================================================================= */

const { CONFIG } = require('./config');

class MemoryManager {
  /**
   * @param {object} runtime
   * @param {object} opts
   *   onMemory: (id, mem) => void   可选：记忆写入后的回调（如触发「想起某事」）
   */
  constructor(runtime, opts) {
    this.runtime = runtime;
    this.onMemory = (opts && opts.onMemory) || null;
  }

  /** 记录一条记忆 */
  record(id, type, detail) {
    const st = this.runtime.states.get(id);
    if (!st) return;
    const mem = { type, at: Date.now(), detail: detail || '' };
    st.history.push(mem);
    if (st.history.length > CONFIG.memory.cap) st.history.shift();
    if (this.onMemory) {
      try { this.onMemory(id, mem); } catch (e) { /* 回调失败不影响记忆写入 */ }
    }
    return mem;
  }

  /** 查询最近 N 条（type 可过滤） */
  recent(id, n, type) {
    const st = this.runtime.states.get(id);
    if (!st) return [];
    let list = st.history;
    if (type) list = list.filter((m) => m.type === type);
    return list.slice(-(n || 10));
  }

  /** 记忆统计（控制台 Phase 8 用） */
  stats(id) {
    const st = this.runtime.states.get(id);
    if (!st) return { total: 0, byType: {} };
    const byType = {};
    for (const m of st.history) byType[m.type] = (byType[m.type] || 0) + 1;
    return { total: st.history.length, byType };
  }

  /** 记忆固化由 runtime 统一负责（§33 debounce 3000ms + 60s autosave + before-quit）；
   *  本类只做记录与查询，不触发保存（规范第四章：MemoryManager 不重复负责自动保存） */
}

function create(runtime, opts) {
  return new MemoryManager(runtime, opts);
}

module.exports = { MemoryManager, create };
