'use strict';
/* 宠物窗的 preload —— 只暴露这一个宠物用得着的白名单，页面拿不到 require。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petDesktop', {
  // ---- 页面 → 主进程 ----
  ready:     () => ipcRenderer.send('pet:ready'),
  report:    (snap) => ipcRenderer.send('pet:report', snap),
  hover:     (on) => ipcRenderer.send('pet:hover', !!on),
  dragStart: (center) => ipcRenderer.send('pet:drag-start', center),
  dragMove:  () => ipcRenderer.send('pet:drag-begin'),   // 主进程按光标屏幕坐标搬窗口
  dragEnd:   () => { ipcRenderer.send('pet:drag-stop'); ipcRenderer.send('pet:drag-end'); },
  action:    (act) => ipcRenderer.send('pet:action', act),
  easterEgg: () => ipcRenderer.send('pet:easter-egg'),
  openConsole: () => ipcRenderer.send('console:open'),
  // ---- 线条小狗捣蛋桥 ----
  gooseAct:    (act) => ipcRenderer.send('goose:act', act),
  gooseAction: (msg) => ipcRenderer.send('goose:action', msg),
  quit:      () => ipcRenderer.send('app:quit'),

  // ---- 主进程 → 页面 ----
  onCommand: (fn) => ipcRenderer.on('pet:command', (_e, msg) => fn(msg)),
});