// CDP：强制注入 happy 动作验证 override 管道
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
  const expr = `(async () => {
    perform('happy');
    await new Promise((r) => setTimeout(r, 400));
    const mid = JSON.stringify({ mouthForm: +cur.mouthForm.toFixed(2), mouthOpen: +cur.mouthOpen.toFixed(2), body: +cur.body.toFixed(2), override: actionOverride ? actionOverride.name : null });
    await new Promise((r) => setTimeout(r, 1300));
    const end = JSON.stringify({ mouthForm: +cur.mouthForm.toFixed(2), override: actionOverride ? actionOverride.name : null });
    return JSON.stringify({ mid, end });
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  console.log(r.result.value)
  process.exit(0)
}
main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1) })
