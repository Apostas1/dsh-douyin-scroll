#!/usr/bin/env node
/**
 * tools/card-share.mjs —— 用抖音自己的「分享给朋友」把视频以**卡片**发给好友
 * ============================================================================
 * 为什么必须这么做：分享卡片（aweType 800 / MessageItemShareAweme）是前端把结构化
 * 消息交给服务端生成的，纯文本 + URL 永远做不出卡片；而且文本链接在抖音里点不开。
 *
 * 链路（全在无头 Chrome 里，屏幕上无窗口）：
 *   视频页 → 鼠标轨迹 hover 分享图标 → 面板展开 →
 *   找「<昵称>」那一行的「分享」按钮 → 点击 → 卡片发出
 *
 * ⚠️ 分享图标没有 onClick，是 onMouseEnter/onFocus 的 hover 弹窗，
 *    所以必须用**真实鼠标轨迹**移过去，`el.click()` 打不开（踩过）。
 *
 * 用法:
 *   node tools/card-share.mjs <aweme_id> <好友昵称>
 *   node tools/card-share.mjs <aweme_id> <好友昵称> --dry    # 只展开面板打印结构
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DOUYIN_HOME || 'D:\\DeepSeek\\dsh-data\\douyin-duty'
const PROFILE = join(HOME, 'chrome-profile')
const PORT = Number(process.env.IM_CDP_PORT || 9334)
const CDP = `http://127.0.0.1:${PORT}`
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ⭐ Chrome 没起来就自己拉一个 —— 分享这条路上**不能假设**它一定还活着。
 *    2026-10-21 实测事故：DSH 重启把无头 Chrome 带走了，这里裸 fetch 直接 ECONNREFUSED 崩掉；
 *    紧接着的 `im-send.mjs` 却会自己把 Chrome 拉起来 —— 结果「理由发出去了、卡片没发出去」，
 *    顺序整个反掉。`im-send.mjs` / `comment-api.mjs` 早就有这一步，唯独这里漏了。
 */
async function ensureChrome() {
  const up = async () => { try { return (await fetch(`${CDP}/json/version`)).ok } catch { return false } }
  if (await up()) return 'reused'
  if (!CHROME) throw new Error('找不到 chrome.exe')
  mkdirSync(PROFILE, { recursive: true })
  const p = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', '--lang=zh-CN',
    'https://www.douyin.com/',
  ], { detached: true, stdio: 'ignore' })
  p.unref()
  for (let i = 0; i < 60; i++) {
    if (await up()) return 'launched'
    await sleep(500)
  }
  throw new Error('无头 Chrome 没起来')
}

const argv = process.argv.slice(2)
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const PEEK = argv.includes('--peek')
const TOID = argOf('--to-id', '')
// 位置参数：跳过 `--to-id` 后面那个值
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--to-id'))
const AID = pos[0] || ''
const WHO = pos[1] || ''
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AID || !WHO) { out({ ok: false, error: '用法: card-share.mjs <aweme_id> <好友昵称>' }); process.exit(1) }

const chromed = await ensureChrome()
const ts = await (await fetch(`${CDP}/json/list`)).json()
const page = ts.find((t) => t.type === 'page' && t.url.includes('douyin')) || ts.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data) } catch { return } if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
await send('Page.enable'); await send('Runtime.enable')
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 240)); return r.result?.value }
const mv = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
const click = async (x, y) => {
  await mv(x, y); await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

try {
  await send('Page.navigate', { url: `https://www.douyin.com/video/${AID}` })
  await sleep(7000)

  const pos = JSON.parse(await ev(`(function(){
    var ic=document.querySelector('[data-e2e="video-share-icon-container"]');
    if(!ic) return '{}';
    var r=ic.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  })()`))
  if (!pos.x) { out({ ok: false, error: '找不到分享图标（视频页没加载好）' }); process.exit(1) }

  // 真实轨迹 hover（必须；el.click() 打不开）
  await mv(20, 20); await sleep(250)
  for (let i = 1; i <= 8; i++) {
    await mv(Math.round(20 + (pos.x - 20) * i / 8), Math.round(20 + (pos.y - 20) * i / 8))
    await sleep(70)
  }
  await mv(pos.x, pos.y)
  await sleep(2000)

  const panel = await ev(`(function(){
    var sc=document.querySelector('[data-e2e="video-share-container"]');
    return sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,400) : '';
  })()`)
  if (!panel) { out({ ok: false, error: '分享面板没展开' }); process.exit(1) }

  // --peek：把面板里每一行连同它 fiber 里的 id 都打出来（排查重名用）
  if (PEEK) {
    const rows = await ev(`(function(){
      var sc = document.querySelector('[data-e2e="video-share-container"]');
      if (!sc) return '[]';
      var out = [];
      sc.querySelectorAll('div').forEach(function(e){
        var t = (e.innerText||'').replace(/\\s+/g,' ').trim();
        if (!t || t.length > 40 || t === '分享') return;
        var fk = Object.keys(e).find(function(k){ return k.indexOf('__reactFiber$')===0 });
        var ids = [];
        if (fk) {
          var f = e[fk], d = 0;
          while (f && d < 12) {
            var p = f.memoizedProps;
            if (p && typeof p === 'object') {
              for (var k in p) {
                if (typeof p[k] === 'string' && /^(MS4wLjABAA|11-)\\S{6,}$/.test(p[k])) ids.push(k + '=' + p[k]);
                else if (p[k] && typeof p[k] === 'object' && p[k].sec_uid) ids.push('obj.sec_uid=' + p[k].sec_uid);
                else if (p[k] && typeof p[k] === 'object' && p[k].uid) ids.push('obj.uid=' + p[k].uid);
              }
            }
            f = f.return; d++;
          }
        }
        var uniq = []; ids.forEach(function(x){ if (uniq.indexOf(x)<0) uniq.push(x) });
        if (uniq.length) out.push({ text: t.slice(0,30), ids: uniq.slice(0,4) });
      });
      var seen={},u=[]; out.forEach(function(o){var k=o.text; if(!seen[k]){seen[k]=1;u.push(o);}});
      return JSON.stringify(u.slice(0,12));
    })()`)
    out({ ok: true, peek: true, panel, rows: JSON.parse(rows || '[]') })
    ws.close(); process.exit(0)
  }

  // 找「WHO」那一行：同时拿到 昵称 + **sec_uid** + 「分享」按钮坐标 —— 昵称会重名，sec_uid 不会
  const found = await ev(`(function(){
    var who = ${JSON.stringify(WHO)};
    var sc = document.querySelector('[data-e2e="video-share-container"]');
    if(!sc) return JSON.stringify({err:'no-panel'});
    function secOf(node){
      var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$')===0 });
      if(!fk) return '';
      var f = node[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && typeof p === 'object') {
          for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid); }
        }
        f = f.return; d++;
      }
      return '';
    }
    var nodes = Array.prototype.slice.call(sc.querySelectorAll('div,span,p')).filter(function(e){
      return (e.innerText||'').trim() === who;
    }).sort(function(a,b){ return a.getBoundingClientRect().width - b.getBoundingClientRect().width });
    if(!nodes.length) return JSON.stringify({err:'no-name', text:(sc.innerText||'').replace(/\\s+/g,' ').slice(0,160)});
    var out = [];
    nodes.forEach(function(nameNode){
      var row = nameNode;
      for (var i=0;i<6 && row;i++){
        var btns = Array.prototype.slice.call(row.querySelectorAll('div,span,button')).filter(function(e){
          return (e.innerText||'').trim()==='分享';
        });
        if (btns.length){
          var b = btns[0], r = b.getBoundingClientRect();
          if (r.width>16 && r.height>12){
            out.push({ nick: who, sec_uid: secOf(row) || secOf(nameNode),
              btn: {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)} });
          }
          break;
        }
        row = row.parentElement;
      }
    });
    var seen={}, uniq=[];
    out.forEach(function(o){ var k=o.sec_uid||(o.btn.x+','+o.btn.y); if(!seen[k]){seen[k]=1;uniq.push(o)} });
    return JSON.stringify({candidates: uniq});
  })()`)

  let f = {}
  try { f = JSON.parse(found) } catch { f = { err: 'bad-json' } }
  if (f.err) { out({ ok: false, error: '找不到该好友那一行', detail: f, panel }); process.exit(1) }

  let cands = f.candidates || []
  if (TOID) {
    cands = cands.filter((c) => c.sec_uid === TOID)
    if (!cands.length) { out({ ok: false, error: `分享面板里没有 sec_uid=${TOID} 这个人（面板只列最近分享过的人）`, panel }); process.exit(1) }
  }
  if (cands.length > 1) {
    out({
      ok: false,
      error: '分享面板里有多个同名的人，不敢猜（猜错就是把视频发给陌生人）',
      nick: WHO,
      candidates: cands.map((c) => ({ sec_uid: c.sec_uid })),
      hint: '请改用 --to-id <sec_uid> 指定',
    })
    process.exit(1)
  }
  const b = cands[0].btn
  const target = { nick: WHO, sec_uid: cands[0].sec_uid || TOID || '' }
  if (DRY) { out({ ok: true, dry: true, panel, btn: b, target, chrome: chromed, matched_by: TOID ? 'sec_uid' : 'nickname(唯一)' }); ws.close(); process.exit(0) }

  await click(b.x, b.y)
  await sleep(2500)

  const after = await ev(`(function(){
    var sc=document.querySelector('[data-e2e="video-share-container"]');
    return JSON.stringify({
      panelStillOpen: sc ? sc.getBoundingClientRect().height > 10 : false,
      panelText: sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,200) : '',
      toast: (document.body.innerText||'').indexOf('已发送')>=0 || (document.body.innerText||'').indexOf('发送成功')>=0
    });
  })()`)
  out({ ok: true, sent: true, aweme_id: AID, to: WHO, panel, btn: b, chrome: chromed, after: JSON.parse(after) })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
} finally {
  ws.close()
}
process.exit(process.exitCode || 0)
