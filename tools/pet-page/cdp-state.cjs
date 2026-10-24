// CDP：页面基础状态诊断
async function main() {
  const list = await fetch('http://127.0.0.1:9224/json').then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const send = (method, params) => new Promise((res) => {
    const i = ++id
    const h = (ev) => { const d = JSON.parse(ev.data); if (d.id === i) { ws.removeEventListener('message', h); res(d.result) } }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const expr = `JSON.stringify({
    url: location.href.slice(-40),
    ready: document.readyState,
    menu: !!document.getElementById('menu'),
    gl: !!document.getElementById('gl'),
    talkbar: !!document.getElementById('talkbar'),
    scripts: document.scripts.length,
    agPsd: typeof window.agPsd,
    Rigger: typeof window.Rigger,
    loadErr: document.getElementById('load-error') ? document.getElementById('load-error').textContent : 'none'
  })`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(r.result.value)
  process.exit(0)
}
main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1) })
