'use strict';
/* 桌面球门那扇窗的 preload —— 只需要「收比分」这一条通道。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goalDesk', {
  request: () => ipcRenderer.send('goal:request'),
  onState: (fn) => ipcRenderer.on('goal:state', (_e, s) => fn(s)),
});