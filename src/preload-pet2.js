'use strict';
/* 第二只小狗（小白）的 preload。
   **为什么单独一份**：主进程是「按通道分发」的，两扇宠物窗共用 preload-pet.js
   的话，摸小白的 hover / 拖动会被当成小金毛的，摸哪只都动同一只。
   所以小白的消息全部走 pet2:* 通道，第一只那边一行都不用改。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet2Desktop', {
  // ---- 页面 → 主进程 ----
  ready:     () => ipcRenderer.send('pet2:ready'),
  report:    (snap) => ipcRenderer.send('pet2:report', snap),
  hover:     (on) => ipcRenderer.send('pet2:hover', !!on),
  dragStart: () => ipcRenderer.send('pet2:drag-start'),
  dragMove:  () => ipcRenderer.send('pet2:drag-begin'),   // 主进程按光标屏幕坐标搬窗口
  dragEnd:   () => { ipcRenderer.send('pet2:drag-stop'); ipcRenderer.send('pet2:drag-end'); },
  action:    (act) => ipcRenderer.send('pet2:action', act),
  easterEgg: () => ipcRenderer.send('pet2:easter-egg'),
  openConsole: () => ipcRenderer.send('pet2:open-console'),

  // ---- 线条小狗捣蛋桥（与 preload-pet.js 对应，消息走同名通道）----
  gooseAct:    (act) => ipcRenderer.send('goose:act', act),
  gooseAction: (msg) => ipcRenderer.send('goose:action', msg),

  // ---- 主进程 → 页面 ----
  onCommand: (fn) => ipcRenderer.on('pet2:command', (_e, msg) => fn(msg)),
});
