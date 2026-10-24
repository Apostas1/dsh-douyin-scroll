/**
 * dsh-deskpet Windows 壳 —— 透明置顶 Electron 窗加载 pet-page（参考
 * Andersen216/dsh-whale-girl-live2d desktop/windows 的成熟实现，MIT）。
 *
 * 架构：main.js（窗口管理/穿透判定/托盘）+ preload.js（桥）+ pet-page（她全部行为）。
 * 配置/意图仍走文件通道：preload 暴露 petStateRead()/petCmdWrite()，
 * 宿主 douyin-scroll 的 keeper 每 10 秒写状态/读意图 —— 跟 WPF 版同一套协议。
 */
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const HOME = process.env.DOUYIN_HOME || path.join(process.env.APPDATA || os.homedir(), 'douyin-duty')
const STATE_FILE = path.join(HOME, 'pet-window-state.json')
const CMD_FILE = path.join(HOME, 'pet-cmd.json')
const HIDE_FILE = path.join(HOME, 'pet-hide.json')
const POS_FILE = path.join(HOME, 'pet-window-pos.json')
const LOG = path.join(os.homedir(), '.dsh', 'deskpet-boot.log')
const log = (m) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`) } catch {} }

let win = null
let tray = null
let pollTimer = null
let dragging = false
let pointerHeld = false
let mouseOverUI = false        // 渲染进程判定：光标下是面板/菜单
let quitRequested = false
let lastHit = 'none'

// 状态文件读取（剥 BOM —— PS5.1 教训，虽然这里都是 Node 写的，防手滑）
function readJson(p, fb) {
  try { return JSON.parse(String(fs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, '')) } catch { return fb }
}
function cfg() { return readJson(STATE_FILE, null) }

function clampToDisplays(x, y, w, h) {
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  const minX = Math.min(...areas.map((a) => a.x)), maxX = Math.max(...areas.map((a) => a.x + a.width))
  const minY = Math.min(...areas.map((a) => a.y)), maxY = Math.max(...areas.map((a) => a.y + a.height))
  return {
    x: Math.max(minX, Math.min(x, maxX - w)),
    y: Math.max(minY, Math.min(y, maxY - h)),
  }
}
function savePos() {
  try { fs.writeFileSync(POS_FILE, JSON.stringify({ X: win.getPosition()[0], Y: win.getPosition()[1] })) } catch {}
}

function createMain() {
  const saved = readJson(POS_FILE, null)
  const wa = screen.getPrimaryDisplay().workArea
  const pos = (saved && Number.isFinite(saved.X)) ? { x: saved.X, y: saved.Y } : { x: wa.x + wa.width - 230, y: wa.y + wa.height - 290 }
  const safe = clampToDisplays(pos.x, pos.y, 200, 260)

  win = new BrowserWindow({
    x: safe.x, y: safe.y,
    width: 200, height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,   // 🔴 别漏：后台也要跑动画（whale-girl 同款）
      webSecurity: false,            // 🔴 本地壳专用：file:// 下要 fetch PSD/wav（目录都在本机，无安全面）
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')   // 🔴 三处时机之一（创建时）
  win.setIgnoreMouseEvents(true, { forward: true })   // 默认穿透，poll 判定后切换
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, '..', 'pet-page', 'index.html'))
  win.once('ready-to-show', () => {
    win.setAlwaysOnTop(true, 'screen-saver')   // 时机之二
    win.showInactive()
  })
  win.on('moved', () => { if (savePosT) return; savePosT = setTimeout(savePos, 400) })   // 节流存位
  win.on('closed', () => { win = null })
  if (savePosT) { clearTimeout(savePosT); savePosT = null }
}
let savePosT = null

/* ── 穿透判定（whale-girl 的 90ms 轮询模式）──
 * 出界 → 直接穿透（省 IPC）；界内 → 问渲染进程「光标下是啥」：
 *   'ui'   = 泡泡/菜单/聊天面板等网页 UI → 不穿透（能点）
 *   'pet'  = 她的身体（包围盒判定，alpha 掩码 v2 再说）→ 不穿透（能拖/能戳）
 *   'none' = 空白 → 穿透
 * 拖动中 / 左键按住时不切（防抽搐），30 秒兜底。
 */
function startPoll() {
  pollTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return
      if (dragging || pointerHeld) return
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
      if (!inside) { setIgnore(true); return }
      win.webContents.executeJavaScript(
        `window.__hitKind ? window.__hitKind(${p.x - b.x}, ${p.y - b.y}) : 'pet'`, true
      ).then((kind) => {
        lastHit = kind || 'pet'
        setIgnore(lastHit === 'none')
      }).catch(() => {})
    } catch {}
  }, 90)
}
function setIgnore(ignored) {
  try {
    const cur = win.isIgnoringMouseEvents ? win.isIgnoringMouseEvents() : null
    if (ignored === cur) return
    win.setIgnoreMouseEvents(ignored, { forward: true })
  } catch {}
}

/* ── 渲染进程 ↔ 主进程桥 ── */
ipcMain.on('hit-kind', (e, kind) => { lastHit = kind })
ipcMain.on('pointer-held', (e, held) => { pointerHeld = !!held })
ipcMain.on('cmd-write', (e, obj) => {
  // 窗口 → 宿主：意图文件（keeper 10 秒内应用）
  try { obj.at = new Date().toISOString(); fs.writeFileSync(CMD_FILE, JSON.stringify(obj)) } catch {}
})
ipcMain.handle('state-read', () => cfg())
ipcMain.handle('sfx', (e, which) => {
  // 播放音效：走系统播放（wmplayer COM），或者交给渲染层 <audio>——这里选渲染层，主进程只记
  try { win.webContents.executeJavaScript(`window.__sfx && window.__sfx('${which}')`, true) } catch {}
})
ipcMain.on('drag-start', (e, pos) => {
  // 🔴 whale-girl 的守卫：拖动开始瞬间重判一次命中（不能用 90ms 前的旧值）
  try {
    if (lastHit === 'none') return
    dragging = true
    const startX = pos.x, startY = pos.y
    const [wx, wy] = win.getPosition()
    const move = setInterval(() => {
      try {
        const p = screen.getCursorScreenPoint()
        const safe = clampToDisplays(wx + p.x - startX, wy + p.y - startY, win.getBounds().width, win.getBounds().height)
        win.setPosition(safe.x, safe.y)
      } catch {}
    }, 16)
    const end = () => {
      clearInterval(move); dragging = false
      try { fs.writeFileSync(POS_FILE, JSON.stringify({ X: win.getPosition()[0], Y: win.getPosition()[1] })) } catch {}
      app.removeListener('mouseup', end)
    }
    // Electron 没有全局 mouseup —— 用渲染进程的 drag-end 消息
    ipcMain.once('drag-end', end)
    setTimeout(() => { try { app.removeListener('drag-end', end) } catch {} }, 30_000)
  } catch { dragging = false }
})
ipcMain.on('drag-end', () => { dragging = false })

function createTray() {
  try {
    // 托盘图标：用一张 1×1 透明 PNG 兜底也行，但至少有菜单
    tray = new Tray(path.join(__dirname, '..', 'assets', 'pet', 'sprite', '_preview.png'))
    tray.setToolTip('桌宠（刷抖音）')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 藏起来', click: () => { if (win) { win.isVisible() ? win.hide() : win.showInactive() } } },
      { label: '回到右下角', click: () => { const wa = screen.getPrimaryDisplay().workArea; if (win) win.setPosition(wa.x + wa.width - 230, wa.y + wa.height - 290) } },
      { type: 'separator' },
      { label: '退出', click: () => { quitRequested = true; app.quit() } },
    ]))
    tray.on('click', () => { if (win) win.isVisible() ? win.hide() : win.showInactive() })
  } catch (e) { log(`托盘起不来（不影响她）：${e.message}`) }
}

/* ── 宿主联动：petOn=false / hide 时自退（面板再开 = keeper 重拉）── */
function startStateWatch() {
  pollTimer = setInterval(() => {
    try {
      if (quitRequested) return
      if (fs.existsSync(HIDE_FILE)) { if (win) win.close(); return }
      const j = cfg()
      if (j && j.on === false) { if (win) win.close() }
    } catch {}
  }, 5000)
}

app.whenReady().then(() => {
  log('壳启动')
  createMain()
  createTray()
  startPoll()
  startStateWatch()
})
app.on('window-all-closed', () => { app.quit() })
process.on('uncaughtException', (e) => log(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => log(`unhandled: ${e}`))
