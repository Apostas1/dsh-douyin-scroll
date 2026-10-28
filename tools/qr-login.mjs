#!/usr/bin/env node
/**
 * tools/qr-login.mjs —— 抖音扫码登录（唯一允许开浏览器的场景）
 * ============================================================================
 * 子命令：
 *   start   启动一个**独立 profile 的有头 Chrome**，打开抖音、点开登录弹层，
 *           打开登录窗口，等待用户扫码；shot 可另存截图。
 *   shot    再截一次屏（用户说看不到二维码时用）
 *   check   通过 CDP 读 cookie：有 sessionid 就导出 douyin_cookie.txt 并校验账号
 *   close   关掉这个 Chrome
 *   watch   轮询直到扫码成功（面板"我扫完了"按钮用）——
 *           每 2 秒 check 一次，成功/超时/卡在验证 都返回结构化 JSON
 *
 * 关键设计：
 *   - profile 固定放在 $DOUYIN_HOME/chrome-profile
 *     反复登录复用同一个 profile ⇒ 设备指纹稳定 ⇒ 少一道风控
 *   - 登录成功后**保留**这个 profile，以后 `check` 还能从里面读到 cookie
 *   - 全程只用 CDP，不依赖 bb-browser（那玩意儿会吃引号）
 *
 * 🔴 2026-10-22 新增：**profile 互斥**
 *   登录用的 Chrome（有头）和干活用的 Chrome（无头）用的是**同一个 user-data-dir**。
 *   Chrome 不允许同一个 profile 起两个实例 ⇒ 后台无头浏览器还开着时，`start` 会
 *   起不来（新进程直接退出），而老代码只会傻等 60 秒再报"连不上 CDP"。
 *   现在起之前先检测：被占用就明确告诉你「先关掉后台那个」，并给出关闭方法。
 * ============================================================================
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'
import { ensureChrome, connectPage, ownedBrowsers, closeOwnedBrowser } from '../lib/chrome.mjs'
import { isDouyinDomain, probeBrowser } from '../lib/browser-ownership.mjs'
import { writeSecret } from '../lib/state.mjs'
import { redactDiagnostic } from '../lib/process-result.mjs'

const HOME = homeDir()
const PROFILE = join(HOME, 'chrome-profile')
/**
 * ⭐ 端口不再写死 9333：那会和"别的东西恰好占了 9333"冲突，而且 9333 不在
 *    lib/chrome.mjs 的扫描范围（9334–9373）里，两个模块各扫各的，谁也不认识谁。
 *    现在统一从 9374 往上找（避开无头那一段），或者用 QR_CDP_PORT 指定。
 */
let PORT = Number(process.env.QR_CDP_PORT || 0)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pageConn = () => connectPage(PORT)
const frontWindow = () => 'plugin-browser-open'

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

async function runStart() {
  const launch = await ensureChrome({ headless: false })
  PORT = launch.port
  saveQrPort()
  const c = await pageConn()
  await sleep(3500)

  /**
   * 🔴 判断"已经登录了吗"**不能用 `document.cookie`**：
   *    `sessionid` 是 HttpOnly，页面 JS 永远读不到它 ⇒ 永远判成"没登录"。
   *    （2026-10-22 实测：明明头像都在，却报 no-login-button，还截了张首页图）
   *    必须用 CDP 的 `Network.getAllCookies` —— 那是浏览器层面，能看到 HttpOnly。
   */
  let alreadyLoggedIn = false
  try {
    const { cookies } = await c.send('Network.getAllCookies')
    const names = cookies.filter(x => isDouyinDomain(x.domain)).map(x => x.name)
    alreadyLoggedIn = names.includes('sessionid') || names.includes('sessionid_ss')
  } catch { alreadyLoggedIn = false }

  // 点开登录弹层（已经登录就跳过）
  const clickRes = await c.send('Runtime.evaluate', {
    expression: `(function(){
      var els = Array.prototype.slice.call(document.querySelectorAll('div,span,button,a,p'));
      var hit = els.find(function(e){
        var t = (e.innerText||'').trim();
        return t === '登录' && e.offsetParent !== null;
      });
      if (hit) { hit.click(); return 'clicked'; }
      return document.querySelector('img[src*="aweme-avatar"], [class*="avatar"]') ? 'looks-logged-in' : 'no-login-button';
    })()`,
    returnByValue: true,
  })
  const loginState = String(clickRes.result?.value || '')
  console.log('登录按钮:', loginState, '/ cookie 里已有 sessionid:', alreadyLoggedIn)

  /**
   * ⭐ 2026-10-22 实测踩到：这个 Chrome profile 里**早就登录过了**（复用过很多次）。
   *    这时页面上根本没有「登录」按钮，也就没有二维码 —— 老代码会截一张首页截图当二维码给用户，
   *    用户看到一堆视频封面，完全不知道发生了什么。
   *    ⇒ 已经登录就**直接导出 Cookie**，别走二维码这条路。
   */
  if (alreadyLoggedIn) {
    const out = await doCheck()
    c.close()
    // 记端口（万一后面还要 check）
    saveQrPort()
    console.log(JSON.stringify({
      ok: true,
      already_logged_in: true,
      qr: '',
      ...out,
      hint: '这个浏览器里**已经登录过了**，不用扫码 —— 我直接把登录凭证导出来了，你现在就能用',
    }, null, 2))
    return
  }

  /**
   * 等登录弹层展开完。
   * ⭐ 2026-10-22 实测：抖音这个弹层是**异步渲染**的，而且慢（4 秒经常还不够）。
   *    太早点会点空、太早探测会得到 panel_ready=false，让用户以为没打开。
   *    ⇒ 轮询最多 20 秒，看到「扫码登录 / 请输入手机号」就算好了。
   */
  let layerOk = false
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    try {
      const probe = await c.ev(`(function(){
        var t = (document.body && document.body.innerText || '');
        return JSON.stringify({
          hasQrText: t.indexOf('扫码登录') >= 0 || t.indexOf('扫一扫') >= 0 || t.indexOf('打开「抖音APP」') >= 0,
          hasCanvas: !!document.querySelector('canvas'),
          hasPhone: t.indexOf('请输入手机号') >= 0,
        });
      })()`)
      const p = JSON.parse(probe || '{}')
      if (p.hasQrText || p.hasPhone) { layerOk = true; break }
      // 到第 6 秒还没出来，再点一次「登录」（第一次点可能落在未渲染完的按钮上）
      if (i === 5) {
        try {
          await c.ev(`(function(){
            var els = Array.prototype.slice.call(document.querySelectorAll('div,span,button,a,p'));
            var hit = els.find(function(e){ var t=(e.innerText||'').trim(); return t === '登录' && e.offsetParent !== null });
            if (hit) { hit.click(); return 'clicked' } return 'none';
          })()`)
        } catch { /* 点不到就算了，继续等 */ }
      }
    } catch { /* 读不到页面就继续等 */ }
  }
  c.close()

  // 返回窗口已打开的状态，不操作其他浏览器窗口。
  const front = frontWindow()

  // ⭐ 把端口记进 runtime.json —— 否则下一步 check 不知道去哪连（两个是独立进程）
  saveQrPort()

  console.log(JSON.stringify({
    ok: true,
    port: PORT,
    window: front,
    login_button: loginState,
    panel_ready: layerOk,
    hint: layerOk
      ? '浏览器窗口已经打开、登录框也出来了 —— 用手机抖音扫那个窗口里的二维码。扫完如果还要短信验证码/滑块，就在那个窗口里做完，回来点「我扫完了」'
      : '浏览器窗口已经打开了。如果没看到登录框，就在那个窗口里点一下右上角「登录」；二维码出来用手机扫，扫完回来点「我扫完了」',
  }, null, 2))
}

/** 登录用的浏览器开着吗？（没开就给一句人话，别抛栈） */
async function loginBrowserUp() {
  if (!PORT) return false
  const owned = await probeBrowser(PORT, PROFILE)
  return Boolean(owned && !owned.headless)
}

/**
 * 记住上次 `start` 用的端口 —— 不然 `check` 不知道去哪连
 * （PORT 每次进程重启都会重新算，跑 start 和 check 是两个独立进程）
 */
const RUNTIME_FILE = join(HOME, 'runtime.json')
function saveQrPort() {
  try {
    let cur = {}
    try { cur = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) || {} } catch { cur = {} }
    writeFileSync(RUNTIME_FILE, JSON.stringify({ ...cur, qrPort: PORT }, null, 2), 'utf8')
  } catch { /* 写不进去就每次重新找 */ }
}

/**
 * ⭐ 自动找回登录端口：先试记住的，再扫 9374–9413。
 *    这样 `check` / `shot` / `watch` 都不用用户传端口。
 */
async function discoverQrPort() {
  const owned = await ownedBrowsers()
  return owned.find(browser => !browser.headless)?.port || 0
}

const NOT_UP_MSG = [
  '登录用的浏览器还没开。',
  '  → 设置页点「扫码登录」，或命令行跑：node tools/qr-login.mjs start',
  '  → 扫完码如果抖音还要验证（短信 / 滑块），在**那个弹出的浏览器窗口里**做完',
  '  → 然后再点一次「我扫完了」（或跑 node tools/qr-login.mjs check）',
].join('\n')

/** check 的核心（被 check 和 watch 共用）：返回结构化结果，不直接打印 */
async function doCheck() {
  const c = await pageConn()
  try {
    const { cookies } = await c.send('Network.getAllCookies')
    const names = cookies.filter(x => isDouyinDomain(x.domain)).map(x => x.name)
    const key = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'passport_csrf_token', 'ttwid', 'msToken', 's_v_web_id']
    const hasSession = names.includes('sessionid') || names.includes('sessionid_ss')

    /**
     * ⭐ 扫完码之后抖音**可能还要过一道验证**（短信验证码 / 滑块 / 「换设备登录」确认）。
     *    以前这里只看 cookie：没过验证就永远读不到 sessionid，用户只看到「还没扫」，
     *    其实他已经扫了、卡在验证页 —— 白白重扫好几次。
     *    现在先看页面上有没有验证类元素，有就明确告诉他「你卡在这一步」。
     */
    let verifyKinds = []
    let pageHead = ''
    try {
      const probe = await c.ev(`(function(){
        var t = (document.body && document.body.innerText || '').replace(/\\s+/g,' ');
        var has = function(k){ return t.indexOf(k) >= 0 };
        var sms = has('验证码') || has('短信验证') || has('获取验证码') || has('后四位');
        var slide = has('拖动') || has('滑块') || has('请完成下方验证') || has('安全验证')
          || !!document.querySelector('[class*="captcha"],[id*="captcha"],[class*="slide-verify"]');
        var device = has('新设备') || has('换设备') || has('设备验证') || has('身份验证');
        var needPhone = has('绑定手机') || has('手机号');
        var kinds = [];
        if (sms) kinds.push('短信验证码');
        if (slide) kinds.push('滑块/拼图');
        if (device) kinds.push('新设备确认');
        if (needPhone) kinds.push('绑定手机号');
        return JSON.stringify({ kinds: kinds, head: t.slice(0, 220) });
      })()`)
      const p = JSON.parse(probe || '{}')
      verifyKinds = p.kinds || []
      pageHead = p.head || ''
    } catch { /* 读不到页面就跳过，不影响 cookie 判定 */ }

    if (!hasSession) {
      return {
        ok: false, logged_in: false,
        cookie_count: cookies.length,
        important: key.filter((k) => names.includes(k)),
        verify: verifyKinds,
        page_head: pageHead,
        hint: verifyKinds.length
          ? `二维码已经扫过了，但抖音还要你在那个浏览器窗口里完成：${verifyKinds.join(' / ')}。做完不用重扫，再点一次「我扫完了」就行`
          : '还没有 sessionid —— 二维码还没扫，或扫了但没在手机上点「确认登录」',
      }
    }

    const dom = cookies.filter(x => isDouyinDomain(x.domain))
    const str = dom.map((x) => `${x.name}=${x.value}`).join('; ')
    const f = join(HOME, 'douyin_cookie.txt')
    writeSecret(f, str)
    return {
      ok: true, logged_in: true,
      file: f, chars: str.length, cookies: dom.length,
      verify: verifyKinds,
      hint: `登录成功，凭证已保存（${dom.length} 条 Cookie）。${verifyKinds.length ? '（页面上还挂着验证提示，但登录态已经拿到了）' : ''}`,
    }
  } finally { c.close() }
}


try {
if (cmd === 'start') await runStart()
if (cmd === 'shot') {
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) { console.log(JSON.stringify({ ok: false, error: NOT_UP_MSG })); process.exit(2) }
  const f = await shoot('login-qr')
  console.log(JSON.stringify({ ok: true, qr: f }, null, 2))
}

if (cmd === 'check') {
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) {
    console.log(JSON.stringify({ ok: false, up: false, error: '登录用的浏览器还没开', hint: NOT_UP_MSG }, null, 2))
    process.exit(2)
  }
  const r = await doCheck()
  console.log(JSON.stringify({ ...r, up: true, port: PORT }, null, 2))
  process.exitCode = r.ok ? 0 : 2
}

/**
 * ⭐ `watch` —— 面板上「我扫完了」按钮用的：轮询直到扫码成功
 *    每 2 秒查一次，最多等 N 秒（默认 120）。
 *    输出**一行一个 JSON 状态**，最后一行是终态 —— 面板边跑边读。
 */
if (cmd === 'watch') {
  const maxSec = Math.max(10, Math.min(Number(process.argv[3] || process.env.QR_WATCH_SEC || 120), 600))
  PORT = PORT || await discoverQrPort()
  if (!(await loginBrowserUp())) {
    console.log(JSON.stringify({ ok: false, up: false, error: '登录用的浏览器还没开', hint: NOT_UP_MSG }, null, 2))
    process.exit(2)
  }
  const deadline = Date.now() + maxSec * 1000
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await doCheck()
      if (last.ok) {
        console.log(JSON.stringify({ ...last, up: true, waited_s: Math.round((maxSec * 1000 - (deadline - Date.now())) / 1000) }, null, 2))
        process.exitCode = 0
        break
      }
      console.log(JSON.stringify({ ok: false, pending: true, verify: last.verify, hint: last.hint }, null, 2))
    } catch (e) {
      console.log(JSON.stringify({ ok: false, pending: true, error: String(e?.message ?? e) }, null, 2))
    }
    await sleep(2000)
  }
  if (!last || !last.ok) {
    console.log(JSON.stringify({
      ok: false, timeout: true,
      verify: last?.verify || [],
      hint: last?.verify?.length
        ? `等了 ${maxSec} 秒还是卡在验证（${last.verify.join(' / ')}）——在那个浏览器窗口里做完，再点一次`
        : `等了 ${maxSec} 秒还没扫上 —— 二维码可能过期了，点「重新出二维码」再来一次`,
    }, null, 2))
    process.exit(2)
  }
}

if (cmd === 'close') {
  const owned = await ownedBrowsers()
  if (!owned.length) {
    console.log(JSON.stringify({ ok: false, closed: false, error: '没有找到可验证的插件浏览器；旧版或遗留进程请手动关闭后重试' }))
    process.exitCode = 2
  } else {
    for (const browser of owned) await closeOwnedBrowser(browser.port)
    console.log(JSON.stringify({ ok: true, closed: true }))
  }
}

} catch (error) {
  console.log(JSON.stringify({ ok: false, error: redactDiagnostic(error.message),
    conflict: error.conflict, can_kill: error.can_kill,
    hint: '仅关闭使用本插件 chrome-profile 的浏览器后重试；不要删除 profile 或结束其他浏览器进程' }))
  process.exitCode = 2
}
