#!/usr/bin/env node
/**
 * tools/qr-login.mjs —— 抖音扫码登录（唯一允许开浏览器的场景）
 * ============================================================================
 * 子命令：
 *   start   启动一个**独立 profile 的有头 Chrome**，打开抖音、点开登录弹层，
 *           把二维码截成 PNG 存到家目录，并把窗口置顶。
 *   shot    再截一次屏（用户说看不到二维码时用）
 *   check   通过 CDP 读 cookie：有 sessionid 就导出 douyin_cookie.txt 并校验账号
 *   close   关掉这个 Chrome
 *
 * 关键设计：
 *   - profile 固定放在 D 盘  $DOUYIN_HOME/chrome-profile
 *     反复登录复用同一个 profile ⇒ 设备指纹稳定 ⇒ 少一道风控
 *   - 登录成功后**保留**这个 profile，以后 `check` 还能从里面读到 cookie
 *   - 全程只用 CDP，不依赖 bb-browser（那玩意儿会吃引号）
 * ============================================================================
 */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'
import { findBrowser } from '../lib/chrome.mjs'

const HOME = homeDir()
const PROFILE = join(HOME, 'chrome-profile')
const PORT = 9333
const CDP = `http://127.0.0.1:${PORT}`

// 扫码登录用**有头** Chrome，所以不走 lib/chrome.mjs 的 headless 流程，
// 但"找浏览器"这件事必须共用同一套探测逻辑（换台机器 Chrome 装在别处也能用）。
const CHROME = findBrowser()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${CDP}/json/list`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  throw new Error('CDP 端口没起来（' + CDP + '）')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    })
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej })
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
      close: () => ws.close(),
    }))
    ws.addEventListener('error', reject)
  })
}

async function pageConn() {
  const targets = await cdpTargets()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('douyin'))
    || targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没有 page target')
  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  return c
}

async function shoot(tag = 'login-qr') {
  const c = await pageConn()
  const b64 = (await c.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })).data
  const f = join(HOME, `${tag}.png`)
  writeFileSync(f, Buffer.from(b64, 'base64'))
  c.close()
  return f
}

const cmd = process.argv[2] || 'start'

if (cmd === 'start') {
  if (!CHROME) { console.error('找不到 chrome.exe'); process.exit(1) }
  mkdirSync(PROFILE, { recursive: true })
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--window-size=1280,900',
    '--window-position=120,60',
    'https://www.douyin.com/',
  ]
  const p = spawn(CHROME, args, { detached: true, stdio: 'ignore' })
  p.unref()
  console.log('chrome pid =', p.pid, '\nprofile =', PROFILE)

  const c = await pageConn()
  await sleep(3500)

  // 点开登录弹层（页面已经登录就跳过）
  const clickRes = await c.send('Runtime.evaluate', {
    expression: `(function(){
      var has = document.cookie.indexOf('sessionid=') >= 0;
      var els = Array.prototype.slice.call(document.querySelectorAll('div,span,button,a,p'));
      var hit = els.find(function(e){
        var t = (e.innerText||'').trim();
        return t === '登录' && e.offsetParent !== null;
      });
      if (hit && !has) { hit.click(); return 'clicked'; }
      return has ? 'already-logged-in' : (hit ? 'clicked' : 'no-login-button');
    })()`,
    returnByValue: true,
  })
  console.log('登录按钮:', clickRes.result?.value)
  await sleep(2500)

  // 找二维码位置
  const box = await c.send('Runtime.evaluate', {
    expression: `(function(){
      var cands = Array.prototype.slice.call(document.querySelectorAll('img,canvas'));
      var el = cands.find(function(e){
        var s = (e.currentSrc||e.src||'');
        var cls = (e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)||'';
        return /qrcode|qr_code|qr-code/i.test(s) || /qrcode|qr/i.test(String(cls));
      }) || null;
      if (!el) return '';
      var r = el.getBoundingClientRect();
      if (r.width < 60) return '';
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});
    })()`,
    returnByValue: true,
  })
  const raw = box.result?.value || ''
  let f
  if (raw) {
    const b = JSON.parse(raw)
    const b64 = (await c.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: b.x - 8, y: b.y - 8, width: b.w + 16, height: b.h + 16, scale: 3 },
    })).data
    f = join(HOME, 'login-qr.png')
    writeFileSync(f, Buffer.from(b64, 'base64'))
    console.log('二维码位置 =', raw)
  } else {
    f = await shoot('login-qr')
    console.log('⚠️ 没定位到二维码元素，截的是整屏')
  }
  c.close()

  // 置顶窗口
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
      `if($p){ $ws = New-Object -ComObject WScript.Shell; [void]$ws.AppActivate($p.Id); Write-Output ('front ' + $p.Id) } else { Write-Output 'no-window' }`],
      { encoding: 'utf8', timeout: 20000 })
    console.log('窗口:', out.trim())
  } catch (e) { console.log('置顶失败(不致命):', e.message) }

  console.log('QR ->', f)
}

if (cmd === 'shot') {
  const f = await shoot('login-qr')
  console.log('QR ->', f)
}

if (cmd === 'check') {
  const c = await pageConn()
  const { cookies } = await c.send('Network.getAllCookies')
  const names = cookies.map((x) => x.name)
  const key = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'passport_csrf_token', 'ttwid', 'msToken', 's_v_web_id']
  console.log('cookie 条数 =', cookies.length)
  console.log('关键项 =', key.filter((k) => names.includes(k)).join(', ') || '(无)')
  const hasSession = names.includes('sessionid') || names.includes('sessionid_ss')
  if (!hasSession) {
    console.log('❌ 还没有 sessionid —— 二维码还没扫，或扫了但没在手机上点「确认登录」')
    c.close()
    process.exitCode = 2
  } else {
    const dom = cookies.filter((x) => x.domain.includes('douyin'))
    const str = dom.map((x) => `${x.name}=${x.value}`).join('; ')
    const f = join(HOME, 'douyin_cookie.txt')
    writeFileSync(f, str, 'utf8')
    console.log('✅ 已写入', f, `(${str.length} 字符, ${dom.length} 条)`)
    c.close()
  }
}

if (cmd === 'close') {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*chrome*' } | ` +
      `Where-Object { (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.Id)).CommandLine -like '*chrome-profile*' } | Stop-Process -Force`],
      { encoding: 'utf8', timeout: 20000 })
    console.log('已关闭登录用 Chrome')
  } catch (e) { console.log('关闭失败:', e.message) }
}
