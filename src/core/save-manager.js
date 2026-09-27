'use strict';
/* =============================================================================
   线条小狗桌宠 V2 —— 存档管理（save-manager.js）
   -----------------------------------------------------------------------------
   新系统的存档（userData/line-dog-v2.json）：
     · saveVersion 字段标识 schema 版本
     · 损坏恢复：读失败/字段缺失 → 回退默认并备份损坏文件为 *.corrupt-<ts>.json
     · 原子写入：先写 .tmp 再 rename，避免写一半断电损坏
     · 分狗存储：states.1 / states.2 各自独立
   与旧系统的 desktop-pet.json（官方设置）**并存不冲突**：旧文件不动，
   新系统只读写自己的文件（规范 §45：兼容层保留）。
   ============================================================================= */

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

const SAVE_VERSION = CONFIG.schemaVersion;

class SaveManager {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, CONFIG.save.file);
  }

  /** 读取存档；损坏/不存在 → 返回默认结构（并把损坏文件备份起来） */
  load(defaultData) {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      return this._fresh(defaultData);       // 不存在 → 全新
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') throw new Error('not an object');
      if (data.saveVersion !== SAVE_VERSION) {
        // 版本不符 → 保留旧数据字段能用的部分，其它回退默认
        const merged = this._fresh(defaultData);
        Object.assign(merged, data);
        merged.saveVersion = SAVE_VERSION;
        return merged;
      }
      return data;
    } catch (e) {
      // 损坏 → 备份 + 回退默认
      try {
        const bak = this.file + '.corrupt-' + Date.now() + '.json';
        fs.renameSync(this.file, bak);
        if (process.env.GOOSE_DEBUG) console.warn('[save] corrupt save backed up to', bak);
      } catch (_) { /* 备份失败不阻塞恢复 */ }
      return this._fresh(defaultData);
    }
  }

  /** 原子保存 */
  save(data) {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      if (process.env.GOOSE_DEBUG) console.error('[save] write failed:', e.message);
      return false;
    }
  }

  _fresh(defaultData) {
    return Object.assign({ saveVersion: SAVE_VERSION, savedAt: null }, defaultData || {});
  }
}

module.exports = { SaveManager, SAVE_VERSION };
