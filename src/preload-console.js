'use strict';
/* 宠物控制台窗的 preload —— 与宠物窗各用一份，互不越权。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petConsole', {
  // ---- 控制台 → 主进程 ----
  // target：1 = 小金毛（默认，老通道不动）、2 = 小白（走 console2:* 通道）。
  // 动作和设置都带 target：控制台当前标签是哪只，就操作哪只。
  act:     (act, target) => ipcRenderer.send(target === 2 ? 'console2:act' : 'console:act', act),
  set:     (key, value, target) => ipcRenderer.send(target === 2 ? 'console2:set' : 'console:set', { key, value }),
  selectTab: (target) => ipcRenderer.send('console:tab', target === 2 ? 2 : 1),
  request: () => ipcRenderer.send('console:request-snapshot'),
  info:    () => ipcRenderer.invoke('app:info'),
  quit:    () => ipcRenderer.send('app:quit'),

  // ---- 主进程 → 控制台 ----
  onSnapshot: (fn) => ipcRenderer.on('console:snapshot', (_e, s) => fn(s)),
  onSelectPet: (fn) => ipcRenderer.on('console:select-pet', (_e, target) => fn(target)),
});