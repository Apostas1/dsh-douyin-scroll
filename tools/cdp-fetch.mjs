#!/usr/bin/env node
/**
 * tools/cdp-fetch.mjs —— 签名器挂了时的**兜底拉接口**：在已登录的无头 Chrome 里发
 * ============================================================================
 * 2026-10-26 实测出的三个真相（Issue #2 作者思路的正确姿势）：
 *   ① 空首页（douyin.com/）上页面签名 SDK **不启动** —— fetch/XHR 都没有 a_bogus，
 *      抖音对没签名的请求是「200 软拒 + 空 body」，不是 403；
 *   ② **视频页**（/video/<id>）上 SDK 才活了：bdms 接管 XMLHttpRequest.prototype.open，
 *      页面里发 XHR 自动补 a_bogus，status_code=0 有真 body；
 *   ③ 要用 **XHR**，不能用 fetch（bdms 只挂钩 XHR）。
 *
 * 所以本脚本：
 *   A. openPage 在已验证的浏览器中创建本次专用视频页
 *   B. 不导航任何已有页面；结束时只关闭本次页面
 *   C. 轮询等「XHR 已被接管」（openIsPatched，~20s）
 *   D. 页面上下文 XHR → stdout 只吐响应体（日志走 stderr）
 *
 * 用法：
 *   node tools/cdp-fetch.mjs --path "/aweme/v1/web/comment/list/?aweme_id=…"
 *   node tools/cdp-fetch.mjs --url  "https://www.douyin.com/aweme/v1/web/…"
 * ============================================================================
 */
import { openPage, waitForPageSigner } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}

const pathOrUrl = argOf('--path') || argOf('--url') || ''
if (!pathOrUrl) {
  console.error('用法：node tools/cdp-fetch.mjs --path "/aweme/v1/web/..."')
  process.exit(2)
}
const abs = pathOrUrl.startsWith('http')
  ? pathOrUrl
  : 'https://www.douyin.com' + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl)

const log = (s) => console.error('[cdp-fetch] ' + s)

/** 页面上下文 XHR（bdms 会自动补 a_bogus） */
const xhrExpr = (url) => `(async () => {
  return await new Promise((resolve) => {
    try {
      const x = new XMLHttpRequest()
      x.open('GET', ${JSON.stringify(url)}, true)
      x.timeout = 20000
      x.onreadystatechange = () => {
        if (x.readyState === 4) resolve({ status: x.status, body: x.responseText })
      }
      x.onerror = () => resolve({ status: 0, body: '' })
      x.ontimeout = () => resolve({ status: 0, body: '' })
      x.send()
    } catch (e) { resolve({ status: 0, body: '' }) }
  })
})()`

let page
try {
  const requestUrl = new URL(abs)
  if (requestUrl.origin !== 'https://www.douyin.com' || requestUrl.username || requestUrl.password
    || !['/aweme/v1/web/comment/list/', '/aweme/v1/web/comment/list/reply/'].includes(requestUrl.pathname)) {
    throw new Error('CDP 兜底只允许抖音评论列表只读接口')
  }
  const videoId = requestUrl.searchParams.get('aweme_id') || ''
  if (!/^\d+$/.test(videoId)) throw new Error('缺少有效 aweme_id，无法初始化视频页签名 SDK')
  page = await openPage({ url: `https://www.douyin.com/video/${videoId}` })
  await waitForPageSigner(page)
  log('独立视频页签名 SDK 就绪')
  const t0 = Date.now()
  const r = await page.ev(xhrExpr(abs))
  if (!r || !r.body) throw new Error(`HTTP ${r?.status ?? '?'} 空 body（风控软拒或页面态丢了）`)
  log(`HTTP ${r.status}，${r.body.length} 字节，${Date.now() - t0}ms`)
  process.stdout.write(r.body)
  process.exitCode = r.status === 200 ? 0 : 1
} catch (e) {
  log('失败：' + String(e?.message ?? e).slice(0, 300))
  process.exitCode = 1
} finally {
  await page?.close()
}
