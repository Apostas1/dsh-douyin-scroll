// CDP：重放 buildRig 抓完整栈
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
    try {
      const buf = await (await fetch('../../assets/pet/psd/model.psd')).arrayBuffer();
      const psd = await window.agPsd.readPsd(buf, { useImageData: true, skipThumbnail: true });
      const rig = window.Rigger.buildRig(psd, { generic: { eyeL: GenericParts.eyeL, eyeR: GenericParts.eyeR, mouth: GenericParts.mouth } });
      return 'OK layers=' + rig.layers.length + ' anchors=' + Object.keys(rig.anchors).join(',');
    } catch (e) { return 'ERR ' + e.message + ' || ' + String(e.stack || '').split('\\n').slice(0, 5).join(' | '); }
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  console.log(r.result.value)
  process.exit(0)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
