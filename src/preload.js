const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sobes', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  ask: (text) => ipcRenderer.invoke('ask', text),
  askScreen: (text) => ipcRenderer.invoke('ask-screen', text),
  transcribe: (buffer) => ipcRenderer.invoke('transcribe', buffer),
  hide: () => ipcRenderer.send('hide'),
  // Generic channels so feature modules can add IPC without editing this file.
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args)),
});
