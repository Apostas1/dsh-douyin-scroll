/**
 * dsh-deskpet preload —— 渲染进程（pet-page）跟主进程的唯一桥
 * （whale-girl 的 contextBridge 模式：页面无 Node 权限，只拿这几个口）
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshpetBridge', {
  /** 读宿主状态文件（pet-window-state.json，宿主 10 秒一写） */
  stateRead: () => ipcRenderer.invoke('state-read'),
  /** 写意图文件（右键菜单 → 宿主 keeper 10 秒内应用） */
  cmdWrite: (obj) => ipcRenderer.send('cmd-write', obj),
  /** 音效（主进程转发回渲染层播——这里直接交给页面，页面用 Audio 播本地 wav） */
  sfx: (which) => ipcRenderer.send('sfx', which),
  /** 拖动：页面 mousedown 她的身体 → 主进程搬窗口 */
  dragStart: (pos) => ipcRenderer.send('drag-start', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),
  /** 告诉主进程「左键还按着」（穿透切换的守卫） */
  pointerHeld: (held) => ipcRenderer.send('pointer-held', held),
})
