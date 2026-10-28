import { resolve, win32 } from 'node:path'

export function ownsProfile(args, profile, platform = process.platform) {
  const flag = args.findIndex(arg => String(arg).startsWith('--user-data-dir=' ) || arg === '--user-data-dir')
  if (flag < 0) return false
  const raw = args[flag] === '--user-data-dir' ? args[flag + 1] : args[flag].slice('--user-data-dir='.length)
  if (!raw) return false
  const normalize = value => platform === 'win32' ? win32.resolve(value).toLowerCase() : resolve(value)
  return normalize(raw) === normalize(profile)
}

export function localDebuggerUrl(value, port) {
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && Number(url.port) === Number(port) && !url.username && !url.password
  } catch { return false }
}

/** Bounded CDP transport shared by browser and page sessions. */
export async function connectCdp(url, port, timeout = 10000) {
  if (!localDebuggerUrl(url, port)) throw new Error('拒绝连接非本机或端口不匹配的 CDP 地址')
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  const fail = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP 连接已关闭')) }
    pending.clear()
  }
  ws.addEventListener('close', fail)
  ws.addEventListener('error', fail)
  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data) } catch { return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id); clearTimeout(p.timer)
    msg.error ? p.reject(new Error(msg.error.message || 'CDP 请求失败')) : p.resolve(msg.result)
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 连接超时')) }, timeout)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }, { once: true })
    ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP 连接已关闭')) }, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id
        const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`CDP 请求超时：${method}`)) }, timeout)
        pending.set(mid, { resolve, reject, timer })
        try { ws.send(JSON.stringify({ id: mid, method, params })) }
        catch (error) { clearTimeout(timer); pending.delete(mid); reject(error) }
      })
    },
    close() { fail(); ws.close() },
  }
}

/** A responding debugging port alone is never evidence of profile ownership. */
export async function probeBrowser(port, profile, { fetcher = fetch, connect = connectCdp } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  let c
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    if (!res.ok) return null
    const info = await res.json()
    if (!localDebuggerUrl(info.webSocketDebuggerUrl, port)) return null
    c = await connect(info.webSocketDebuggerUrl, port, 1000)
    const { arguments: args = [] } = await c.send('Browser.getBrowserCommandLine')
    if (!ownsProfile(args, profile)) return null
    return { port, wsUrl: info.webSocketDebuggerUrl, headless: args.some(arg => /^--headless(?:=|$)/.test(arg)) }
  } catch { return null }
  finally { c?.close() }
}

export const isDouyinDomain = value => /^(?:[a-z0-9-]+\.)*douyin\.com$/i.test(String(value || '').replace(/^\./, ''))
export const isDouyinUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && isDouyinDomain(u.hostname) } catch { return false } }
