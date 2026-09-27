'use strict';
/* 表情包弹窗 preload：只暴露关闭按钮通道。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memeBridge', {
  close: () => ipcRenderer.send('meme:close'),
});
