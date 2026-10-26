#!/usr/bin/env node
/**
 * tools/signer-setup.mjs —— 签名器运行时**一键安装** + 真签验货
 * ============================================================================
 * 解决 Issue #2① / #4：插件只带「驱动脚本」（tools/dy-signer.mjs），
 * 但它需要的运行时装在 $DOUYIN_HOME/signer/ —— 过去两头都没人管：
 *   - .gitignore 挡着（对，版权物不进仓库）
 *   - 「装主依赖」只装 Python 包
 *   - 文档没写
 * ⇒ 新用户一拉评论就 `Cannot find module 'jsdom'`。
 *
 * 本脚本把这一整段补上（「装主依赖」的最后一步会自动调它）：
 *   ① 建 $DOUYIN_HOME/signer/（没有就建）
 *   ② npm 装 jsdom（先走 npmmirror，失败退官方源）
 *   ③ 从字节官方 CDN 下 7 个 SDK 文件（多 URL 兜底 + 重试 + 补丁锚点校验）
 *   ④ ⭐ 真签一次验货：签不出 a_bogus 就算失败（Issue #2② 的「装了还是签不出」假绿教训）
 *
 * 用法：
 *   node tools/signer-setup.mjs            # 全量装 + 验货
 *   node tools/signer-setup.mjs --check    # 只验货（不装）
 *   node tools/signer-setup.mjs --force    # 删掉重来
 *
 * 输出给人看；退出码 0 = 真签通过。
 * SDK 文件清单/补丁锚点来自家里那套能跑的 signer（fetch-sdk.js 模式，2026-10-26 实测有效）。
 * ============================================================================
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { homeDir, pluginDir } from '../lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = dirname(HERE)
const NODE = process.execPath
const FORCE = process.argv.includes('--force')
const CHECK_ONLY = process.argv.includes('--check')

const HOME = homeDir()
const SIGNER = process.env.DY_SIGNER_DIR || join(HOME, 'signer')
const SDK_DIR = join(SIGNER, 'sdk')

const UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'

/* ── SDK 清单：7 个文件 + 两个补丁锚点（照搬家里能跑的那套 fetch-sdk.js） ── */
const BDMS_FROM = 'else{var m=n.apply(d,e);v[++p]=m}'
const BDMS_TO =
  'else{var m=n.apply(d,e);try{if(window.__capUrl&&n&&"apply"===n.name&&e&&e[1]&&Array.isArray(e[1])){var _u=String(e[1][1]||"");if(_u.indexOf("a_bogus=")>=0&&_u.indexOf("aweme")>=0)window.__capUrl(_u)}}catch(e){}v[++p]=m}'
const CAPTCHA_FROM = 'ku=function(e,t){'
const CAPTCHA_TO = 'ku=window.__ku=function(e,t){'

const FILES = [
  { out: 'webmssdk.js', urls: ['https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js'] },
  { out: 'secsdk-runtime.js', urls: ['https://lf-security.bytegoofy.com/obj/security-secsdk/runtime_bundler_34_v2.js'] },
  { out: 'sdk-glue.js', urls: ['https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.64-fix.01/sdk-glue.js'] },
  { out: 'slardar.js', urls: ['https://lf3-short.ibytedapm.com/slardar/fe/sdk-web/browser.cn.js?bid=douyin_web&globalName=bdSlardar'] },
  {
    out: 'bdms-signer.js',
    urls: [
      'https://p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/bdms_1.0.1.19_fix.js',
      'https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/stable/1.0.1.19-fix.01/bdms.js',
      'https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/stable/1.0.1.19-fix.01/bdms.js',
    ],
    patch: { from: BDMS_FROM, to: BDMS_TO },
  },
  { out: 'captcha-sdk.js', urls: ['https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/sec_sdk_build/4.0.28/captcha/index.js'], patch: { from: CAPTCHA_FROM, to: CAPTCHA_TO } },
  { out: 'verifycenter.js', urls: ['https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/1.0.0.427/index.js'] },
]

/** 拿来验货的只读 URL（真签一次，看有没有 a_bogus） */
const PROBE_REL = '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'
  + '&aweme_id=7698980229549139835&count=5&cursor=0&item_type=0&version_code=190500&version_name=19.5.0'

const say = (s) => process.stdout.write(s + '\n')

async function downloadOne(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
  return r.text()
}
async function download(urls) {
  let last
  for (const u of urls) {
    for (let a = 1; a <= 3; a++) {
      try { return await downloadOne(u) } catch (e) {
        last = e
        await new Promise((r) => setTimeout(r, 1200 * a))
      }
    }
  }
  throw last
}

/** npm 在 Windows 上是 .cmd，Node 新版不给直接 spawn —— 用 shell 包一层 */
function sh(cmd, args, opts = {}) {
  const isWin = process.platform === 'win32'
  const full = isWin ? [cmd, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ') : cmd
  return spawnSync(isWin ? full : cmd, isWin ? [] : args, {
    encoding: 'utf8',
    cwd: opts.cwd || SIGNER,
    timeout: opts.timeout || 240_000,
    shell: isWin,
    env: { ...process.env, ...(opts.env || {}) },
  })
}

/* ── ④ 真签验货：调 dy-signer.mjs 签一条只读 URL，看 a_bogus 出不出来 ──
 * 结果走**文件**回传（DY_SIGNER_OUT），spawn 用 stdio ignore ——
 * 某些受限环境（如 DSH 沙箱）里 node→node 的管道 spawn 会被拦（EPERM），文件两头都稳。 */
export function realSignProbe({ timeoutMs = 60_000 } = {}) {
  // 输出文件位置：默认放 signer/ 里；受限环境（沙箱）可能拦子进程往那写 —— 失败自动降级到系统临时目录
  const spots = process.env.DY_SIGNER_PROBE_OUT
    ? [process.env.DY_SIGNER_PROBE_OUT]
    : [join(SIGNER, '.probe-out.json'), join(tmpdir(), 'dy-signer-probe-out.json')]
  let lastSpawnErr = ''
  for (const outFile of spots) {
    try { if (existsSync(outFile)) rmSync(outFile) } catch { /* 没有就算了 */ }
    const p = spawnSync(NODE, [join(PLUGIN, 'tools', 'dy-signer.mjs'), PROBE_REL], {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd: PLUGIN,
      stdio: 'ignore',
      env: { ...process.env, DY_SIGNER_DIR: SIGNER, DY_SIGNER_OUT: outFile },
    })
    if (p.error) { lastSpawnErr = '起签名进程失败：' + p.error.message; continue }
    if (!existsSync(outFile)) { lastSpawnErr = `签名器没产出结果（exit=${p.status}，signal=${p.signal}）`; continue }
    try {
      const j = JSON.parse(readFileSync(outFile, 'utf8'))
      if (j.signedUrl && String(j.signedUrl).includes('a_bogus=')) return { ok: true, signedUrl: j.signedUrl }
      return { ok: false, why: j.err || '没有 a_bogus' }
    } catch (e) {
      return { ok: false, why: '解析签名输出失败: ' + e.message }
    } finally {
      try { if (existsSync(outFile)) rmSync(outFile) } catch { /* 清理失败无所谓 */ }
    }
  }
  return { ok: false, why: lastSpawnErr || '未知原因' }
}

/* ─────────────────────────── 主流程 ─────────────────────────── */
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('signer-setup.mjs')) {
  say(`[signer-setup] 运行时目录：${SIGNER}`)

  if (process.argv.includes('--debug-npm')) {
    // 诊断模式：npm 带完整输出跑一遍，给人看真错误
    const r = spawnSync(NODE, [join(PLUGIN, 'tools', 'signer-setup.mjs')], { encoding: 'utf8', stdio: 'ignore' })
    void r
    const pkg = join(SIGNER, 'package.json')
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'douyin-signer-runtime', private: true, version: '1.0.0', dependencies: { jsdom: '^24.1.0' } }, null, 2), 'utf8')
    const npmCli = [process.env.npm_execpath, join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean).find((p) => existsSync(p)) || ''
    const rr = spawnSync(NODE, [npmCli, 'install', '--no-audit', '--no-fund', '--cache', join(SIGNER, '.npm-cache'), '--registry=https://registry.npmmirror.com'], {
      encoding: 'utf8', cwd: SIGNER, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    say('--- npm stdout ---'); say(String(rr.stdout || '(空)'))
    say('--- npm stderr ---'); say(String(rr.stderr || '(空)'))
    process.exit(rr.status === 0 ? 0 : 1)
  }

  if (CHECK_ONLY) {
    const r = realSignProbe()
    say(r.ok ? '[signer-setup] ✅ 真签通过（a_bogus 有了）' : `[signer-setup] ❌ 真签失败：${r.why}`)
    process.exit(r.ok ? 0 : 1)
  }

  if (FORCE && existsSync(SIGNER)) {
    say('[signer-setup] --force：删掉旧运行时重来')
    try { rmSync(SIGNER, { recursive: true, force: true }) } catch (e) { say(`删旧目录失败：${e.message}`) }
  }
  mkdirSync(SDK_DIR, { recursive: true })

  /* ② jsdom */
  const jsdomPkg = join(SIGNER, 'node_modules', 'jsdom', 'package.json')
  if (existsSync(jsdomPkg)) {
    say('[signer-setup] jsdom 已装，跳过 npm')
  } else {
    say('[signer-setup] npm i jsdom（npmmirror 优先，失败退官方源）…')
    const pkg = join(SIGNER, 'package.json')
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'douyin-signer-runtime', private: true, version: '1.0.0', dependencies: { jsdom: '^24.1.0' } }, null, 2), 'utf8')

    // ⭐ 首选：直接用 node 跑 npm 的 cli.js（不过 cmd.exe —— 受限环境里 shell spawn 会被拦 EPERM）
    const npmCliCandidates = [
      process.env.npm_execpath,
      join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean)
    const npmCli = npmCliCandidates.find((p) => existsSync(p)) || ''

    /** 返回 null=成功，否则失败原因 */
    const tryNpm = (registry, { capture = false } = {}) => {
      const args = ['install', '--no-audit', '--no-fund', '--loglevel=error',
        '--cache', join(SIGNER, '.npm-cache')]  // 缓存圈在自己目录里：不碰用户全局缓存（受限环境也拦不着）
      if (registry) args.push('--registry=' + registry)
      let r
      if (npmCli) {
        r = spawnSync(NODE, [npmCli, ...args], {
          encoding: 'utf8', cwd: SIGNER, timeout: 300_000,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        })
        if (r.error) return 'node npm-cli 起不来：' + r.error.message
      } else {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
        const isWin = process.platform === 'win32'
        const full = isWin ? [npm, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ') : npm
        r = spawnSync(isWin ? full : npm, isWin ? [] : args, {
          encoding: 'utf8', cwd: SIGNER, timeout: 300_000, shell: isWin,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        })
        if (r.error) return 'npm 起不来：' + r.error.message
      }
      if (r.status !== 0) {
        const tail = String((r.stderr || '') + (r.stdout || '')).slice(-400).replace(/\s+/g, ' ').trim()
        return `exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}${tail ? ' — ' + tail : ''}`
      }
      return existsSync(jsdomPkg) ? null : '跑完了但 jsdom 不在'
    }

    let err = tryNpm('https://registry.npmmirror.com')
    if (err) {
      say(`[signer-setup] npmmirror 没成（${err}），退官方源再试…`)
      err = tryNpm('')
    }
    if (err || !existsSync(jsdomPkg)) {
      say('[signer-setup] ❌ jsdom 装不上 —— ' + (err || '未知原因'))
      say('    诊断：node "' + join(PLUGIN, 'tools', 'signer-setup.mjs') + '" --debug-npm')
      say('    手动补救：cd "' + SIGNER + '" && npm install')
      process.exit(1)
    }
    say('[signer-setup] jsdom 装好了')
  }

  /* ③ SDK 文件 */
  let sdkBad = 0
  for (const f of FILES) {
    const target = join(SDK_DIR, f.out)
    const have = (() => { try { return statSync(target).size > 1000 } catch { return false } })()
    if (have) { say(`[signer-setup] sdk/${f.out} 已在，跳过`); continue }
    process.stdout.write(`[signer-setup] sdk/${f.out} 下载中 … `)
    try {
      let src = await download(f.urls)
      if (f.patch) {
        if (!src.includes(f.patch.from)) throw new Error('补丁锚点没找到（SDK 换版了？）—— ' + f.urls[0])
        src = src.replace(f.patch.from, f.patch.to)
      }
      writeFileSync(target, src, 'utf8')
      say(`ok（${src.length} 字节）`)
    } catch (e) {
      say(`FAILED：${e.message}`)
      sdkBad++
    }
  }
  if (sdkBad) {
    say(`[signer-setup] ❌ ${sdkBad} 个 SDK 没下来 —— 网络通吗？也可以手动跑：node "${join(PLUGIN, 'tools', 'signer-setup.mjs')}"`)
    process.exit(1)
  }

  /* ④ 真签验货 */
  say('[signer-setup] 真签一次验货…')
  const v = realSignProbe()
  if (v.ok) {
    say('[signer-setup] ✅ 全部就位，试签通过（a_bogus 有了）—— 读评论可以用了')
    process.exit(0)
  }
  say(`[signer-setup] ❌ 装是装上了，但真签没通过：${v.why}`)
  say('    读评论会自动走无头浏览器兜底（能用，只是慢几秒）。')
  say('    想修签名器：删掉 ' + SIGNER + ' 后重新「装主依赖」。')
  process.exit(1)
}
