#!/usr/bin/env node
/**
 * tools/im-http.mjs —— 纯 HTTP 读私信（不碰浏览器）
 * ============================================================================
 * 为什么要有它：
 *   浏览器路径（im-send.mjs --read）冷启动 ~10 秒、切会话 ~1.4 秒，
 *   而且"谁发的"要靠头像落点左右半边猜、时间戳恒为 0。
 *   抖音网页版自己的 IM 走的是 imapi.douyin.com 的 protobuf 接口，
 *   只认 Cookie（不需要 a_bogus、不需要起 Chrome）。
 *   实测（2026-10-24）：一次请求 ~420ms 拿到全部已建立会话 + 每个会话最近
 *   20 条消息，且**每条带真实毫秒时间戳和发送者 uid**。
 *
 * 🔴 只读：这个脚本**没有任何发送代码**。发私信仍走 im-send.mjs（浏览器）。
 *    selfcheck 有断言盯着：这里出现 /message/send 就报红。
 *
 * 用法：
 *   node tools/im-http.mjs --read [--peer-sec-uid <id>] [--limit 30]
 *
 * 输出：一行 JSON
 *   { ok, via:'http', ms, my_uid, conversations:[{
 *       conv_id, short_id, type, peer_uid, peer_sec_uid, ticket,
 *       messages:[{ from:'me'|'them', text, at, kind }]
 *     }], status }
 *
 * ⚠️ 已知边界（如实写，别装全）：
 *   · 只拿得到「已建立会话」（好友/聊过的）。陌生人消息在另一个接口
 *     （/v1/stranger/get_conversation_list，cmd 1001），分页参数没破出来，
 *     而且探测密集会吃 "too many requests" —— 没做，别当它存在。
 *   · 拿不到时返回 ok:false，调用方（index.js）自动退回浏览器路径。
 *   · 协议参考了公开逆向项目（MIT）的思路，但信封是从零构造的，
 *     没有复制任何第三方常量（别人的信封里嵌着他们自己的会话 ID）。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { homeDir } from '../lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

const argv = process.argv.slice(2)
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const READ = argv.includes('--read')
const PEER_SEC = String(argOf('--peer-sec-uid', ''))
const LIMIT = Math.max(1, Math.min(Number(argOf('--limit', '30')) || 30, 60))

if (!READ) out({ ok: false, error: '只支持 --read（这是个只读工具）' })

/* ───────────────────────── Cookie ───────────────────────── */

const HOME = homeDir()
const readCookie = () => {
  let raw = ''
  try { raw = readFileSync(join(HOME, 'douyin_cookie.txt'), 'utf8').trim() } catch { return '' }
  if (raw.startsWith('{')) {
    try { return (JSON.parse(raw).cookies || []).map((c) => `${c.name}=${c.value}`).join('; ') } catch { return '' }
  }
  return raw.replace(/[\r\n]+/g, ' ')
}
const COOKIE = readCookie()
if (!COOKIE.includes('sessionid=')) {
  out({ ok: false, error: 'Cookie 里没有 sessionid（还没登录）', hint: '先在设置页扫码登录或粘贴 Cookie' })
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/* ───────────────────────── protobuf 编解码（最小实现，够用就好） ───────────────────────── */

const ev = (n) => {
  const o = []
  let v = BigInt(n)
  while (true) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v) o.push(b | 0x80)
    else { o.push(b); break }
  }
  return Buffer.from(o)
}
const encV = (fn, n) => Buffer.concat([ev((fn << 3) | 0), ev(n)])
const encLD = (fn, d) => {
  const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')
  return Buffer.concat([ev((fn << 3) | 2), ev(b.length), b])
}
const encEmpty = (fn) => Buffer.concat([ev((fn << 3) | 2), ev(0)])

const rv = (b, i) => {
  let shift = 0n, result = 0n
  while (true) {
    const x = b[i++]
    result |= BigInt(x & 0x7f) << shift
    if (!(x & 0x80)) return [result, i]
    shift += 7n
  }
}
/** 宽容解析：坏字节直接停，不抛（响应里允许有我们不认识的字段）。
 *  ⭐ 全程 BigInt：varint 一律按 64 位走 —— 19 位的 short_id / 时间戳
 *    用 Number 会被 32 位截断（实测：short_id 尾数变 0、时间戳落到 1970 年）。 */
const parse = (b) => {
  const m = new Map()
  let i = 0
  while (i < b.length) {
    let tag
    try { [tag, i] = rv(b, i) } catch { break }
    const fn = Number(tag & 0xfffffff8n) >> 0 === 0 ? 0 : Number(tag >> 3n)
    const wt = Number(tag & 7n)
    if (!fn) break
    let val
    try {
      if (wt === 0) [val, i] = rv(b, i)
      else if (wt === 1) { val = b.subarray(i, i + 8); i += 8 }
      else if (wt === 5) { val = b.subarray(i, i + 4); i += 4 }
      else if (wt === 2) {
        let ln; [ln, i] = rv(b, i)
        val = b.subarray(i, i + Number(ln)); i += Number(ln)
      } else break
    } catch { break }
    if (!m.has(fn)) m.set(fn, [])
    m.get(fn).push(val)
  }
  return m
}
const g1 = (m, k, d = undefined) => (m.has(k) ? m.get(k)[0] : d)
const asStr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''))

/* ───────────────────────── 请求信封（从零构造） ─────────────────────────
 * 结构是抓抖音页面真实请求对照出来的；字段含义见内联注释。
 * ⚠️ 不复制任何第三方 base64 常量。
 */
let SEQ = 10000 + Math.floor(Math.random() * 100)
const nextSeq = () => { SEQ += 1; return SEQ }

const buildEnvelope = (cmd, body) => {
  const kv = (k, v) => encLD(15, Buffer.concat([encLD(1, k), encLD(2, v)]))
  return Buffer.concat([
    encV(1, cmd),            // 命令号
    encV(2, nextSeq()),      // 序列号
    encLD(3, '0.1.8'),       // 协议版本（页面同款）
    encEmpty(4),
    encV(5, 3),
    encV(6, 1),
    encLD(7, '0d50935:feat/pc-im-group'),  // 前端构建标识（页面同款）
    encLD(8, body),          // 内层请求体（裸 protobuf）
    encLD(9, '0'),
    encLD(11, 'douyin_pc'),
    encLD(14, '360000'),
    kv('session_aid', '6383'),
    kv('session_did', '0'),
    kv('app_name', 'douyin_pc'),
    kv('priority_region', 'cn'),
    kv('user_agent', UA),
    kv('cookie_enabled', 'true'),
    kv('browser_language', 'zh-CN'),
    kv('browser_platform', 'Win32'),
    kv('browser_name', 'Mozilla'),
    kv('browser_version', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
    kv('browser_online', 'true'),
    kv('screen_width', '800'),
    kv('screen_height', '600'),
    kv('timezone_name', 'Asia/Shanghai'),
    kv('deviceId', '0'),
    kv('is-retry', '0'),
    encV(18, 1),
    encLD(21, 'douyin_web'),
    encLD(22, 'web_sdk'),
  ])
}

/* ───────────────────────── HTTP ───────────────────────── */

const post = (path, payload, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const req = httpsRequest({
    hostname: 'imapi.douyin.com', path, method: 'POST',
    headers: {
      'User-Agent': UA, 'Cookie': COOKIE,
      'Referer': 'https://www.douyin.com/', 'Origin': 'https://www.douyin.com',
      'Accept': 'application/x-protobuf', 'Content-Type': 'application/x-protobuf',
      'Content-Length': payload.length,
    },
    timeout: timeoutMs,
  }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }))
  })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', reject)
  req.write(payload)
  req.end()
})

const getJson = (path, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const req = httpsRequest({
    hostname: 'www.douyin.com', path, method: 'GET',
    headers: { 'User-Agent': UA, 'Cookie': COOKIE, 'Referer': 'https://www.douyin.com/' },
    timeout: timeoutMs,
  }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
  })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', reject)
  req.end()
})

/* ───────────────────────── 业务 ───────────────────────── */

const iso = (ms) => { const n = Number(ms); return n > 0 ? new Date(n).toISOString() : '' }

/** 从会话 id 里解出对端 uid（格式 "0:<type>:<uidA>:<uidB>"，去掉自己那个） */
const peerUidOf = (convId, myUid) => {
  const parts = String(convId || '').split(':')
  const uids = parts.filter((p) => /^\d{8,}$/.test(p))
  const other = uids.find((u) => u !== myUid)
  return other || uids[uids.length - 1] || ''
}

const main = async () => {
  const t0 = Date.now()

  // ① 我是谁（uid）——判"谁发的"要用
  let myUid = ''
  try {
    const me = await getJson('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1')
    myUid = String(me?.user?.uid || '')
    if (!myUid || me?.status_code !== 0) {
      return out({ ok: false, error: 'Cookie 失效或登录态异常', status_code: me?.status_code, ms: Date.now() - t0 })
    }
  } catch (e) {
    return out({ ok: false, error: '查登录态失败：' + String(e?.message ?? e).slice(0, 120), ms: Date.now() - t0 })
  }

  // ② 拉全部已建立会话（cmd 2043）
  let resp
  try {
    resp = await post('/v1/message/get_message_by_init', buildEnvelope(2043, encLD(2043, Buffer.alloc(0))))
  } catch (e) {
    return out({ ok: false, error: 'IM 请求失败：' + String(e?.message ?? e).slice(0, 120), my_uid: myUid, ms: Date.now() - t0 })
  }
  const ms = Date.now() - t0

  const env = parse(resp.buf)
  const status = asStr(g1(env, 4, ''))
  if (status !== 'OK') {
    // 例如 "too many requests" —— 如实报，让调用方退回浏览器路径
    return out({ ok: false, error: 'IM 接口返回：' + (status || '(空)'), status, my_uid: myUid, ms })
  }

  const wrap = parse(g1(env, 6, Buffer.alloc(0)))
  const sub = parse(g1(wrap, 2043, Buffer.alloc(0)))
  const convBlobs = (sub.get(1) || []).filter((b) => Buffer.isBuffer(b))

  const conversations = []
  for (const blob of convBlobs) {
    const conv = parse(blob)
    const core = parse(g1(conv, 1, Buffer.alloc(0)))
    const convId = asStr(g1(core, 1, ''))
    const msgsRaw = (conv.get(2) || []).filter((b) => Buffer.isBuffer(b))

    // 消息：field7=发送者uid field8=正文JSON field10=毫秒时间戳
    const messages = []
    for (const m of msgsRaw) {
      const f = parse(m)
      const sender = String(g1(f, 7) ?? '')
      const contentRaw = asStr(g1(f, 8, ''))
      const atMs = Number(g1(f, 10) ?? 0n)      // ⭐ BigInt → Number（毫秒在 2^53 内，安全）
      let text = ''
      let kind = 'text'
      try {
        const j2 = JSON.parse(contentRaw)
        text = String(j2.text || j2.content_title || '').trim()
        kind = Number(j2.aweType) === 800 ? 'card' : 'text'
      } catch { text = contentRaw.slice(0, 120) }
      if (!text) continue
      messages.push({
        from: sender === myUid ? 'me' : 'them',
        text: text.slice(0, 200),
        at: iso(atMs),
        kind,
      })
    }
    // DOM/协议顺序都是新的在前 ⇒ 翻成旧→新，跟 im-send --read 一致
    messages.reverse()

    conversations.push({
      conv_id: convId,
      short_id: String(g1(core, 2) ?? ''),   // ⭐ 字符串：19 位数，Number 会丢精度
      type: Number(g1(core, 3) ?? 0n),       // 1=私聊 2=群聊
      ticket: asStr(g1(core, 4, '')),
      peer_uid: peerUidOf(convId, myUid),
      message_count: messages.length,
      messages: messages.slice(-LIMIT),
    })
  }

  // ③ 可选：把对端 uid 换成 sec_uid（调用方按 sec_uid 找人时用）
  if (PEER_SEC) {
    const target = conversations.find((c) => c.peer_uid)
    if (target) {
      try {
        const p = await getJson(`/aweme/v1/web/user/profile/other/?user_id=${target.peer_uid}&device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1`)
        if (p?.user?.sec_uid) {
          target.peer_sec_uid = String(p.user.sec_uid)
          target.peer_nickname = String(p.user.nickname || '')
        }
      } catch { /* 拿不到就留空，调用方自己判断 */ }
    }
  }

  const first = conversations[0]
  return out({
    ok: true,
    via: 'http',
    ms,
    my_uid: myUid,
    status,
    conversation_count: conversations.length,
    /** ⚠️ 只含「已建立会话」。陌生人消息不在这条路上（见文件头注释） */
    conversations,
    matched: PEER_SEC && first?.peer_sec_uid ? { sec_uid: first.peer_sec_uid, nickname: first.peer_nickname } : undefined,
  })
}

main().catch((e) => out({ ok: false, error: String(e?.message ?? e).slice(0, 200) }))
