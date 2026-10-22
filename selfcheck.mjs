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
  'lib/paths.mjs', 'lib/chrome.mjs',
  'prompts/duty.md', 'prompts/persona.default.md', 'prompts/sample-candidates.json',
  // 给别的 AI / MCP 用的那一层
  'AI-USAGE.md', 'tools/mcp-server.mjs', 'tools/doctor.mjs', 'check-client.mjs',
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
for (const f of ['index.js', 'client.js',
  ...readdirSync(join(here, 'lib')).filter((x) => x.endsWith('.mjs')).map((x) => join('lib', x)),
  ...readdirSync(join(here, 'tools')).filter((x) => x.endsWith('.mjs')).map((x) => join('tools', x))]) {
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

/* ── 4f. 自定义时段 ──
 * ⚠️ 2026-10-22：自定义时段的**界面**在"面板重写"时被砍掉了（那一版为了救回面板，
 *    只保留 4 个卡片）。后端（schema / normalize / tick）还在，随时能加回。
 *    所以这里只检查**后端**不会退化；UI 部分改成 warn，不判失败。
 */
console.log('\n4f. 自定义时段（后端）')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  // schema 里要有 windows 字段
  if (/windows:\s*z\.array\(z\.object/.test(idx)) ok('Config 有 windows 字段（对象数组）')
  else bad('Config 缺 windows —— 自定义时段存不进去')
  // 🔴 schemastery 兼容性：这个版本的字符串没有 .optional()，写了会让整个 index.js import 失败
  //    （2026-10-22 事故：一个 .optional() 让 fiberPhase 恒为 null，面板和工具全消失）
  const codeOnly = idx.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (!/\.optional\(\)/.test(codeOnly)) ok('没有用 .optional()（这个 schemastery 版本不支持）')
  else bad('代码里用了 .optional() —— 这个 schemastery 版本没有这个方法，index.js 会 import 失败、插件整个不加载')
  // normalize 必须按字段名判断，不能靠"数组里有元素"
  if (/OBJECT_ARRAYS/.test(idx) && /windows/.test(idx)) ok('normalize 用白名单保住对象数组（空数组也不会吃）')
  else bad('normalize 还在靠 base[k].length 判断 —— 空 DEFAULT 会把对象数组吃光')
  // tick 必须把自定义时段并进去
  if (/custom:\$\{i\}/.test(idx) && /cfg\.windows/.test(idx)) ok('定时器会把自定义时段拼进候选窗口')
  else bad('定时器没读 cfg.windows —— 配了也不跑')
  // ⚠️ 总开关 peakValley 不许再拦截（UI 已经没有它了）
  const hasPeakGate = /^\s*if \(!cfg\.peakValley\) return\s*$/m.test(idx)
  if (!hasPeakGate) ok('没有 peakValley 总闸拦截（UI 已无此开关，拦了就是死锁）')
  else bad('tick 里还有 `if (!cfg.peakValley) return` —— 设置页没有这个开关，用户配了也不会跑')
  // UI 还没做回来 —— 只提示，不算失败
  if (/\+ 加一个时段/.test(cl)) ok('设置页有自定义时段入口')
  else warn('设置页暂时没有自定义时段入口（后端已就绪，加回来只是一个卡片的事）')
} catch (e) { bad(`自定义时段检查失败：${e.message}`) }

/* ── 4g. 给别的 AI 用（MCP server） ── */
console.log('\n4g. 给别的 AI 用')
try {
  const mcpFile = join(here, 'tools', 'mcp-server.mjs')
  const mcp = existsSync(mcpFile) ? readFileSync(mcpFile, 'utf8') : ''
  if (!mcp) bad('缺 tools/mcp-server.mjs —— 别的 agent 工具接不进来')
  else {
    // ① 必须零依赖：只许 import node: 内置模块 + 相对路径
    const imports = [...mcp.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])
    const external = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
    if (external.length) bad(`mcp-server.mjs 引入了外部依赖：${external.join(', ')} —— 这个包没有 node_modules，会直接崩`)
    else ok(`mcp-server.mjs 零依赖（${imports.length} 个 import 全是 node: / 相对路径）`)
    // ② stdout 只能出 JSON-RPC
    if (/console\.log/.test(mcp.replace(/--selftest[\s\S]*$/, ''))) {
      bad('mcp-server.mjs 正文里用了 console.log —— 会污染 JSON-RPC 的 stdout，客户端会崩')
    } else ok('mcp-server.mjs 正文不往 stdout 打日志（只走 stderr）')
    // ③ 真跑一遍协议握手
    const st = spawnSync(process.execPath, [mcpFile, '--selftest'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PYTHONUTF8: '1' },
    })
    const out = String(st.stdout || '')
    if (st.status === 0 && /#1 initialize -> ok/.test(out) && /#2 tools\/list -> \d+ tools/.test(out)) {
      const n = (out.match(/#2 tools\/list -> (\d+) tools/) || [])[1]
      ok(`mcp-server.mjs 自测通过（initialize + tools/list，${n} 个工具）`)
    } else bad(`mcp-server.mjs 自测失败：${(out || st.stderr || '').split('\n').slice(0, 3).join(' ')}`)
    // ④ 会发东西的工具必须有 confirm 闸
    const sendTools = ['douyin_share_card', 'douyin_dm', 'douyin_comment_reply']
    const missing = sendTools.filter((t) => {
      const i = mcp.indexOf(`name: '${t}'`)
      if (i < 0) return true
      const seg = mcp.slice(i, i + 2500)
      return !/confirm: \{ type: 'boolean'/.test(seg) || !/args\?\.confirm !== true/.test(seg)
    })
    if (missing.length) bad(`这些 MCP 工具没有 confirm 闸：${missing.join(', ')}`)
    else ok(`${sendTools.length} 个会发东西的 MCP 工具都带 confirm 闸`)
  }
  // ⑤ 使用说明必须存在，且写清「先卡片后文字」
  const doc = join(here, 'AI-USAGE.md')
  if (existsSync(doc)) {
    const d = readFileSync(doc, 'utf8')
    if (/先卡片，后文字/.test(d)) ok('AI-USAGE.md 写明了「先卡片，后文字」')
    else bad('AI-USAGE.md 没写「先卡片，后文字」—— 别的 AI 会按错的顺序发')
    if (/confirm: true/.test(d) || /confirm:true/.test(d)) ok('AI-USAGE.md 写明了 confirm 闸')
    else bad('AI-USAGE.md 没写 confirm 闸 —— 别的 AI 会直接发')
    if (/不读画面|ASR/.test(d)) ok('AI-USAGE.md 写明了「看不到画面」')
    else bad('AI-USAGE.md 没写「看不到画面」—— 别的 AI 会以为它能看视频')
  } else bad('缺 AI-USAGE.md —— 别的 AI 不知道怎么用')
} catch (e) { bad(`MCP / 使用说明检查失败：${e.message}`) }

/* ── 4h. 检查更新 ── */
console.log('\n4h. 检查更新')
try {
  const idx = readFileSync(join(here, 'index.js'), 'utf8')
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  if (/updateUrl:\s*z\.string\(\)/.test(idx)) ok('Config 有 updateUrl（可以指定自己的更新源）')
  else bad('Config 缺 updateUrl')
  if (/const checkUpdate\s*=/.test(idx) && /registry\.npmjs\.org/.test(idx)) ok('检查更新会查 npm registry')
  else bad('检查更新没有 npm 来源')
  if (/repoSlug/.test(idx) && /raw\.githubusercontent\.com/.test(idx)) ok('有 GitHub 来源（从 package.json 的 repository 推出来）')
  else bad('没有 GitHub 来源 —— 只发 GitHub 不验证 npm 的包永远查不到')
  // 🔴 只查不装：绝不能自动升级（改使用者的 profile 是他的机器）
  //    判据看**行为**：checkUpdate 那段里不许出现任何会去执行 `plugin add` 的调用。
  const updSeg = (() => {
    const i = idx.indexOf('const checkUpdate')
    return i < 0 ? '' : idx.slice(i, i + 3500)
  })()
  const installsItself = /spawn(Sync)?\([^)]*'plugin'/.test(updSeg)
    || /runNodeTool\('install\.mjs'/.test(updSeg)
    || /execSync\(/.test(updSeg)
  if (installsItself) bad('checkUpdate 里出现了会真去装包的调用 —— 检查更新只许"告诉有没有"，不许自己动')
  else ok('检查更新只查不装（不自动改 profile）')
  if (/\/update/.test(cl) && /检查更新/.test(cl)) ok('设置页有「检查更新」按钮')
  else bad('设置页没有检查更新入口')
} catch (e) { bad(`检查更新检查失败：${e.message}`) }

/* ── 4i. 设置页「给别的 AI 用」 ── */
console.log('\n4i. 设置页的 AI 接入块')
try {
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  if (/给别的 AI 用/.test(cl)) ok('设置页有「给别的 AI 用」卡片')
  else bad('设置页没有「给别的 AI 用」卡片')
  if (/\/ai-usage/.test(cl)) ok('卡片会调 /ai-usage 拿配置和说明')
  else bad('卡片没接 /ai-usage')
  if (/copy\(/.test(cl) && /clipboard/.test(cl)) ok('有复制按钮（clipboard + execCommand 兜底）')
  else bad('没有复制按钮 —— 让人手抄路径不现实')
} catch (e) { bad(`AI 接入块检查失败：${e.message}`) }

/* ── 4j. 设置页真的能渲染出来 ──
 * 🔴 2026-10-22 教训：`node --check` 只查语法。面板整块消失的原因是**渲染/加载时抛错**，
 *    语法完全合法。这一段用极小 React 替身把 Panel 真跑一遍 —— 白屏会在推之前被抓住。
 */
console.log('\n4j. 设置页渲染（真跑一遍）')
try {
  const r = spawnSync(process.execPath, [join(here, 'tools', 'panel-render-check.mjs')], {
    encoding: 'utf8', timeout: 120_000,
  })
  if (r.status === 0) {
    const n = (String(r.stdout || '').match(/元素树 (\d+) 个节点/) || [])[1]
    ok(`设置页能渲染（${n || '?'} 个节点，所有卡片都在）`)
  } else {
    const why = String(r.stdout || r.stderr || '').split('\n').filter((l) => l.includes('❌')).slice(0, 3).join(' ')
    bad(`设置页渲染失败：${why || String(r.stderr || '').slice(0, 200)}`)
  }
} catch (e) { bad(`渲染检查跑不起来：${e.message}`) }

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

/* ── 5b. 装机流程：先检查环境，再装依赖 ── */
console.log('\n5b. 装机流程（先检查，再装）')
try {
  const doc = readFileSync(join(here, 'tools', 'doctor.mjs'), 'utf8')
  // ① doctor 必须纯 Node —— 第一次装的时候还没有 Python
  if (/from '\.\.\/lib\/(paths|chrome)\.mjs'/.test(doc) && !/spawnSync\([^)]*doctor\.py/.test(doc)) {
    ok('doctor.mjs 是纯 Node（不需要 Python 就能跑）')
  } else bad('doctor.mjs 依赖了 Python —— 第一次装时必然「环境没装好」，用户卡死')
  // ② 设置页必须有「检查环境」按钮，且在「装依赖」之前（文案可变，位置不能变）
  const cl = readFileSync(join(here, 'client.js'), 'utf8')
  const iDoc = cl.search(/①\s*检查环境/)
  const iIns = cl.search(/②[^\n']*依赖/)
  if (iDoc > 0 && iIns > iDoc) ok('设置页顺序正确：① 检查环境 → ② 装依赖')
  else bad('设置页没有「先检查再装」的顺序 —— 用户不知道该装什么')
  // ③ 没检查过不许点装（简化版面板里 doctor 只是可选步骤，此项仅提示）
  if (/disabled: busy === 'install' \|\| !doctorOk/.test(cl)) ok('没检查过环境时「装依赖」是禁用的')
  else warn('「装依赖」没跟体检结果绑定（简化面板里算可选优化，不算失败）')
  // ④ 扫码之后可能要过验证 —— 必须告诉用户
  if (/短信验证码|滑块/.test(cl)) ok('设置页写明了扫码后可能还要过短信/滑块验证')
  else bad('设置页没提扫码后的验证 —— 用户会以为扫码失败，反复重扫')
  const qr = readFileSync(join(here, 'tools', 'qr-login.mjs'), 'utf8')
  if (/verifyHint/.test(qr) && /滑块|短信/.test(qr)) ok('qr-login.mjs check 会识别「卡在验证」并说清卡在哪一步')
  else bad('qr-login.mjs 只看 cookie —— 用户卡在验证页时只会被告知「还没扫」')
} catch (e) { bad(`装机流程检查失败：${e.message}`) }

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
