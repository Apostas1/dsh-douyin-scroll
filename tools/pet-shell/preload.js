/**
 * dsh-deskpet preload —— 渲染进程（pet-page）跟主进程的唯一桥
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshpetBridge', {
  stateRead: () => ipcRenderer.invoke('state-read'),
  cmdWrite: (obj) => ipcRenderer.send('cmd-write', obj),
  sfx: (which) => ipcRenderer.send('sfx', which),
  dragStart: (pos) => ipcRenderer.send('drag-start', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),
  pointerHeld: (held) => ipcRenderer.send('pointer-held', held),
})
