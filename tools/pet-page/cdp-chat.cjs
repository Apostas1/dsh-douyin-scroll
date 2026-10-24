// CDP：验证聊天 v2（台词条）+ 小动作 override —— 带原始输出诊断
async function main() {
  const list = await fetch('http://127.0.0.1:9224/json').then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) { console.log('NO_PAGE'); process.exit(2) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const send = (method, params) => new Promise((res) => {
    const i = ++id
    const h = (ev) => { const d = JSON.parse(ev.data); if (d.id === i) { ws.removeEventListener('message', h); res(d.result) } }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', (e) => j(e)) })
  await send('Page.reload')
  await new Promise((r) => setTimeout(r, 13000))
  const expr = `(async () => {
    const out = {}
    out.loadErr = document.getElementById('load-error') ? document.getElementById('load-error').textContent : 'ok'
    const chatBtn = document.querySelector('[data-act="chat"]')
    if (!chatBtn) return JSON.stringify({ err: 'no chat button' })
    chatBtn.click()
    out.talkbarOn = document.getElementById('talkbar').classList.contains('on')
    const inp = document.getElementById('chat-input')
    const r2 = inp.getBoundingClientRect()
    out.input = Math.round(r2.left) + ',' + Math.round(r2.top) + ' ' + Math.round(r2.width) + 'x' + Math.round(r2.height) + ' inWin=' + (r2.right <= window.innerWidth)
    inp.value = '你真棒'
    document.getElementById('chat-send').click()
    await new Promise((r) => setTimeout(r, 500))
    out.bubble = document.getElementById('pet-bubble').textContent.slice(0, 30)
    document.querySelector('[data-act="play"]').click()
    await new Promise((r) => setTimeout(r, 300))
    out.override = typeof actionOverride !== 'undefined' && actionOverride !== null
    out.cur = { az: +cur.angleZ.toFixed(2), mf: +cur.mouthForm.toFixed(2), arm: +cur.armY.toFixed(2) }
    return JSON.stringify(out)
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.value !== undefined) console.log('RESULT: ' + r.result.value)
  else console.log('RAW: ' + JSON.stringify(r).slice(0, 400))
  process.exit(0)
}
main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1) })
