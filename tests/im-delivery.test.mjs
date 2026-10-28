import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverIm, editorStateExpression, deliveryDiagnostic } from '../lib/im-delivery.mjs'
import { createTaskPage } from '../lib/task-page.mjs'
import { connectCdp } from '../lib/browser-ownership.mjs'

function fixture({ echoAt = 4000, echoText = '完整正文', clear = true, corrupt = false, submitError = false, targetChanges = false } = {}) {
  let time = 0, submitted = 0, editor = '旧草稿', reads = 0
  const page = {
    async ev(expr) {
      if (expr === editorStateExpression) return { exists: true, focused: true, text: editor }
      if (expr.includes('getBoundingClientRect')) return { x: 200, y: 300 }
      if (expr.includes('selectNodeContents')) return true
      throw new Error('unexpected expression')
    },
    async send(method, params) {
      if (method === 'Input.insertText') editor = corrupt ? '错误草稿' : params.text
      if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown') {
        assert.equal(params.nativeVirtualKeyCode, undefined)
        submitted++
        if (submitError) throw new Error('CDP 请求超时：Input.dispatchKeyEvent')
      }
    },
  }
  return {
    run: () => deliverIm({ page, text: '完整正文', beforeMessages: [],
      readMessages: async () => {
        if (time >= echoAt && clear) editor = ''
        return time >= echoAt ? [{ from: 'me', text: echoText }] : []
      },
      verifyTarget: async () => !(targetChanges && ++reads > 1),
      now: () => time, wait: async ms => { time += ms }, timeoutMs: 15000,
    }),
    submits: () => submitted,
  }
}

test('slow echo beyond the old 2.6s window succeeds with exactly one submission', async () => {
  const f = fixture(); const r = await f.run()
  assert.equal(r.ok, true); assert.equal(r.stage, 'confirmed'); assert.equal(r.elapsed_ms, 4000)
  assert.equal(r.pending, false); assert.equal(f.submits(), 1)
})
test('same prefix is not a delivery receipt', async () => {
  const f = fixture({ echoText: '完整正文但其实是另一条' }); const r = await f.run()
  assert.equal(r.ok, false); assert.equal(r.readback, false); assert.equal(r.pending, true)
  assert.equal(r.retry_safe, false); assert.equal(f.submits(), 1)
})
test('missing echo remains pending and is never resubmitted', async () => {
  const f = fixture({ echoAt: Infinity }); const r = await f.run()
  assert.equal(r.pending, true); assert.equal(r.submitted, true); assert.equal(r.retry_safe, false)
  assert.equal(f.submits(), 1)
})
test('echo without clearing the editor is not confirmed', async () => {
  const f = fixture({ clear: false }); const r = await f.run()
  assert.equal(r.ok, false); assert.equal(r.readback, true); assert.equal(r.pending, true)
})
test('mismatched editor contents prevent any submission', async () => {
  const f = fixture({ corrupt: true }); const r = await f.run()
  assert.equal(r.stage, 'fill_editor'); assert.equal(r.submitted, false); assert.equal(r.retry_safe, true)
  assert.equal(f.submits(), 0)
})
test('contact change after typing prevents submission', async () => {
  const f = fixture({ targetChanges: true }); const r = await f.run()
  assert.equal(r.submitted, false); assert.equal(f.submits(), 0)
})
test('CDP error during Enter means unknown outcome, never safe to retry', async () => {
  const f = fixture({ submitError: true }); const r = await f.run()
  assert.equal(r.stage, 'submit'); assert.equal(r.pending, true); assert.equal(r.retry_safe, false)
  assert.equal(f.submits(), 1)
})
test('diagnostics exclude recipient, credentials and message contents', () => {
  const r = deliveryDiagnostic({ ok: false, submitted: true, pending: true, stage: 'readback',
    text: 'private', to: 'private recipient', error: 'secret URL', cookie: 'secret' })
  assert.deepEqual(r, { ok: false, submitted: true, pending: true, stage: 'readback' })
})

function browserFixture() {
  let id = 0
  const targets = new Set(), commands = [], closedPages = [], closedControls = []
  const control = () => {
    const controlId = id
    return {
      async send(method, params) {
        commands.push(method)
        if (method === 'Target.createTarget') { const targetId = String(++id); targets.add(targetId); return { targetId } }
        if (method === 'Target.closeTarget') { targets.delete(params.targetId); return { success: true } }
        throw new Error('unexpected browser command')
      },
      close: () => closedControls.push(controlId),
    }
  }
  const connect = async targetId => ({ send: async () => ({}), ev: async () => true, close: () => closedPages.push(targetId) })
  return { control, connect, targets, commands, closedPages, closedControls }
}
test('concurrent tasks own different tabs; closing one never closes another', async () => {
  const f = browserFixture()
  const [a, b] = await Promise.all([createTaskPage(f.control(), { url: 'https://www.douyin.com/chat', connect: f.connect }),
    createTaskPage(f.control(), { url: 'https://www.douyin.com/video/1', connect: f.connect })])
  assert.notEqual(a.targetId, b.targetId)
  await a.close(); await a.close()
  assert.deepEqual([...f.targets], [b.targetId]); assert.deepEqual(f.closedPages, [a.targetId])
  await b.close(); assert.equal(f.targets.size, 0)
  assert.equal(f.commands.filter(c => c === 'Target.closeTarget').length, 2)
})
test('failed initialization closes only the newly created tab', async () => {
  const f = browserFixture()
  await assert.rejects(createTaskPage(f.control(), { url: 'https://www.douyin.com/chat', connect: async () => { throw Error('connect failed') } }), /connect failed/)
  assert.equal(f.targets.size, 0); assert.equal(f.closedControls.length, 1)
})
test('unready document has a bounded wait and cleans up', async () => {
  const f = browserFixture(); let waits = 0
  await assert.rejects(createTaskPage(f.control(), { url: 'https://www.douyin.com/chat',
    connect: async id => ({ ...await f.connect(id), ev: async () => false }), wait: async () => waits++ }), /加载超时/)
  assert.equal(waits, 40); assert.equal(f.targets.size, 0)
})
test('CDP timeout tears down all pending commands and rejects future commands immediately', async t => {
  class SilentSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  const OriginalSocket = globalThis.WebSocket
  globalThis.WebSocket = SilentSocket
  t.after(() => { globalThis.WebSocket = OriginalSocket })
  const c = await connectCdp('ws://127.0.0.1:9334/devtools/page/fixture', 9334, 25)
  const results = await Promise.allSettled([c.send('Runtime.evaluate'), c.send('Page.navigate')])
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /超时/)
  assert.equal(results[1].status, 'rejected')
  await assert.rejects(c.send('Runtime.evaluate'), /连接已关闭/)
})

test('page close rejection is reported without touching another target', async () => {
  const closed = []
  const page = await createTaskPage({ send: async (method, params) => {
    if (method === 'Target.createTarget') return { targetId: 'mine' }
    closed.push(params.targetId); return { success: false }
  }, close() {} }, { url: 'https://www.douyin.com/chat', connect: async () => ({ send: async () => ({}), ev: async () => true, close() {} }) })
  assert.equal((await page.close()).ok, false); assert.deepEqual(closed, ['mine'])
})
test('fresh video pages must wait for signing SDK; timeout stops before request', async () => {
  const { waitForPageSigner } = await import('../lib/chrome.mjs')
  let reads = 0, waits = 0
  await waitForPageSigner({ ev: async () => ++reads === 3 }, { wait: async () => waits++ })
  assert.equal(reads, 3); assert.equal(waits, 2)
  await assert.rejects(waitForPageSigner({ ev: async () => false }, { attempts: 2, wait: async () => {} }), /SDK 未就绪/)
})
