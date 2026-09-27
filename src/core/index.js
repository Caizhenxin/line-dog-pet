'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 运行时组装（core/index.js）
   -----------------------------------------------------------------------------
   main.js 只需要：
     const v2 = require('./core');
     v2.init(app.getPath('userData'));
     v2.onReport(1, snap);   // pet:report
     v2.onReport(2, snap);   // pet2:report
     v2.tick(Date.now());    // 主循环里调用
   后续引擎（behavior/relationship/event/memory/idle）按 Phase 依次挂进
   scheduler 即可，main.js 的接入点不再变。
   ============================================================================= */

const { CONFIG } = require('./config');
const { PetStateManager, restoreInto } = require('./pet-state');
const { Scheduler } = require('./scheduler');
const { SaveManager } = require('./save-manager');

class V2Runtime {
  constructor(userDataDir) {
    this.config = CONFIG;
    this.states = new PetStateManager();
    this.save = new SaveManager(userDataDir || '.');
    this.scheduler = new Scheduler();
    this.engines = {};                    // Phase 2+ 注册：{ name: engine }
    this.lastSavedAt = null;
    this._initJobs();
  }

  /** 注册一个 V2 引擎（行为/关系/事件/记忆…）并自动挂节拍 */
  register(name, engine) {
    this.engines[name] = engine;
    if (engine && engine.tickMs && engine.tick) {
      this.scheduler.every(engine.tickMs, name, () => engine.tick(Date.now()));
    }
    return this;
  }

  _initJobs() {
    // 状态节拍：影子量结算（30s）
    this.scheduler.every(CONFIG.state.tickMs, 'state-tick', () => {
      this.states.tick(Date.now());
      this._requestSave();                    // 状态变化 → debounce 合并写（§33）
    });
    // 自动存档兜底（60s，防 debounce 窗口漏存）
    this.scheduler.every(CONFIG.save.autoSaveMs, 'autosave', () => this._autoSave());
  }

  /** 启动：恢复存档 + 起调度（main.js 保证引擎 register 先于 init） */
  init() {
    const saved = this.save.load({ states: {} });
    if (saved && saved.states) {
      for (const id of [1, 2]) {
        const src = saved.states[String(id)];
        if (src) restoreInto(this.states.get(id), src);
      }
    }
    // 关系恢复（§32：relationships 随存档持久化）
    const rel = this.engines.relationship;
    if (rel && saved && saved.relationships) rel.restore(saved.relationships);
    this.scheduler.start();
    if (process.env.GOOSE_DEBUG) console.log('[v2] runtime init OK, schema v' + CONFIG.schemaVersion);
    return this;
  }

  /** 渲染端汇报 → 同步状态（pet:report / pet2:report 里调用） */
  onReport(id, snap) {
    this.states.sync(id, snap);
  }

  /** 用户互动记录（摸头/喂食/控制台动作） */
  recordInteract(id) {
    this.states.recordInteract(id);
    // 转发给关系引擎：用户摸/点了某只 → 吃醋失衡检测
    const rel = this.engines.relationship;
    if (rel && rel.onUserInteract) rel.onUserInteract(id);
    // 记忆：用户互动
    const mem = this.engines.memory;
    if (mem) mem.record(id, 'interact');
    // 空闲系统：用户在互动 = 活跃
    const idle = this.engines.idle;
    if (idle && idle.onInput) idle.onInput();
  }

  /** 秒级节拍（main.js tick 里调用） */
  tick(now) {
    this.scheduler.tick(now);
  }

  /** 退出：固化存档（§33：程序退出时立即保存一次） */
  shutdown() {
    this.scheduler.stop();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._autoSave();
  }

  /** 状态变化 → 请求保存（debounce 3000ms 合并写，§33） */
  _requestSave() {
    this._dirty = true;
    if (this._saveTimer) return;              // 已有等待中的合并写
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) { this._dirty = false; this._autoSave(); }
    }, CONFIG.save.debounceMs);
  }

  _autoSave() {
    const s = this.states.snapshot();
    const rel = this.engines.relationship;
    const data = {
      saveVersion: CONFIG.schemaVersion,
      savedAt: new Date().toISOString(),
      states: {
        1: this._pickPersist(s[1]),
        2: this._pickPersist(s[2]),
      },
      relationships: rel ? rel.snapshot() : null,   // §32：关系随存档持久化
    };
    if (this.save.save(data)) this.lastSavedAt = data.savedAt;
  }

  _pickPersist(st) {
    if (!st) return null;
    return {
      boredom: st.boredom,
      lastInteractAt: st.lastInteractAt,
      happiness: st.happiness,
      stats: st.stats,
      history: st.history,
    };
  }
}

module.exports = { V2Runtime, CONFIG };
