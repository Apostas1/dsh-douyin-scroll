import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { resolveRecipient } from '../lib/recipients.mjs'
import { scriptResult, lastJsonObject, redactDiagnostic } from '../lib/process-result.mjs'
import { configLogSummary, maskUrl } from '../lib/notify.mjs'
import { scriptRuntime, versionProbePassed } from '../lib/dsh-runtime.mjs'
import { ownsProfile, probeBrowser, localDebuggerUrl, isDouyinDomain, isDouyinUrl } from '../lib/browser-ownership.mjs'
import { waitForBrowser } from '../lib/chrome.mjs'
import { ensureUv, verifyArchive, UV_ASSETS } from '../lib/uvfetch.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'douyin-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const defaults = { dmTo: 'Alice', dmToId: 'MS4w-default' }

test('explicit nickname never inherits default ID', () => assert.deepEqual(resolveRecipient({ to: 'Bob' }, defaults), { to: 'Bob', toId: '' }))
test('explicit ID never inherits default nickname', () => assert.deepEqual(resolveRecipient({ to_id: 'MS4w-Bob' }, defaults), { to: '', toId: 'MS4w-Bob' }))
test('default contact is selected as a pair, including partial records', () => {
  assert.deepEqual(resolveRecipient({}, defaults), { to: 'Alice', toId: 'MS4w-default' })
  assert.deepEqual(resolveRecipient({}, { ...defaults, dmPeers: [{ nick: 'Bob' }] }), { to: 'Bob', toId: '' })
})
test('multi-object stdout retains final structured diagnostics', () => {
  const value = 'progress {"ok":true}\nfinal\n{\n"ok":false,"error":"locked {profile}","hint":"close owned browser"\n}'
  assert.equal(lastJsonObject(value).hint, 'close owned browser')
  assert.equal(scriptResult({ status: 2, stdout: value }).error, 'locked {profile}')
})
test('nonzero exit cannot be converted into success; stderr is retained and masked', () => {
  assert.equal(scriptResult({ status: 1, stdout: '{"ok":true}' }).ok, false)
  const result = scriptResult({ status: 1, stderr: 'profile locked sessionid=EXAMPLE_ONLY' })
  assert.equal(result.exit_code, 1)
  assert.match(result.stderr_tail, /profile locked/)
  assert.doesNotMatch(result.stderr_tail, /EXAMPLE_ONLY/)
})
test('configuration diagnostics do not include secret values', () => {
  const url = 'https://user:secret@example.invalid/hook/VERY_SECRET_TOKEN_123456?key=private#secret'
  assert.equal(configLogSummary({ webhookUrl: url, autoSend: false }), 'autoSend, webhookUrl')
  assert.doesNotMatch(maskUrl(url), /private|secret|VERY_SECRET/)
  assert.doesNotMatch(redactDiagnostic(`failed ${url}`), /private|secret|VERY_SECRET/)
})
test('ASAR requires Electron, ordinary scripts prefer standalone Node', () => {
  const r = scriptRuntime('C:\\app\\app.asar\\cli.js', { node: 'node.exe', executable: 'DSH.exe', electron: '43' })
  assert.equal(r.command, 'DSH.exe'); assert.equal(r.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(r.args[0], '--expose-internals')
  assert.throws(() => scriptRuntime('/app/app.asar/cli.js', { electron: '' }), /Electron/)
  assert.equal(scriptRuntime('/cli.js', { node: '/node', electron: '43' }).command, '/node')
})
test('failed version probe with semver in output is rejected', () => {
  assert.equal(versionProbePassed({ status: 1, stdout: 'Node 24.1.0' }), false)
  assert.equal(versionProbePassed({ status: 0, stdout: 'dsh 0.1.7-rc.1' }), true)
})
test('profile matching is exact, platform aware, and not a substring', () => {
  assert.equal(ownsProfile(['--user-data-dir=/tmp/plugin/profile'], '/tmp/plugin/profile'), true)
  assert.equal(ownsProfile(['--user-data-dir=/tmp/other/chrome-profile'], '/tmp/plugin/chrome-profile'), false)
  assert.equal(ownsProfile(['--user-data-dir', 'C:\\Plugin\\Profile'], 'c:\\plugin\\profile', 'win32'), true)
  assert.equal(ownsProfile([], '/tmp/plugin/profile'), false)
})
test('CDP websocket must be local and match the queried port', () => {
  assert.equal(localDebuggerUrl('ws://127.0.0.1:9334/devtools/browser/abc', 9334), true)
  for (const url of ['ws://example.com:9334/x', 'ws://127.0.0.1:9000/x', 'wss://127.0.0.1:9334/x']) assert.equal(localDebuggerUrl(url, 9334), false)
})
test('responsive CDP with another profile or unverifiable command line is refused', async () => {
  let closed = 0
  const fetcher = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser/test' }) })
  const connect = async () => ({ send: async () => ({ arguments: ['--user-data-dir=/other'] }), close: () => closed++ })
  assert.equal(await probeBrowser(9334, '/mine', { fetcher, connect }), null)
  assert.equal(closed, 1)
  const unavailable = async () => ({ send: async () => { throw Error('method unavailable') }, close: () => closed++ })
  assert.equal(await probeBrowser(9334, '/mine', { fetcher, connect: unavailable }), null)
})
test('verified profile can be reused and reports browser mode', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser/test' }) })
  const connect = async () => ({ send: async () => ({ arguments: ['--user-data-dir=/mine', '--headless=new'] }), close() {} })
  assert.equal((await probeBrowser(9334, '/mine', { fetcher, connect })).headless, true)
})
test('process exit is reported immediately instead of waiting out CDP startup', async () => {
  const child = new EventEmitter(); let waits = 0
  await assert.rejects(waitForBrowser(child, 9334, { probe: async () => null, wait: async () => { waits++; child.emit('exit', 21, null) } }), /exit=21/)
  assert.equal(waits, 1)
})
test('spawn error and readiness timeout have distinct actionable diagnostics', async () => {
  const child = new EventEmitter()
  await assert.rejects(waitForBrowser(child, 9334, { probe: async () => { child.emit('error', { code: 'ENOENT' }); return null } }), /ENOENT/)
  await assert.rejects(waitForBrowser(new EventEmitter(), 9334, { attempts: 1, probe: async () => null, wait: async () => {} }), /超时/)
})
test('Cookie filtering rejects lookalike domains', () => {
  assert.equal(isDouyinDomain('.douyin.com'), true)
  assert.equal(isDouyinUrl('https://www.douyin.com/chat'), true)
  for (const name of ['evil-douyin.com', 'douyin.com.evil.test']) assert.equal(isDouyinDomain(name), false)
  assert.equal(isDouyinUrl('https://evil.test/?douyin.com'), false)
})
test('archive checksum is mandatory and platform digests are distinct', t => {
  const path = join(temp(t), 'archive'); writeFileSync(path, 'fixture')
  const digest = createHash('sha256').update('fixture').digest('hex')
  assert.doesNotThrow(() => verifyArchive(path, digest))
  assert.throws(() => verifyArchive(path, undefined), /SHA-256/)
  assert.throws(() => verifyArchive(path, '0'.repeat(64)), /SHA-256/)
  assert.equal(new Set(Object.values(UV_ASSETS).map(a => a[1])).size, 6)
})
test('corrupted download is neither extracted nor executed, even with an old cached executable', async t => {
  const dir = temp(t); writeFileSync(join(dir, 'uv'), 'unverified-old-cache')
  let extracted = false, executed = false, calls = 0
  const result = await ensureUv({ dir, platform: 'linux', arch: 'x64',
    fetcher: async url => { calls++; assert.match(url, /^https:\/\/github.com\/astral-sh\/uv\/releases\/download\/0\.13\.6\//); return new Response('corrupt archive') },
    extract: () => { extracted = true }, run: () => { executed = true },
  })
  assert.equal(result, null); assert.equal(calls, 1); assert.equal(extracted, false); assert.equal(executed, false)
})
test('unsupported uv architecture stops without guessing an executable', async t => {
  assert.equal(await ensureUv({ dir: temp(t), platform: 'linux', arch: 'riscv64', fetcher: () => { throw Error('must not download') } }), null)
})

function fixture(t, cfg = defaults) {
  const dir = temp(t), pkg = join(dir, 'plugin'), home = join(dir, 'state')
  mkdirSync(join(pkg, 'tools'), { recursive: true }); mkdirSync(home)
  cpSync(join(root, 'lib'), join(pkg, 'lib'), { recursive: true })
  cpSync(join(root, 'tools/mcp-server.mjs'), join(pkg, 'tools/mcp-server.mjs'))
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg))
  writeFileSync(join(home, 'douyin_cookie.txt'), 'fixture-only-not-a-credential')
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  mkdirSync(join(home, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true })
  writeFileSync(join(home, py), '')
  const call = (name, args = {}, env = {}) => {
    const req = name === 'tools/list' ? { method: name } : { method: 'tools/call', params: { name, arguments: args } }
    const result = spawnSync(process.execPath, [join(pkg, 'tools/mcp-server.mjs')], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DOUYIN_HOME: home, DOUYIN_BACKGROUND: '0', DOUYIN_ALLOW_COMMENTS: '0', ...env },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, ...req }) + '\n' })
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout.trim())
    return response.error ? response : response.result.content ? JSON.parse(response.result.content[0].text) : response.result
  }
  return { home, pkg, py, call, stub: (script, body) => writeFileSync(join(pkg, 'tools', script), body) }
}
const echoArgs = `console.log(JSON.stringify({ok:true,sent:true,argv:process.argv.slice(2),to_sec_uid:'MS4w-Bob',to:'Bob'}))`
test('MCP manual write without confirm returns draft, even if autoSend is enabled', t => {
  const f = fixture(t, { ...defaults, autoSend: true })
  assert.equal(f.call('douyin_dm', { to: 'Bob', text: 'draft' }).needsConfirm, true)
})
test('MCP nickname-only recipient reaches child without a default ID', t => {
  const f = fixture(t); f.stub('im-send.mjs', echoArgs)
  const r = f.call('douyin_dm', { to: 'Bob', text: 'fixture', confirm: true })
  assert.deepEqual(r.argv, ['--to', 'Bob', '--text', 'fixture'])
})
test('background MCP hides writes by default and enforces recipient scope after enabling', t => {
  const f = fixture(t, { ...defaults, autoSend: false })
  const env = { DOUYIN_BACKGROUND: '1' }
  assert.equal(f.call('tools/list', {}, env).tools.some(x => x.name === 'douyin_dm'), false)
  assert.equal(f.call('douyin_dm', { text: 'fixture', confirm: true }, env).error.code, -32602)
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...defaults, autoSend: true }))
  assert.match(f.call('douyin_dm', { to: 'Bob', to_id: 'MS4w-Bob', text: 'fixture', confirm: true }, env).error, /明确选中/)
  f.stub('im-send.mjs', echoArgs)
  assert.equal(f.call('douyin_dm', { text: 'fixture', confirm: true }, env).sent, true)
})
test('background comment permission is separate and refreshed from disk', t => {
  const f = fixture(t, { autoSend: true, autoComment: false, commentAtMe: false })
  const env = { DOUYIN_BACKGROUND: '1', DOUYIN_ALLOW_COMMENTS: '1' }
  assert.match(f.call('douyin_comment_reply', { confirm: true }, env).error, /自动评论已关闭/)
  assert.match(f.call('douyin_comment_mention', { name: 'Bob', confirm: true }, env).error, /明确选中/)
})
test('MCP reports child exit diagnostics and retains structured hint/detail', t => {
  const f = fixture(t)
  f.stub('im-send.mjs', `console.error('Edge profile locked'); process.exit(21)`)
  assert.match(f.call('douyin_dm', { text: 'fixture', confirm: true }).stderr_tail, /profile locked/)
  f.stub('card-share.mjs', `console.log(JSON.stringify({ok:false,error:'profile locked',hint:'close owned instance',detail:{exit:21}})); process.exit(1)`)
  const r = f.call('douyin_share_card', { aweme_id: '123', confirm: true })
  assert.equal(r.ok, false); assert.equal(r.results[0].hint, 'close owned instance'); assert.equal(r.results[0].detail.exit, 21)
})
test('share rejects numeric uid and does not send reason when card status is uncertain', t => {
  const f = fixture(t)
  assert.match(f.call('douyin_share_card', { to: 'Bob', to_id: '1234', aweme_id: '123', confirm: true }).error, /sec_uid/)
  f.stub('card-share.mjs', `console.log(JSON.stringify({ok:false,sent:false,pending:true,error:'unknown'}))`)
  const result = f.call('douyin_share_card', { aweme_id: '123', confirm: true, reason: 'must not send' })
  assert.equal(result.reason, undefined); assert.equal(result.sent, 0)
})
test('MCP read and remember share persistent context', t => {
  const f = fixture(t)
  f.stub('im-send.mjs', `console.log(JSON.stringify({ok:true,to:'Bob',to_sec_uid:'MS4w-Bob',messages:[{from:'them',text:'fixture hello'}]}))`)
  assert.equal(f.call('douyin_im_read', { to: 'Bob' }).context.total_remembered, 1)
  assert.deepEqual(f.call('douyin_remember', { to_id: 'MS4w-Bob', facts: ['fixture fact'] }).facts, ['fixture fact'])
  assert.deepEqual(f.call('douyin_im_read', { to: 'Bob' }).context.facts, ['fixture fact'])
})
test('MCP at_me includes reply types, root ID, seen filtering, and failed notice status', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  rmSync(join(f.home, f.py)); symlinkSync(process.execPath, join(f.home, f.py))
  f.stub('notice-read.py', `console.log(JSON.stringify({ok:true,items:[{type:31,aweme_id:'video',comment_id:'reply',root_comment_id:'root'},{type:32,aweme_id:'video',comment_id:'second'},{type:45,aweme_id:'other',comment_id:'mention'}]}))`)
  assert.equal(f.call('douyin_at_me').list[0].root_comment_id, 'root')
  f.stub('comment-api.mjs', `console.log(JSON.stringify({ok:true,cid:'sent-cid'}))`)
  assert.equal(f.call('douyin_comment_reply', { aweme_id: 'video', comment_id: 'reply', text: 'fixture', confirm: true }).ok, true)
  assert.equal(f.call('douyin_at_me').list.length, 2)
  assert.equal(f.call('douyin_at_me', { include_seen: true }).list[0].seen, true)
  f.stub('notice-read.py', `console.log(JSON.stringify({ok:false,error:'upstream unavailable'}));process.exit(1)`)
  assert.equal(f.call('douyin_at_me').ok, false)
})
