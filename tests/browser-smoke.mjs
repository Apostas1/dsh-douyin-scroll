/** Explicit opt-in: local HTML, disposable profile, no Douyin navigation or real messages. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { findBrowser, connectPage, sleep } from '../lib/chrome.mjs'
import { connectCdp, probeBrowser } from '../lib/browser-ownership.mjs'
import { createTaskPage } from '../lib/task-page.mjs'
import { deliverIm } from '../lib/im-delivery.mjs'

const browser = findBrowser()
assert.ok(browser, 'Chrome/Edge/Chromium is required for this explicit browser smoke test')
const home = mkdtempSync(join(tmpdir(), 'douyin-browser-fixture-'))
process.env.DOUYIN_HOME = home
const profile = join(home, 'chrome-profile')
const server = createServer()
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const child = spawn(browser, ['--headless=new', '--enable-automation', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only',
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
let launchError, owned
child.on('error', e => { launchError = e })
const exited = new Promise(resolve => child.once('exit', resolve))
const pages = []
try {
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError
    if (child.exitCode !== null) throw Error(`Fixture Chrome exited: ${child.exitCode}`)
    owned = await probeBrowser(port, profile)
    if (owned) break
    await sleep(250)
  }
  assert.ok(owned, 'Fixture browser did not start within 15 seconds')
  const html = editor => `<!doctype html><html><body><div class="componentsRightPanel">
    ${editor === 'textarea' ? '<textarea style="width:400px;height:80px">残留旧草稿</textarea>' : '<div contenteditable="true" style="width:400px;height:80px">残留旧草稿</div>'}
    </div><script>
      window.messages=[];window.enters=0;window.contact='fixture';window.delay=3200;window.echo=true;
      const e=document.querySelector('textarea,[contenteditable]');
      e.addEventListener('keydown', event=>{if(event.key!=='Enter')return;event.preventDefault();window.enters++;
        const text=e.value??e.innerText;
        if(window.echo)setTimeout(()=>{window.messages.unshift({from:'me',text});if(e.tagName==='TEXTAREA')e.value='';else e.innerText=''},window.delay);
      });
    </script></body></html>`
  const newPage = async editor => {
    const c = await connectCdp(owned.wsUrl, port)
    const p = await createTaskPage(c, { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html(editor)), connect: targetId => connectPage(port, { targetId }) })
    pages.push(p); return p
  }
  const a = await newPage('textarea'), b = await newPage('editable')
  const aUrl = await a.ev('location.href')
  await b.send('Page.navigate', { url: 'about:blank' })
  assert.equal(await a.ev('location.href'), aUrl, 'Independent report navigation must not change chat page')
  await b.close()
  const run = (page, text, timeoutMs = 10000) => deliverIm({ page, text, beforeMessages: [],
    readMessages: () => page.ev('window.messages'), verifyTarget: () => page.ev("window.contact === 'fixture'"), timeoutMs })
  const r = await run(a, 'macOS 回执测试：全新正文')
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.elapsed_ms >= 3000)
  assert.equal(await a.ev('window.enters'), 1)
  assert.equal(await a.ev('window.messages[0].text'), 'macOS 回执测试：全新正文', 'Old draft must be replaced')
  const c = await newPage('editable')
  const cr = await run(c, 'contenteditable 草稿替换')
  assert.equal(cr.ok, true, JSON.stringify(cr)); assert.equal(await c.ev('window.messages[0].text'), 'contenteditable 草稿替换')
  await c.ev('window.echo=false;window.messages=[]')
  const pending = await run(c, '没有回执的测试', 1200)
  assert.equal(pending.pending, true); assert.equal(pending.retry_safe, false)
  assert.equal(await c.ev('window.enters'), 2, 'Exactly one new Enter for the pending operation')
  await Promise.all(pages.map(p => p.close()))
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  assert.equal(targets.filter(t => t.type === 'page').length, 1, 'Only initial inert page should remain')
  console.log(JSON.stringify({ ok: true, platform: process.platform, checks: ['isolated navigation', 'delayed echo 3.2s', 'textarea draft replacement', 'contenteditable draft replacement', 'single submission on missing echo', 'owned target cleanup'] }))
} finally {
  await Promise.all(pages.map(p => p.close().catch(() => {})))
  if (owned) {
    const c = await connectCdp(owned.wsUrl, port).catch(() => null)
    if (c) { await c.send('Browser.close').catch(() => {}); c.close() }
  }
  if (child.exitCode === null && !launchError) {
    await Promise.race([exited, sleep(2000)])
    if (child.exitCode === null) child.kill('SIGTERM') // Only the exact test child, never other browsers.
    await Promise.race([exited, sleep(2000)])
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}
