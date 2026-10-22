/**
 * selfcheck.mjs —— 不装进 DSH 也能跑的本地预检
 * ============================================================================
 * 用途：装之前先确认「文件齐不齐 / 能 import 吗 / Python 编译过吗 / 示例数据能跑吗」。
 *
 * 跑法（插件根目录）：
 *     node selfcheck.mjs
 *
 * ⚠️ 它**不**启动 DSH、**不**启动浏览器、**不**联网。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findBrowser } from './lib/chrome.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) }
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) }
const warn = (m) => { console.log(`  ⚠️  ${m}`) }

console.log('dsh-douyin-scroll 本地预检\n')

/* ── 1. 必需文件 ── */
console.log('1. 文件清单')
const required = [
  'package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'requirements.txt',
  'lib/hostdeps.mjs', 'lib/state.mjs', 'lib/credential.mjs', 'lib/notify.mjs', 'lib/toast.mjs', 'lib/uvfetch.mjs',
  'prompts/duty.md', 'prompts/persona.default.md', 'prompts/sample-candidates.json',
  // 采集 / 发送这一层：全是自带的脚本（2026-10-21 起不再有 vendor/ 里的内置 MCP）
  'tools/forward-pick.py', 'tools/forward-run.mjs', 'tools/notice-read.py', 'tools/api-comments.py',
  'tools/comment-api.mjs', 'tools/comment-delete.mjs', 'tools/card-share.mjs', 'tools/im-send.mjs',
  'tools/qr-login.mjs', 'tools/session-guard.py', 'tools/dy-signer.mjs',
]
for (const f of required) {
  if (existsSync(join(here, f))) ok(f)
  else bad(`缺文件：${f}`)
}

/* ── 2. package.json 契约 ── */
console.log('\n2. package.json')
try {
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  if (pkg.name === 'dsh-douyin-scroll') ok('name = dsh-douyin-scroll')
  else bad(`name 应为 dsh-douyin-scroll，实际 ${pkg.name}`)
  if (pkg.dsh?.bundle?.patch) ok(`bundle patch = ${pkg.dsh.bundle.patch}`)
  else bad('缺少 dsh.bundle.patch')
  if (pkg.dsh?.client?.platform === 'web') ok('client platform = web')
  else warn('没有 dsh.client.platform = web（设置页可能不加载）')
} catch (e) { bad(`package.json 读不了：${e.message}`) }

/* ── 3. cordis.patch.yml 的 id 必须等于命名空间 ── */
console.log('\n3. cordis.patch.yml')
try {
  const y = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
  if (/id:\s*douyin-scroll\b/.test(y)) ok('entry id = douyin-scroll（必须等于命名空间）')
  else bad('entry id 不是 douyin-scroll —— 设置页会写不进去（"no volatile fields"）')
} catch (e) { bad(`读不了：${e.message}`) }

/* ── 4. JS 语法 ── */
console.log('\n4. JS 语法（node --check）')
for (const f of ['index.js', 'client.js', ...readdirSync(join(here, 'lib')).filter((x) => x.endsWith('.mjs')).map((x) => join('lib', x))]) {
  const r = spawnSync(process.execPath, ['--check', join(here, f)], { encoding: 'utf8' })
  if (r.status === 0) ok(f)
  else bad(`${f}：${(r.stderr || '').split('\n').slice(0, 3).join(' ')}`)
}

/* ── 4b. 私信「谁发的」判据不能被退回去 ── */
console.log('\n4b. 私信发送方判据')
try {
  const s = readFileSync(join(here, 'tools', 'im-send.mjs'), 'utf8')
  if (/avatar-side/.test(s)) ok('im-send.mjs 用「头像左右」判发送方')
  else bad('im-send.mjs 里没有 avatar-side 判据 —— 回读会退回「分不清谁发的」')
  if (/--read/.test(s)) ok('im-send.mjs 有 --read 只读模式（douyin_im_read 靠它）')
  else bad('im-send.mjs 缺 --read 模式 —— douyin_im_read 会读不到')
  // 曾经的错：拿 message.isMyMessage 当发送方判据 —— 它**恒为 true**，连对方发的也是 true
  if (/mine:\s*!!found\.isMyMessage/.test(s)) bad('im-send.mjs 又把 isMyMessage 当发送方判据了 —— 它恒为 true，不能用')
  else ok('没有退回用 isMyMessage 判发送方')
} catch (e) { bad(`读不了 tools/im-send.mjs：${e.message}`) }

/* ── 4c. 「先卡片，后文字」这条规矩不能被改回去 ── */
console.log('\n4c. 发送顺序规矩（先卡片，后文字）')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  if (/orderWarning/.test(idx)) ok('index.js 有顺序哨兵 orderWarning')
  else bad('index.js 里没有 orderWarning —— 「刚发过文字又发卡片」不会有人提醒了')
  if (/先卡片，后文字/.test(idx)) ok('工具说明里写明了「先卡片，后文字」')
  else bad('douyin_dm / douyin_share_card 的说明里没有这条规矩 —— 模型会先发文字')
  if (/reason_delay_sec/.test(idx)) ok('share_card 支持 reason + reason_delay_sec（卡片后自动补理由）')
  else bad('share_card 丢了 reason 参数 —— 只能发一张光秃秃的卡片')
  const charter = readFileSync(join(here, 'prompts', 'duty.md'), 'utf8')
  if (/先卡片，后文字/.test(charter)) ok('章程 prompts/duty.md 里写明了这条规矩')
  else bad('章程里没写「先卡片，后文字」—— 每轮都会忘')
} catch (e) { bad(`读不了规矩相关文件：${e.message}`) }

/* ── 4d. 人设分家：不许串门 ── */
console.log('\n4d. 人设分家')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  if (/persona:/.test(idx) && /personaWarn/.test(idx)) {
    ok('runDuty 会校验人设文件第一行的 persona 标记')
  } else bad('index.js 里没有 persona 标记校验 —— 任何一份 AGENTS.md 都会被当成人设照抄')
  // ⭐ 三层人设：使用者自己那份 > 插件自带 > 默认中性
  const layers = ['join(stateDir, \'persona.md\')', 'prompts\', \'persona.md', 'persona.default.md']
  const missing = layers.filter((k) => !idx.includes(k.replace(/\\/g, '')))
  if (!missing.length) ok('人设三层齐全（使用者自己 / 插件自带 / 默认中性）')
  else bad(`人设层缺失：${missing.join('、')}`)
  if (/personaFrom/.test(idx)) ok('会记录本轮用的是哪一层人设')
  else warn('没记录人设来源，出问题不好查')
  if (!/cfg\.workspace/.test(idx)) ok('不再从 workspace 读外部 AGENTS.md（口子已封）')
  else bad('index.js 还在用 cfg.workspace —— 那正是"能读到别人插件设定"的口子')
  // 人设规则不许被搬进章程：章程里只应有指向，不该出现「我是主人的小鱼呀」这种人设台词
  const charter2 = readFileSync(join(here, 'prompts', 'duty.md'), 'utf8')
  const identity = ['鲸鱼娘', '我是主人的小鱼呀', '禁说']
  const leaked = identity.filter((k) => charter2.includes(k))
  if (!leaked.length) ok('章程里没有夹带人设台词（身份只指向 AGENTS.md）')
  else bad(`章程里夹带了人设台词：${leaked.join('、')} —— 人设只许住在 AGENTS.md`)
  // 🔴 硬隔离：抖音的代码里不许出现刷B站的**家目录 / 人设目录**路径。
  //    ⚠️ 出处注释（"抄 dsh-bili-scroll 的约定"）是允许的 —— 那是记账，不是耦合。
  const codeFiles = ['client.js',
    ...readdirSync(join(here, 'lib')).filter((x) => x.endsWith('.mjs')).map((x) => join('lib', x)),
    ...readdirSync(join(here, 'tools')).filter((x) => /\.(mjs|js|py)$/.test(x)).map((x) => join('tools', x))]
  const hits = codeFiles.filter((f) => /bili[-_](duty|persona)/i.test(readFileSync(join(here, f), 'utf8')))
  if (hits.length) bad(`抖音的代码里出现了刷B站的家目录/人设路径：${hits.join(', ')}`)
  else ok(`代码里没有刷B站的家目录/人设路径（查了 ${codeFiles.length} 个文件）`)
  const pf = join(here, 'prompts', 'persona.default.md')
  if (existsSync(pf) && /^<!-- persona: default -->/.test(readFileSync(pf, 'utf8').trimStart())) {
    ok('默认人设 prompts/persona.default.md 带身份牌 persona: default')
  } else bad('默认人设缺身份牌 —— 发布包必须自带一份中性人设，否则普通用户装了什么都没有')
  // 🔴 发布边界：作者自己那份人设不许进仓库
  const gi = readFileSync(join(here, '.gitignore'), 'utf8')
  if (/^prompts\/persona\.md$/m.test(gi)) ok('.gitignore 排除了作者自己的 prompts/persona.md（不随包发布）')
  else bad('.gitignore 没排除 prompts/persona.md —— 作者的人设会被推到公开仓库')
} catch (e) { bad(`人设分家检查失败：${e.message}`) }

/* ── 4e. 采集门槛 / 跨天记账 ── */
console.log('\n4e. 采集门槛 / 跨天')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const fp = readFileSync(join(here, 'tools', 'forward-pick.py'), 'utf8')
  // ⚠️ 键名是 camelCase（index.js 的 syncCollectorCfg 就写 minDescLen / minComments），
  //    以前这里检查的是 snake_case，跟真实数据不符 ⇒ 永远红。
  if (/collector\.json/i.test(fp) && /minDescLen/.test(fp) && /minComments/.test(fp)) {
    ok('forward-pick.py 真的读 collector.json（设置页的阈值不再空转）')
  } else bad('forward-pick.py 没读 collector.json —— 设置页的「文案太短 / 评论少」两个旋钮是死的')
  if (/"dropped"/.test(fp) && /short_and_quiet/.test(fp)) {
    ok('forward-pick.py 产出 dropped（报告能写清因什么跳过几条）')
  } else bad('forward-pick.py 没有 dropped —— prompt 让模型数数，证据包里却没有')
  if (/dropped:\s*picked\.dropped/.test(idx)) ok('round-evidence.json 带上了 dropped')
  else bad('index.js 的证据包没带 dropped')
  if (/'--limit'/.test(idx)) ok('「每次最多筛选几个」传给了 forward-pick.py（--limit）')
  else bad('maxPerRun 没有传给采集脚本 —— 超过 10 条永远不生效')
  if (/const rollDay/.test(idx) && /rollDay\(\)/.test(idx) && /dayKey\(\)/.test(idx)) {
    ok('state.json 跨天会自己翻篇（不再停在旧日期）')
  } else bad('没有跨天翻篇 —— 长时间挂着插件时 state.json 会一直停在旧日期')
} catch (e) { bad(`采集门槛检查失败：${e.message}`) }

/* ── 5. Python 能否编译 + 判断层能否跑 ── */
console.log('\n5. Python')
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const ver = spawnSync(py, ['--version'], { encoding: 'utf8' })
if (ver.status === 0) {
  ok(`${py} → ${(ver.stdout || ver.stderr || '').trim()}`)
  const files = readdirSync(join(here, 'tools')).filter((x) => x.endsWith('.py')).map((x) => join('tools', x))
  const c = spawnSync(py, ['-m', 'py_compile', ...files.map((f) => join(here, f))], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
  if (c.status === 0) ok(`Python 语法全过（${files.length} 个文件）`)
  else bad(`Python 编译失败：${(c.stderr || '').split('\n').slice(0, 5).join(' ')}`)

  // ⭐ 真正的价值：跑一遍判断层自检
  const s = spawnSync(py, [join(here, 'tools', 'smoke.py')], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
  if (s.status === 0 && /判断层是通的/.test(s.stdout || '')) ok('判断层自检通过（tools/smoke.py）')
  else {
    bad('判断层自检没有通过')
    console.log((s.stdout || '').split('\n').slice(0, 20).map((l) => '     ' + l).join('\n'))
    if (s.stderr) console.log((s.stderr || '').split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'))
  }
} else {
  warn(`没有可用的 python（试过 "${py}"）—— 装完依赖后采集脚本才需要它，预检这一步可以跳过`)
}

/* ── 6. 外部工具（可选） ── */
console.log('\n6. 可选外部工具')
// ⭐ 用 lib/chrome.mjs 的探测逻辑，别再各写一份写死的路径（换台机器就误报）
const found = findBrowser()
if (found) ok(`浏览器已找到：${found}（无头发私信 / 卡片 / 评论要用它）`)
else warn('没找到 Chrome / Edge / Chromium —— 发私信 / 卡片 / 评论会失败；'
  + '装一个，或把完整路径写进环境变量 DOUYIN_BROWSER')
const dsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
if (dsh.status === 0) ok('dsh 在 PATH 里')
else warn('dsh 不在 PATH —— 桌面版正常（插件会自动去应用目录找）；npm 装的请确认 PATH')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('有失败项 —— 先把上面标 ❌ 的修掉再装。')
  process.exit(1)
}
console.log('预检通过。下一步：dsh plugin --profile web add link:<本目录绝对路径>，然后重启 dsh。')
