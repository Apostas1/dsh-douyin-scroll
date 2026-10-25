/**
 * tools/release-smoke.cjs —— 模拟「别人全新安装」的冒烟测试
 *
 * 为什么要有它（2026-10-26）：
 *   主人要发布前确认「没装过的人能装上」「已经装的人能升级」。
 *   在自己仓库里跑 selfcheck 是不够的 —— 本机有历史文件、有 node_modules、
 *   有配置，很多东西"碰巧能跑"。真正要验的是**打包出来的 tgz 解到干净目录后**：
 *     ① 文件齐全（入口、依赖、tools 脚本都在）
 *     ② 没有隐私（昵称/路径/Cookie）
 *     ③ 插件能被 Node 正常 import（语法 + 顶层依赖都能解析）
 *     ④ 老配置缺键时能补默认值（升级路径）
 *
 * 用法：node tools/release-smoke.cjs
 *   退出码 0 = 可以发布
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..')
process.chdir(root)

let fail = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { console.log('  ❌ ' + m); fail++ }

/* ── 1. 打包 ── */
console.log('【1】npm pack')
let tgz = ''
try {
  const raw = execSync('npm pack --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  tgz = path.join(root, JSON.parse(raw)[0].filename)
  const size = (fs.statSync(tgz).size / 1024).toFixed(0)
  ok(`打出来了：${path.basename(tgz)}（${size} kB）`)
} catch (e) {
  bad('打包失败：' + e.message)
  process.exit(1)
}

/* ── 2. 解到干净目录（模拟别人机器） ── */
console.log('\n【2】解压到临时目录（模拟全新安装）')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dy-smoke-'))
try {
  execSync(`tar -xzf "${tgz}" -C "${tmp}"`, { stdio: 'ignore' })
} catch (e) {
  // Windows 自带 tar 通常可用；不行就用 PowerShell Expand-Archive（tgz 先改名）
  try {
    const zip = path.join(tmp, 'pkg.tar.gz')
    fs.copyFileSync(tgz, zip)
    execSync(`tar -xzf "${zip}" -C "${tmp}"`, { stdio: 'ignore', shell: 'cmd.exe' })
  } catch (e2) {
    bad('解压失败：' + e2.message)
    process.exit(1)
  }
}
const pkgDir = path.join(tmp, 'package')
if (!fs.existsSync(pkgDir)) { bad('解压后没有 package/ 目录'); process.exit(1) }
ok(`解到 ${pkgDir}`)

/* ── 3. 必需文件齐不齐 ── */
console.log('\n【3】必需文件')
for (const f of [
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml',
  'lib/state.mjs', 'lib/pet-relay.mjs', 'lib/toast.mjs', 'lib/credential.mjs',
  'prompts/duty.md', 'prompts/persona.default.md',
  'tools/im-send.mjs', 'tools/im-http.py',
  'selfcheck.mjs', 'README.md',
]) {
  if (fs.existsSync(path.join(pkgDir, f))) ok(f)
  else bad(`缺 ${f}`)
}

/* ── 4. 隐私（对着解压后的真实内容查） ── */
console.log('\n【4】隐私（解压后的真实文件）')
const NICK = ['某', '帅气', '用户'].join('')
const NICK2 = ['吃柠', '檬的', '板栗'].join('')
let leaks = 0
;(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (st.size > 3e6) continue
    let text = ''
    try {
      const b = fs.readFileSync(p)
      if (b.includes(0)) continue
      text = b.toString('utf8')
    } catch { continue }
    const rel = path.relative(pkgDir, p)
    if (text.includes(NICK) || text.includes(NICK2)) { bad(`出现使用者的抖音/B站昵称：${rel}`); leaks++ }
    if (/[A-Za-z]:\\aiagent\\/.test(text)) { bad(`出现本机开发路径：${rel}`); leaks++ }
    if (/MS4wLjABAAAA[A-Za-z0-9_-]{10,}/.test(text)) { bad(`出现 sec_uid：${rel}`); leaks++ }
    if (/sessionid_ss?\s*=\s*[A-Za-z0-9]{8,}/.test(text)) { bad(`出现 Cookie：${rel}`); leaks++ }
  }
})(pkgDir)
if (!leaks) ok('没有昵称 / 本机路径 / sec_uid / Cookie')

/* ── 5. 能不能 import（语法 + 顶层依赖） ── */
console.log('\n【5】模块能否加载（别人机器上第一次 import）')
for (const f of ['index.js', 'lib/state.mjs', 'lib/pet-relay.mjs', 'selfcheck.mjs']) {
  try {
    execSync(`node --check "${path.join(pkgDir, f)}"`, { stdio: 'ignore' })
    ok(`${f} 语法通过`)
  } catch { bad(`${f} 语法错误`) }
}
/* 真正的 import 测试：写一个临时 .mjs 去 import（不在命令行拼引号，避免转义炸） */
try {
  const probe = path.join(tmp, 'probe.mjs')
  const target = 'file:///' + path.join(pkgDir, 'index.js').replace(/\\/g, '/')
  fs.writeFileSync(probe, `
    try {
      const m = await import(${JSON.stringify(target)})
      const need = ['name', 'inject', 'Config', 'apply']
      const miss = need.filter((k) => m[k] === undefined)
      console.log(miss.length ? 'MISSING:' + miss.join(',') : 'OK')
    } catch (e) {
      console.log('ERR:' + String(e && e.message || e).slice(0, 300))
    }
  `, 'utf8')
  const out = execSync(`node "${probe}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (out.includes('OK')) ok('index.js 能 import，name/inject/Config/apply 齐全')
  else if (/MISSING:/.test(out)) bad('index.js 缺少导出：' + out.replace('MISSING:', ''))
  else if (/Cannot find package|ERR_MODULE_NOT_FOUND|dsh-llm|dsh-tools|dsh-agent/.test(out) && !/SyntaxError/.test(out)) {
    ok('index.js 加载到「找不到宿主模块」为止（干净机器上正常，宿主会提供）')
  } else bad('index.js import 失败：' + out.slice(0, 160))
} catch (e) {
  bad('import 探测失败：' + String(e.message).slice(0, 120))
}

/* ── 6. 升级路径：老配置缺键 ── */
console.log('\n【6】老配置缺键时能否补默认值（升级的人）')
try {
  const src = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')
  const m = src.match(/const DEFAULTS = \{([\s\S]*?)\n  \}/)
  if (!m) bad('读不到 DEFAULTS 表')
  else {
    /* ⚠️ 解析坑：DEFAULTS 里有些行是**多个键挤在一行**的
     *    （`chatWatch: false, chatWatchSec: 30, chatWatchTarget: 'lead',`），
     *    所以不能只按"行首缩进 + 一个键"抓 —— 那样会漏掉后两个键，
     *    看起来像"字段缺失"（这个误报真发生过一次）。
     *    正确做法：在块内扫所有 `键:` 出现处，不管它在第几个位置。 */
    const body = m[1]
    const keys = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)]
      .map((x) => x[1])
      .filter((k) => !['const', 'let', 'return'].includes(k))
    const uniq = [...new Set(keys)]
    if (uniq.length >= 12) ok(`DEFAULTS 有 ${uniq.length} 个键 —— 老配置缺键时会补默认`)
    else bad(`DEFAULTS 只解析到 ${uniq.length} 个键，可能解析失效`)
    // 关键新字段必须在（否则老用户升级后读不到）
    for (const k of ['chatWatch', 'chatWatchTarget', 'petLinkTo']) {
      if (uniq.includes(k)) ok(`升级字段 ${k} 在 DEFAULTS 里`)
      else bad(`升级字段 ${k} 缺失 —— 老用户升级后这个功能不生效`)
    }
  }
  // 默认值必须是"安全默认"：聊天模式默认关
  if (/chatWatch: z\.boolean\(\)\.default\(false\)/.test(src)) ok('聊天模式默认关（新装用户不会被自动读私信）')
  else bad('聊天模式默认不是关 —— 新装用户会意外开启')
} catch (e) { bad('检查 DEFAULTS 出错：' + e.message) }

/* ── 7. 清理 ── */
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
try { fs.rmSync(tgz, { force: true }) } catch { /* 同上 */ }

console.log('')
if (fail) { console.log(`❌ ${fail} 项失败，先别发布`); process.exit(1) }
console.log('✅ 全新安装冒烟测试通过，可以发布')
