// CDP：验证引擎渲染真的画出了内容（读回 canvas 像素）
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
  // preserveDrawingBuffer 没开的话 readPixels 读不到 —— 改成 capturePage 截图看像素方差
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  console.log('screenshot bytes:', (shot.data || '').length)
  const q = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      bubble: document.getElementById('pet-bubble').textContent,
      canvas: document.getElementById('gl').width + 'x' + document.getElementById('gl').height,
      layers: window.Rigger ? 'engine-loaded' : 'no-engine'
    })`,
    returnByValue: true,
  })
  console.log(q.result.value)
  process.exit(0)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
