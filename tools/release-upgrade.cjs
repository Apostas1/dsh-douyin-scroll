/**
 * tools/release-upgrade.cjs —— 模拟「已装过的人升级」的兼容性检查
 *
 * 为什么单独有这个（2026-10-26）：
 *   新装和升级是两条完全不同的路。新装是"干净开始"，升级是"带着旧配置进来"。
 *   升级要炸的地方都是本机测不出来的：
 *     · 新字段有默认值吗（旧 config.json 里没有这个键）
 *     · 旧值会不会把新逻辑带歪（比如老用户 chatWatch=true + 新逻辑默认关）
 *     · 被删掉的功能字段还在旧配置里（残留键会不会让模型/面板混乱）
 *
 * 用法：node tools/release-upgrade.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const INDEX = path.join(root, 'index.js')

let fail = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { console.log('  ❌ ' + m); fail++ }
const warn = (m) => console.log('  ⚠️ ' + m)

const src = fs.readFileSync(INDEX, 'utf8')

/* ── 1. 从 index.js 解析出 DEFAULTS（跟插件真实行为一致） ── */
console.log('【1】解析当前版本的 DEFAULTS')
const m = src.match(/const DEFAULTS = \{([\s\S]*?)\n  \}/)
if (!m) { bad('读不到 DEFAULTS'); process.exit(1) }
const defaults = {}
for (const line of m[1].split('\n')) {
  // 一行可能挤着多个键（chatWatch: false, chatWatchSec: 30, ...）
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('(?:[^'\\]|\\.)*'|"[^"]*"|true|false|\d+(?:\.\d+)?|\[\]|[A-Za-z_][\w]*)/g
  let x
  while ((x = re.exec(line))) {
    const [, k, raw] = x
    if (['const', 'let', 'return'].includes(k)) continue
    if (k in defaults) continue
    defaults[k] = raw
  }
}
const keys = Object.keys(defaults)
console.log(`  解析到 ${keys.length} 个字段`)
if (keys.length >= 25) ok('字段数量正常')
else bad(`只解析到 ${keys.length} 个字段，解析可能失效`)

/* ── 2. 老用户的 config.json 里缺新字段 → 必须能补上 ── */
console.log('\n【2】老配置缺新字段（升级最常炸的地方）')
// 模拟一份"2026-10-20 的老配置"：只有最早期那批字段，且没有新加的
const OLD_CONFIG = {
  perDay: 5, maxPerRun: 12, noon: true, night: true, windows: [],
  keywords: ['猫'], channels: [], authors: [],
  minDescLen: 12, minComments: 3, autoComment: false, autoSend: true,
  commentAtMe: false, commentSelfName: '',
  notifyMode: 'toast', dmTo: '', dmToId: '',
  reportLevel: 'full', pythonPath: 'python',
}
// 关键新字段：老配置里一定没有，插件必须靠 DEFAULTS 补上
const NEW_FIELDS = ['chatWatch', 'chatWatchTarget', 'petLinkTo']
for (const k of NEW_FIELDS) {
  if (k in defaults) ok(`${k} 有默认值 —— 老配置缺它不会崩`)
  else bad(`${k} 没有默认值 —— 老用户升级后这个功能直接不生效`)
}
// 老配置里没有的键，读出来应该等于 DEFAULTS
const missing = keys.filter((k) => !(k in OLD_CONFIG))
console.log(`  老配置里缺 ${missing.length} 个字段，都会用 DEFAULTS 补`)

/* ── 3. 老配置残留的死字段（被删掉的功能）会不会惹祸 ── */
console.log('\n【3】老配置里的残留死字段')
// 这些是历史上存在过、现在已从 schema 删掉的
const REMOVED = ['petOn', 'petPersona', 'petDanmaku', 'petDanmakuMode', 'petToolbar', 'petVoice', 'petVoiceName', 'workspace']
const stillInSchema = REMOVED.filter((k) => k in defaults)
if (!stillInSchema.length) ok('老的 pet* / workspace 字段都已从 schema 移除（残留值会被忽略，不会报错）')
else warn(`schema 里还留着：${stillInSchema.join(', ')}`)

/* ── 4. 老用户的关键取值不会被新默认值带歪 ── */
console.log('\n【4】老用户的值不会被新默认值覆盖')
// chatWatch 默认从 true 改成了 false（2026-10-26）。老用户磁盘上是 true，
// 靠 DISK_WINS + intent 自愈保住 —— 这两条必须在。
if (/const DISK_WINS = \['chatWatch', 'chatWatchTarget'\]/.test(src)) ok('chatWatch 走"磁盘优先"—— 新默认值不会覆盖老用户的值')
else bad('缺 DISK_WINS —— 新默认 false 会把老用户的 true 顶掉（他重启后发现不工作了）')
if (/chatIntentFile/.test(src) && /wantOn/.test(src)) ok('有 intent 自愈 —— 老用户重启后开关自动恢复')
else bad('缺 intent 自愈 —— 老用户重启后开关变关，以为坏了')
if (/chatWatch: z\.boolean\(\)\.default\(false\)/.test(src)) ok('新装默认关（安全默认）')
else bad('新装默认不是关')

/* ── 5. 面板对老配置的兼容（缺失字段不能渲染崩） ── */
console.log('\n【5】面板遇到缺失字段不会崩')
const cli = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
// 面板里读 cfg.xxx 的地方，关键字段应该有兜底（|| 或 ?. 或 !== undefined）
const risky = []
for (const k of ['chatWatchTarget', 'petLinkTo', 'commentSelfName', 'chatWatchSec']) {
  const re = new RegExp(`cfg\\.${k}(?!\\s*[|?&.=><!])`)
  const uses = [...cli.matchAll(new RegExp(`cfg\\.${k}`, 'g'))].length
  if (uses === 0) continue
  const guarded = new RegExp(`cfg\\.${k}\\s*(\\|\\||\\?\\?|\\?|!==|===)`).test(cli)
  if (!guarded) risky.push(k)
}
if (!risky.length) ok('关键字段都有兜底（|| / ?? / 显式比较）')
else warn(`这些字段可能没兜底：${risky.join(', ')}（老配置缺它时显示可能不对）`)

/* ── 6. 结论 ── */
console.log('')
if (fail) { console.log(`❌ ${fail} 项失败，升级路径有问题`); process.exit(1) }
console.log('✅ 升级路径检查通过')
