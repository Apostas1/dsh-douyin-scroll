// CDP 诊断：抓 pet-page 的加载错误详情（Node 22+ 原生 WebSocket）
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
  const evalIn = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value
  console.log('load-error:', await evalIn(`document.getElementById('load-error') ? document.getElementById('load-error').textContent : 'none'`))
  console.log('agPsd type:', await evalIn(`typeof window.agPsd`))
  console.log('agPsd.readPsd:', await evalIn(`typeof window.agPsd.readPsd`))
  // 手动重放加载流程，逐层抓栈
  const probe = await send('Runtime.evaluate', {
    expression: `(async () => {
      try {
        const url = '../../assets/pet/psd/model.psd'
        const buf = await (await fetch(url)).arrayBuffer()
        const psd = await window.agPsd.readPsd(buf, { useImageData: true, skipThumbnail: true })
        const info = { w: psd.width, h: psd.height, children: (psd.children || []).length }
        const bad = []
        const walk = (nodes) => (nodes || []).forEach(c => { if (c.children) walk(c.children); else { if (!c.imageData) bad.push(c.name + ':no-imageData'); else if (!c.imageData.data || c.imageData.data.length !== c.imageData.width * c.imageData.height * 4) bad.push(c.name + ':data-len-' + (c.imageData.data ? c.imageData.data.length : 'null') + '-vs-' + c.imageData.width * c.imageData.height * 4) } })
        walk(psd.children)
        return JSON.stringify({ ok: true, info, bad: bad.slice(0, 6) })
      } catch (e) { return JSON.stringify({ ok: false, err: e.message, stack: (e.stack || '').slice(0, 300) }) }
    })()`,
    returnByValue: true, awaitPromise: true,
  })
  console.log('probe:', probe.result.value)
  ws.close(); process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
