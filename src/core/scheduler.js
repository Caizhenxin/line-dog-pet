'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 统一调度器（scheduler.js）
   -----------------------------------------------------------------------------
   把 V2 新系统的周期任务收拢到一个 1 秒节拍里统一驱动：
     · 30s  状态结算（pet-state.tick）
     · 8s   行为决策（behavior-engine）
     · 5s   双狗关系（relationship-engine）
     · 15s  随机事件（event-engine）
     · 20s  用户空闲检测（idle）
     · 60s  记忆固化 / 自动存档
   旧系统的 setInterval（漫游/双狗互动/捣蛋调度）保持原位不迁移 —— 本调度器
   只驱动 V2 模块，避免两套节拍互相打架（规范 §45）。
   ============================================================================= */

const safeRun = (fn, name) => {
  try { fn(); }
  catch (e) { if (process.env.GOOSE_DEBUG) console.error('[scheduler] job "' + name + '" failed:', e); }
};

class Scheduler {
  constructor() {
    this.jobs = [];      // { ms, name, fn, last }
    this.timer = null;
  }

  /** 注册周期任务（ms 为间隔） */
  every(ms, name, fn) {
    this.jobs.push({ ms, name, fn, last: 0 });
    return this;
  }

  /** 立即执行一次某任务（不等待节拍） */
  runNow(name) {
    for (const j of this.jobs) {
      if (j.name === name) safeRun(j.fn, j.name);
    }
  }

  /** 秒级节拍（由 main.js 的 tick 或独立 setInterval 调用） */
  tick(now) {
    for (const j of this.jobs) {
      if (now - j.last >= j.ms) {
        j.last = now;
        safeRun(j.fn, j.name);
      }
    }
  }

  /** 启动（1 秒节拍） */
  start() {
    if (this.timer) return;
    const loop = () => {
      this.tick(Date.now());
      this.timer = setTimeout(loop, 1000);
    };
    this.timer = setTimeout(loop, 1000);
  }

  /** 停止（退出/测试用） */
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

module.exports = { Scheduler, safeRun };
