'use strict';
/* 爪印层 preload：只暴露收印接口。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fpBridge', {
  onAdd: (fn) => ipcRenderer.on('fp:add', (_e, d) => fn(d)),
});
