#!/usr/bin/env node
/**
 * tools/comment-reply.mjs —— 在抖音评论区回复某一条评论
 * ============================================================================
 * 走无头 Chrome 里的真实 UI（不签名字、不调写接口），屏幕上没有窗口。
 *
 * 链路：打开图文/视频页 → 点评论图标展开面板 → 按正文片段找到那条评论
 *       → 滚进视口 → 点「回复」 → 输入 → 提交
 *
 * 用法:
 *   node tools/comment-reply.mjs <aweme_id> <定位用的正文片段> <正文txt>
 *   node tools/comment-reply.mjs <aweme_id> <片段> <正文txt> --dry
 */
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.IM_CDP_PORT || 9334)
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const pos = argv.filter((a) => !a.startsWith('--'))
const AID = pos[0]
const NEEDLE = pos[1]
const TEXTFILE = pos[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AID || !NEEDLE || !TEXTFILE) { out({ ok: false, error: '用法: <aweme_id> <正文片段> <正文txt> [--dry]' }); process.exit(1) }
const TEXT = readFileSync(TEXTFILE, 'utf8').trim()
if (!TEXT) { out({ ok: false, error: '正文是空的' }); process.exit(1) }

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = ts.find((t) => t.type === 'page' && t.url.includes('douyin')) || ts.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data) } catch { return } if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
const send = (m, p = {}) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
await send('Page.enable'); await send('Runtime.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 220))
  return r.result?.value
}
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 找那条评论里的「回复」按钮（先滚进视口） */
const findReplyBtn = () => ev(`(function(){
  var needle=${JSON.stringify(NEEDLE)};
  var all=Array.prototype.slice.call(document.querySelectorAll('div,span,p'));
  var hits=all.filter(function(e){ return (e.innerText||'').indexOf(needle)>=0; });
  var sized=hits.map(function(e){var r=e.getBoundingClientRect();return {e:e,w:Math.round(r.width)};})
    .filter(function(o){return o.w>40;})
    .sort(function(a,b){return (a.e.innerText||'').length - (b.e.innerText||'').length;});
  if(!sized.length) return '';
  var el=sized[0].e;
  el.scrollIntoView({block:'center'});
  var box=el;
  for(var i=0;i<7 && box.parentElement;i++){
    box=box.parentElement;
    var hb=Array.prototype.some.call(box.querySelectorAll('div,span,p'),function(x){return (x.innerText||'').trim()==='回复';});
    if(hb) break;
  }
  var best=null;
  Array.prototype.forEach.call(box.querySelectorAll('div,span,p'),function(x){
    if((x.innerText||'').trim()!=='回复') return;
    var r=x.getBoundingClientRect();
    if(r.width<8||r.height<6||r.width>120) return;
    if(r.y<0||r.y>window.innerHeight) return;
    if(!best||r.width>best.w) best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};
  });
  return best?JSON.stringify(best):'';
})()`)

try {
  const u = String(await ev('location.href'))
  if (!u.includes(AID)) { await send('Page.navigate', { url: `https://www.douyin.com/note/${AID}` }); await sleep(7500) }

  // 1) 展开评论面板
  const ci = await ev(`(function(){
    var e=document.querySelector('[data-e2e="feed-comment-icon"]');
    if(!e) return '';
    var r=e.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)});
  })()`)
  if (ci) { const c = JSON.parse(ci); if (c.w > 8) { await click(c.x, c.y); await sleep(3000) } }

  // 2) 找回复按钮
  let btn = ''
  for (let i = 0; i < 6; i++) {
    await ev('window.scrollBy(0, 260)')
    await sleep(900)
    btn = await findReplyBtn()
    if (btn) break
  }
  if (!btn) { out({ ok: false, error: '没找到那条评论的「回复」按钮', needle: NEEDLE }); process.exit(1) }
  const b = JSON.parse(btn)
  if (DRY) { out({ ok: true, dry: true, btn: b, textLen: TEXT.length }); ws.close(); process.exit(0) }

  // 3) 点回复
  await click(b.x, b.y)
  await sleep(1800)

  // 4) 找输入框
  const ed = await ev(`(function(){
    var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
    var best=null;
    eds.forEach(function(e){
      var r=e.getBoundingClientRect();
      if(r.width<60||r.height<10) return;
      if(!best||r.width>best.w) best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),
        ph:e.getAttribute('data-placeholder')||e.getAttribute('placeholder')||''};
    });
    return best?JSON.stringify(best):'';
  })()`)
  if (!ed) { out({ ok: false, error: '点了回复但没出现输入框', btn: b }); process.exit(1) }
  const e2 = JSON.parse(ed)
  await click(e2.x, e2.y)
  await sleep(400)
  await send('Input.insertText', { text: TEXT })
  await sleep(700)

  const typed = await ev(`(function(){
    var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
    var s=eds.map(function(e){return String(e.innerText||e.value||'')}).join('|');
    return s.replace(/[\\u200b\\r]/g,'').slice(0,300);
  })()`)
  if (!String(typed).trim()) { out({ ok: false, error: '正文没进输入框', ph: e2.ph }); process.exit(1) }

  // 5) 找「发送」按钮，找不到就回车
  const sbtn = await ev(`(function(){
    var cands=[];
    Array.prototype.forEach.call(document.querySelectorAll('div,span,button'),function(e){
      var s=(e.innerText||'').trim();
      if(s!=='发送') return;
      var r=e.getBoundingClientRect();
      if(r.width<16||r.height<12||r.width>120) return;
      cands.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)});
    });
    cands.sort(function(a,b){return b.w-a.w;});
    return cands.length?JSON.stringify(cands[0]):'';
  })()`)
  if (sbtn) {
    const sb = JSON.parse(sbtn)
    await click(sb.x, sb.y)
  } else {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await sleep(3000)

  const after = await ev(`(function(){
    var t=document.body?document.body.innerText:'';
    return JSON.stringify({
      appeared: t.indexOf(${JSON.stringify(TEXT.slice(0, 20))})>=0,
      boxLeft: (function(){var e=document.querySelector('[contenteditable="true"], textarea');return (e?String(e.innerText||e.value||''):'').replace(/[\\u200b\\s]/g,'').length;})(),
      tail: t.replace(/\\s+/g,' ').slice(-260)
    });
  })()`)
  const a = JSON.parse(after)
  out({ ok: a.appeared, sent: a.appeared, aweme_id: AID, to_comment: NEEDLE.slice(0, 20), text: TEXT.slice(0, 120), usedSendBtn: !!sbtn, after: a })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
} finally { ws.close() }
process.exit(process.exitCode || 0)
