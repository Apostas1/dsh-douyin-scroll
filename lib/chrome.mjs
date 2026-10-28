/**
 * lib/chrome.mjs —— 插件里**唯一**的浏览器入口
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，9 个脚本各自写一份 `C:\Program Files\Google\Chrome\...` +
 *   各自的 `ensureChrome()` + 各自的 `new WebSocket(CDP)`。
 *   换台设备（Chrome 装在别的盘 / 只有 Edge）就全部静默失效。
 *
 * 这里统一做四件事：
 *   ① 找浏览器：DOUYIN_BROWSER → Chrome → Edge → Chromium（Windows / macOS / Linux 全试）
 *   ② 找端口：runtime.json 里记着就用它，否则从 9334 往上找空闲的（被占就换，别让用户改代码）
 *   ③ 起无头 Chrome（`--headless=new`，屏幕上无窗口），已起就复用
 *   ④ 连 CDP，给一个带 send/ev/close 的小客户端
 *
 * ⚠️ 规矩：`tools/` 下**任何**脚本都不许自己 `new WebSocket` 或写死 chrome.exe。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { profileDir, readRuntime, writeRuntime } from './paths.mjs'
import { probeBrowser, connectCdp, isDouyinUrl } from './browser-ownership.mjs'
import { createTaskPage } from './task-page.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────────── ① 找浏览器 ───────────────────────── */

const CANDIDATES = () => {
  const out = []
  const env = String(process.env.DOUYIN_BROWSER || '').trim()
  if (env) out.push(env)                                  // ① 用户显式指定，最高优先
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files', 'D:\\Program Files (x86)']
    for (const r of roots.filter(Boolean)) {
      out.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      out.push(join(r, 'Chromium', 'Application', 'chrome.exe'))
    }
    // 免安装版常见位置
    for (const r of roots.filter(Boolean)) out.push(join(r, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return out
}

/** 找得到就返回绝对路径，找不到返回 ''（不抛，让 doctor 去报） */
export function findBrowser() {
  for (const p of CANDIDATES()) {
    try { if (p && existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return ''
}

/* ───────────────────────── ② 找端口 ───────────────────────── */

const portFree = (port) => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(port, '127.0.0.1')
})

/** Discover only browsers whose command line names our exact profile. */
export async function ownedBrowsers() {
  const runtime = readRuntime()
  const ports = new Set([Number(process.env.IM_CDP_PORT), Number(process.env.QR_CDP_PORT),
    Number(runtime.cdpPort), Number(runtime.qrPort), ...Array.from({ length: 80 }, (_, i) => 9334 + i)])
  const results = await Promise.all([...ports].filter(p => p > 0).map(p => probeBrowser(p, profileDir())))
  return results.filter(Boolean)
}

export async function closeOwnedBrowser(port) {
  const owned = await probeBrowser(Number(port), profileDir())
  if (!owned) throw new Error('无法确认该浏览器属于本插件，未执行关闭。请手动关闭旧版插件浏览器，再重新扫码登录。')
  const c = await connectCdp(owned.wsUrl, port)
  try { await c.send('Browser.close').catch(error => { if (!/连接已关闭/.test(error.message)) throw error }) }
  finally { c.close() }
  for (let i = 0; i < 40; i++) { if (await portFree(port)) return; await sleep(100) }
  throw new Error('插件浏览器尚未退出，请关闭插件浏览器后重试')
}

/** Forced ports are subject to exactly the same ownership checks. */
export async function pickPort({ headless = true } = {}) {
  const raw = process.env[headless ? 'IM_CDP_PORT' : 'QR_CDP_PORT']
  if (raw) {
    const forced = Number(raw)
    if (!Number.isInteger(forced) || forced < 1 || forced > 65535) throw new Error('CDP 端口必须为 1–65535 的整数')
    if (await probeBrowser(forced, profileDir()) || await portFree(forced)) return forced
    throw new Error('指定的 CDP 端口被占用且无法验证 profile，拒绝复用')
  }
  const owned = await ownedBrowsers()
  if (owned.length) return owned[0].port
  const start = headless ? 9334 : 9374
  for (let p = start; p < start + 40; p++) if (await portFree(p)) return p
  throw new Error('找不到空闲的插件浏览器调试端口')
}

export async function waitForBrowser(child, port, { probe = () => probeBrowser(port, profileDir()), wait = sleep, attempts = 60 } = {}) {
  let failed = ''
  const onError = error => { failed = `浏览器启动失败：${error.code || error.message}` }
  const onExit = (code, signal) => { failed = `浏览器在 CDP 就绪前退出（exit=${code}, signal=${signal || 'none'}）。配置可能被旧 Chrome/Edge 进程占用；请关闭使用本插件 profile 的浏览器后重试。` }
  child.once('error', onError)
  child.once('exit', onExit)
  try {
    for (let i = 0; i < attempts; i++) {
      if (failed) throw new Error(failed)
      const owned = await probe()
      if (failed) throw new Error(failed)
      if (owned) return owned
      await wait(500)
    }
    throw new Error('浏览器启动等待超时（30 秒）；请检查浏览器版本、profile 占用和调试端口')
  } finally {
    child.removeListener('exit', onExit)
    // Retain an error listener: detached ChildProcess errors must never crash the host.
  }
}

export async function ensureChrome({ url = 'https://www.douyin.com/', headless = true } = {}) {
  const port = await pickPort({ headless })
  const owned = await probeBrowser(port, profileDir())
  if (owned) {
    if (owned.headless === headless) return { port, status: 'reused', browser: readRuntime().browser || '' }
    if (!headless) {
      const error = new Error('后台浏览器占用插件 profile，请先关闭后台浏览器再扫码')
      error.conflict = 'profile_in_use'; error.can_kill = true
      throw error
    }
    // A successful QR login uses the same profile; switch only the verified instance to headless.
    await closeOwnedBrowser(port)
    await sleep(500)
  }
  const browser = findBrowser()
  if (!browser) throw new Error('找不到 Chrome / Edge / Chromium；请安装浏览器，或设置 DOUYIN_BROWSER 为可执行文件路径')
  const profile = profileDir()
  mkdirSync(profile, { recursive: true })
  const child = spawn(browser, [
    ...(headless ? ['--headless=new'] : []), '--enable-automation',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--lang=zh-CN', url,
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  await waitForBrowser(child, port)
  writeRuntime({ [headless ? 'cdpPort' : 'qrPort']: port, browser })
  return { port, status: 'launched', browser }
}

export async function connectPage(port, { targetId } = {}) {
  const usePort = Number(port) || await pickPort()
  if (!await probeBrowser(usePort, profileDir())) throw new Error('无法验证浏览器 profile，拒绝读取页面或 Cookie；请关闭旧插件浏览器后重新登录')
  let page
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://127.0.0.1:${usePort}/json/list`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error('无法读取插件浏览器页面列表')
    const list = await res.json()
    page = list.find(t => t.type === 'page' && (targetId ? t.id === targetId : isDouyinUrl(t.url)))
    if (page) break
    await sleep(250) // CDP can become ready before the initial page target exists.
  }
  if (!page) throw new Error('插件浏览器中没有抖音页面，请重新打开插件登录窗口')
  const c = await connectCdp(page.webSocketDebuggerUrl, usePort, 30000)
  try { await c.send('Page.enable'); await c.send('Runtime.enable') }
  catch (error) { c.close(); throw error }
  const ev = async expr => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('抖音页面执行失败：' + String(r.exceptionDetails.text || '脚本异常'))
    return r.result?.value
  }
  return { ...c, ev, port: usePort }
}

export async function openPage(opts = {}) {
  const url = opts.url || 'https://www.douyin.com/'
  if (!isDouyinUrl(url)) throw new Error('插件任务页面仅允许抖音 HTTPS 地址')
  // Start with an inert tab; a long-lived /chat tab would keep stale IM state alive.
  const { port, status, browser } = await ensureChrome({ ...opts, url: 'about:blank' })
  const owned = await probeBrowser(port, profileDir())
  if (!owned) throw new Error('无法验证插件浏览器，拒绝创建任务页面')
  const control = await connectCdp(owned.wsUrl, port)
  let page
  try {
    page = await createTaskPage(control, { url, connect: targetId => connectPage(port, { targetId }) })
  } catch (error) { control.close(); throw error }
  const cleanup = async code => { await page.close().catch(() => {}); process.exit(code) }
  const onTerm = () => cleanup(143), onInt = () => cleanup(130)
  process.once('SIGTERM', onTerm)
  process.once('SIGINT', onInt)
  return { ...page, status, browser,
    async close() {
      process.removeListener('SIGTERM', onTerm)
      process.removeListener('SIGINT', onInt)
      const result = await page.close()
      if (!result.ok) console.error('[douyin-browser] 任务页面关闭失败；请在停用自动任务后检查插件浏览器')
      return result
    },
  }
}

/** A fresh document must initialize the page's signing SDK before any API request. */
export async function waitForPageSigner(page, { attempts = 40, wait = sleep } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await page.ev(`(() => {
      try { return typeof window.bdms === 'object' && !XMLHttpRequest.prototype.open.toString().includes('[native code]') }
      catch { return false }
    })()`)) return
    await wait(1000)
  }
  throw new Error('页面签名 SDK 未就绪，已停止请求；请检查网络或登录状态')
}

/* ───────────────────────── 体检（给 doctor 用） ───────────────────────── */

export async function chromeDoctor() {
  const browser = findBrowser()
  const remembered = Number(readRuntime().cdpPort || 0)
  const alive = remembered ? Boolean(await probeBrowser(remembered, profileDir())) : false
  const port = alive ? remembered : await pickPort().catch(() => 0)
  return {
    browser: browser || '',
    browser_found: Boolean(browser),
    cdp_port: port,
    cdp_alive: alive,
    profile: profileDir(),
    env_override: String(process.env.DOUYIN_BROWSER || ''),
  }
}

export { homedir }
