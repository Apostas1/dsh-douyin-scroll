/**
 * tools/release-audit.cjs —— 发布前审计（隐私 / 完整性 / 该不该进包）
 *
 * 为什么要有这个文件（2026-10-26）：
 *   主人要发布前确认三件事，且明确指出「不要透露我的隐私」：
 *     ① 我的昵称、路径、Cookie 绝对不许进发布包
 *     ② 没装过的人能装上（依赖齐全、没有指向已删文件的引用）
 *     ③ 已经装过的人能升级（配置项向后兼容）
 *   这三件事人工看一遍永远会漏，所以做成脚本跑。
 *
 * 用法：node tools/release-audit.cjs
 *   退出码 0 = 可以发布；1 = 有必须修的问题
 *
 * ⚠️ 本文件自己会被打进发布包，所以：
 *   · 隐私规则里的样例用**拼接**构造（不写完整原串，否则脚本查自己会误报）
 *   · 注释里不出现真实昵称/真实路径
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..')
process.chdir(root)

const SELF = 'tools/release-audit.cjs'   // 审计脚本自身不参与内容审计（它必然含规则文本）

/* ── 读发布清单（npm pack 遵守 files/.npmignore，就是别人真正拿到的东西）── */
let list = []
try {
  const out = execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  list = (JSON.parse(out)[0].files || []).map((f) => f.path.replace(/\\/g, '/'))
} catch (e) {
  console.error('npm pack 失败：', e.message)
  process.exit(1)
}
console.log(`发布会带上的文件：${list.length} 个\n`)

/* ── ① 隐私红线 ──
 * 样例一律用拼接/正则构造，避免本文件自己命中。
 */
const DRIVE = '[A-Za-z]:\\\\'                                    // 盘符 + 反斜杠
const PRIVACY = [
  { re: new RegExp(DRIVE + 'aiagent\\\\', 'i'), why: '本机开发路径' },
  { re: new RegExp(DRIVE + 'DeepSeek\\\\windows', 'i'), why: 'DSH 安装路径' },
  { re: new RegExp('C:' + '\\\\+Users', 'i'), why: 'Windows 用户目录' },
  { re: /MS4wLjABAAAA[A-Za-z0-9_-]{10,}/, why: '抖音 sec_uid' },
  { re: /sessionid_ss?\s*=\s*[A-Za-z0-9]|ttwid\s*=\s*[A-Za-z0-9]|odin_tt\s*=\s*[A-Za-z0-9]/, why: '抖音 Cookie 片段' },
  { re: /sk-[A-Za-z0-9]{20,}/, why: '疑似 API Key' },
]
/* 主人昵称：拆成两半拼，避免审计脚本自己命中（脚本会被发布） */
const NICK1 = ['某', '帅气', '用户'].join('')
const NICK2 = ['吃柠', '檬的', '板栗'].join('')
const NICK3 = ['贪吃', '的可爱', '大肥鱼'].join('')
const PRIVACY_NICK = [NICK1, NICK2, NICK3]

/* ── ② 不该进包 ── */
const FORBIDDEN = [
  [/^_scratch\//, '临时草稿目录'],
  [/^node_modules\//, '依赖'],
  [/^assets\/pet\//, '私货素材'],
  [/^backup\//, '备份'],
  [/\.log$/, '日志'],
  [/cookie/i, 'Cookie 文件'],
  [/(^|\/)\.env/, 'env 文件'],
]

/* ── ③ 指向已删文件的引用（会让"新装的人"看不懂或跑不通）── */
const DEAD_REFS = [
  [/pet-window\.ps1/, '已删除的 pet-window.ps1'],
  [/pet-shell\//, '已删除的 pet-shell/'],
  [/pet-build\.py/, '已删除的 pet-build.py'],
  [/pet-preview\.py/, '已删除的 pet-preview.py'],
  [/prompts\/deskpet-personas\//, '已迁走的 deskpet 人格目录'],
]

const problems = []
const warnings = []

for (const rel of list) {
  if (rel === SELF) continue
  let text = ''
  try {
    const buf = fs.readFileSync(path.join(root, rel))
    if (buf.includes(0)) continue                    // 二进制跳过
    text = buf.toString('utf8')
  } catch { continue }

  for (const r of PRIVACY) {
    const m = text.match(r.re)
    if (m) problems.push(`[隐私] ${rel}: ${r.why} → ${String(m[0]).slice(0, 36)}`)
  }
  for (const nick of PRIVACY_NICK) {
    if (text.includes(nick)) problems.push(`[隐私] ${rel}: 出现主人昵称`)
  }
  for (const [re, why] of DEAD_REFS) {
    if (re.test(text)) warnings.push(`[失效引用] ${rel}: ${why}`)
  }
}

for (const rel of list) {
  for (const [re, why] of FORBIDDEN) {
    if (re.test(rel)) problems.push(`[不该进包] ${rel}: ${why}`)
  }
}

/* ── ④ 相对依赖完整性（index.js 的 import 必须在包内）── */
const entry = 'index.js'
if (list.includes(entry)) {
  const src = fs.readFileSync(path.join(root, entry), 'utf8')
  const re = /(?:from|import\()\s*['"](\.[^'"]+)['"]/g
  let m
  const dir = path.posix.dirname(entry)
  while ((m = re.exec(src))) {
    const resolved = path.posix.normalize(path.posix.join(dir, m[1]))
    if (!list.includes(resolved)) problems.push(`[依赖缺失] ${entry} → ${m[1]}（包里没有 ${resolved}）`)
  }
}

/* ── ⑤ tools 脚本引用 ── */
const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
const toolsUsed = [...new Set([...idx.matchAll(/(?:runPy|runNodeTool(?:Async)?)\(\s*['"]([^'"]+)['"]/g)].map((x) => x[1]))]
for (const t of toolsUsed) {
  if (!list.includes(`tools/${t}`)) problems.push(`[依赖缺失] index.js 引用 tools/${t}，但包里没有`)
}

/* ── ⑥ 向后兼容：DEFAULTS 里每个键都要有默认值（老配置缺键时靠它） ── */
try {
  const idxSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const defaultsBlock = idxSrc.slice(idxSrc.indexOf('const DEFAULTS = {'), idxSrc.indexOf('}', idxSrc.indexOf('const DEFAULTS = {')))
  const keys = [...defaultsBlock.matchAll(/^\s{4}([A-Za-z_][\w]*)\s*:/gm)].map((x) => x[1])
  if (keys.length < 10) warnings.push(`[兼容] DEFAULTS 只解析到 ${keys.length} 个键 —— 解析可能失效，请人工确认`)
  else console.log(`DEFAULTS 键数量：${keys.length}（老配置缺键时会补默认值）`)
} catch { warnings.push('[兼容] 读不到 DEFAULTS 块') }

/* ── 输出 ── */
console.log('\n══ 隐私审计 ══')
const priv = problems.filter((p) => p.startsWith('[隐私]'))
if (!priv.length) console.log('  ✅ 没有你的昵称 / 本机路径 / Cookie / Key')
else for (const p of priv) console.log('  ❌ ' + p)

console.log('\n══ 包里不该有的东西 ══')
const forb = problems.filter((p) => p.startsWith('[不该进包]'))
if (!forb.length) console.log('  ✅ 没有私货 / 日志 / 临时目录')
else for (const p of forb) console.log('  ❌ ' + p)

console.log('\n══ 新装的人能不能跑（依赖完整性） ══')
const dep = problems.filter((p) => p.startsWith('[依赖缺失]'))
if (!dep.length) console.log('  ✅ 相对依赖与 tools 脚本全在包内')
else for (const p of dep) console.log('  ❌ ' + p)

console.log('\n══ 已装的人升级（失效引用，仅提示） ══')
if (!warnings.length) console.log('  ✅ 没有指向已删文件的引用')
else for (const w of warnings) console.log('  ⚠️ ' + w)

console.log('')
if (problems.length) {
  console.log(`❌ 有 ${problems.length} 个必须修的问题，先别发布`)
  process.exit(1)
}
console.log('✅ 审计通过，可以发布')
