'use strict';
/* 桌面小球那扇窗的 preload —— 只有三个动作：拿起来 / 松开 / 收起来。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ballDesk', {
  grab:    () => ipcRenderer.send('ball:grab'),
  release: () => ipcRenderer.send('ball:release'),
  pickup:  () => ipcRenderer.send('ball:pickup'),   // 右键：把球收走，狗回去自己玩
});