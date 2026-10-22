/**
 * dsh-douyin-scroll —— host 半端
 * ============================================================================
 * 它是一条**完整的值班链路**（架构参考 dsh-bili-scroll，判据层换成抖音的）：
 *   1. 采集/预筛直接调 `tools/*.py`（只读接口 tab/feed + hot/search），
 *      不再有内置 Python MCP / bb-browser / playwright 那一套。
 *   2. 谷时定时器：中午 12:00–14:00、夜间 18:00–09:00（`lib/state.mjs` 的 WINDOWS）。
 *   3. 「跑一轮」= 先在插件里抓好证据包 `round-evidence.json`，再起一个
 *      `dsh --profile headless --patch <overlay> <prompt>`，把 `duty.md` 交给它，
 *      报告写进 `<家>/out/<日期>.md`。
 *   4. 设置页（`client.js`）通过 `/api/douyin-duty/*` 读写配置、看状态、存 Cookie、测通知。
 *
 * 家里（`$DSH_HOME/douyin-duty/`）都有什么：
 *   `config.json` / `collector.json` / `forward-pick.json` / `round-evidence.json` /
 *   `duty.md` / `out/` / `inbox/` / `duty.log` / `health.json`
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因见 lib/hostdeps.mjs：它们是 optional peer，桌面版 profile 永远不装 ⇒ 裸 import 会整条不激活。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey, redactCookie } from './lib/state.mjs'
import { saveCookie, readCookie, hasCredential, credentialInfo, clearCredential, cookiePath } from './lib/credential.mjs'
import { sendWebhook, condense, maskUrl } from './lib/notify.mjs'
import { sendToast, toastSummary } from './lib/toast.mjs'
import { ensureUv } from './lib/uvfetch.mjs'

export const name = 'douyin-scroll'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`），没有这个标记写设置时会抛 "Plugin entry … has no volatile fields"。
 *    另外两个条件：**loader entry 的 id 必须等于命名空间名**（patch 里就是 `douyin-scroll`）+ 本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  /** 每天最多挑几条（0 = 不自动刷，但还能手动跑） */
  perDay: z.natural().default(5).extra('volatile', true),
  /** 每次最多筛选几个候选（送给模型判断的上限，省 token） */
  maxPerRun: z.natural().default(12).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上（内置窗口，保留兼容） */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐ 自定义时段：`[{ start: '12:00', end: '14:00', label: '中午' }]`
   *    - 支持跨零点（`23:00`–`02:00`）
   *    - 和内置的中午/晚上**叠加**：只要有任意一个窗口命中就跑
   *    - 空数组 = 只用内置那两个开关
   *    - 每个时段每天只用一次（跟内置窗口同一套去重）
   */
  windows: z.array(z.object({
    start: z.string(),
    end: z.string(),
    // ⚠️ 2026-10-22：这里原来写 `z.string().optional()` —— 但这个 schemastery 版本
    //    的字符串**没有 .optional() 方法**，整个 index.js 在 import 阶段就抛
    //    `TypeError: z.string(...).optional is not a function` ⇒ 插件 fiber 建不起来
    //    ⇒ fiberPhase 永远是 null ⇒ 设置页没有面板、工具也不注册。
    //    改用 .default('') 代替（效果一样：可以不给，给了就用）。
    label: z.string().default(''),
  })).default([]).extra('volatile', true),
  /** 关注关键词（空了用 duty.md 里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** 推荐流分类（游戏 / 美食 / 搞笑 …） */
  channels: z.array(z.string()).default([]).extra('volatile', true),
  /** 指定作者（sec_uid 或主页链接） */
  authors: z.array(z.string()).default([]).extra('volatile', true),
  /** 文案太短（<N 字）**且**评论少 ⇒ 直接跳过 */
  minDescLen: z.natural().default(12).extra('volatile', true),
  /** 评论数 <N **且** 文案短 ⇒ 直接跳过 */
  minComments: z.natural().default(3).extra('volatile', true),
  /** 自动评论并 @（默认关 —— 会拿用户的号说话） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /** 评论执行器：off / builtin（不可用）/ browser / http */
  commentExecutor: z.string().default('off').extra('volatile', true),
  commentPerRun: z.natural().default(1).extra('volatile', true),
  commentPerDay: z.natural().default(0).extra('volatile', true),
  /** 要 @ 谁（抖音昵称）；留空 = 不发评论 */
  mentionName: z.string().default('').extra('volatile', true),
  /** http 执行器的地址 */
  httpCommentUrl: z.string().default('').extra('volatile', true),
  /** 通知：toast（Windows 通知，默认）/ file（不额外提醒）/ webhook / both */
  notifyMode: z.string().default('toast').extra('volatile', true),
  /** 私信发给谁：昵称（只用于显示/提醒） */
  dmTo: z.string().default('').extra('volatile', true),
  /**
   * ⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。真正决定发给谁的是这个，不是昵称。
   * 抖音重名极其常见 ⇒ 昵称只当"人类可读的名字"，`dmToId` 才是身份。
   * 留空时：只有在会话列表里昵称**唯一**才允许发；重名会直接拒绝并列出候选。
   */
  dmToId: z.string().default('').extra('volatile', true),
  webhookUrl: z.string().default('').extra('volatile', true),
  webhookPreset: z.string().default('custom').extra('volatile', true),
  /**
   * ⭐ 检查更新的地址（可选）。留空 = 自动：
   *   ① npm registry 的 `/<包名>/latest`（包要是发到 npm 了才查得到）
   *   ② 包里 `repository` 指向 GitHub 时，读仓库根目录的 package.json
   * 填了就只查这一个（要返回 JSON，至少有 { "version": "x.y.z" }）。
   */
  updateUrl: z.string().default('').extra('volatile', true),
  /** 日报形态：full / brief / off */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** Python：指向 venv 里那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测） */
  dshBin: z.string().default('').extra('volatile', true),
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  // ⚠️ 2026-10-21 删掉了 `workspace`：它原来是"读那个目录下的 AGENTS.md 当人设"，
  //    正是这个口子让插件能读到**别的插件**的设定（抖音口吻被搬到刷B站那边）。
  //    现在人设只来自插件自带的 `prompts/persona.md`，外面没有任何路径可读。
})

/** ⭐ 给所有 Python 子进程统一 UTF-8（Windows 默认 GBK，中文/emoji 一进管道就可能炸） */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }
  const stateDir = stateDirOf(ctx)
  const cfgFile = join(stateDir, 'config.json')
  const collectorFile = join(stateDir, 'collector.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  const inboxDir = join(stateDir, 'inbox')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  /** ⭐ Toast 的 ps1 和临时 json 也放 D 盘家目录（用户要求所有东西装 D 盘，别往 C:\Temp 撒） */
  const toastDir = join(stateDir, 'toast')
  const toastSend = (o) => sendToast({ ...o, dir: toastDir })

  /* ── 日志：别让模型输出把结构化行粘在一起（抄 bili-scroll 的教训） ── */
  let atLineStart = true
  const rawWrite = (s) => {
    try {
      appendFileSync(logFile, s, 'utf8')
      atLineStart = String(s).endsWith('\n')
    } catch { /* 日志写不进去也不致命 */ }
  }
  const log = (msg) => {
    rawWrite((atLineStart ? '' : '\n') + `${new Date().toISOString()}  ${msg}\n`)
    try { ctx.logger?.info?.(`[douyin-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  for (const n of hostDeps.notes) log(n)

  /* ── 配置：逐字段按默认值类型挑一遍（apply 传进来的值不保证是标量） ── */
  const DEFAULTS = {
    perDay: 5, maxPerRun: 12, peakValley: false, noon: true, night: true,
    windows: [],
    keywords: [], channels: [], authors: [],
    minDescLen: 12, minComments: 3,
    autoComment: false, commentExecutor: 'off', commentPerRun: 1, commentPerDay: 0,
    mentionName: '', httpCommentUrl: '',
    notifyMode: 'toast', webhookUrl: '', webhookPreset: 'custom',
    updateUrl: '',
    dmTo: '', dmToId: '',
    reportLevel: 'full', pythonPath: 'python', dshBin: '', headlessProfile: 'headless',
    overlayMcp: true,
  }
  // ⭐ 哪些数组字段装的是**对象**（不能按字符串过滤）
  //    之前判断 `base[k].length && typeof base[k][0] === 'object'` —— 但 DEFAULTS 里
  //    `windows: []` 是空的，length=0，于是走了字符串分支，用户存的自定义时段全被吃掉。
  //    改成显式声明，别靠"数组里恰好有元素"来判断。
  const OBJECT_ARRAYS = new Set(['windows'])
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) {
        if (!Array.isArray(v)) continue
        out[k] = OBJECT_ARRAYS.has(k)
          ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
          : v.filter((x) => typeof x === 'string')
      }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /**
   * ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、douyin_config 工具、**读配置**三处都走它。
   *    原生设置页那条路我们钳不到写 ⇒ loadCfg 读回来也过一遍（写进去和读出来一个口径）。
   */
  const ENUMS = {
    commentExecutor: ['off', 'builtin', 'browser', 'http'],
    notifyMode: ['file', 'toast', 'webhook', 'both'],
    webhookPreset: ['custom', 'wecom', 'feishu', 'dingtalk'],
    reportLevel: ['full', 'brief', 'off'],
  }
  const clampPatch = (patch) => {
    // ⭐ 只认 schema 里真有的字段。
    //    2026-10-21 实测：外面塞进来一个未知键（比如 `dmMode`），DSH 那边会把**整批**拒掉，
    //    报 `Config field "dmMode" is not volatile`，连带着私信对象一起没同步上。
    const p = {}
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) p[k] = patch[k]
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 300))
    if ('maxPerRun' in p) p.maxPerRun = Math.max(1, Math.min(Number(p.maxPerRun) || 1, 30))
    if ('minDescLen' in p) p.minDescLen = Math.max(0, Math.min(Number(p.minDescLen) || 0, 200))
    if ('minComments' in p) p.minComments = Math.max(0, Math.min(Number(p.minComments) || 0, 1000))
    if ('commentPerRun' in p) p.commentPerRun = Math.max(0, Math.min(Number(p.commentPerRun) || 0, 20))
    if ('commentPerDay' in p) p.commentPerDay = Math.max(0, Math.min(Number(p.commentPerDay) || 0, 50))
    for (const [k, vals] of Object.entries(ENUMS)) {
      if (k in p) p[k] = vals.includes(String(p[k])) ? String(p[k]) : DEFAULTS[k]
    }
    return p
  }

  const CFG_SIG = ['perDay', 'maxPerRun', 'mentionName', 'commentExecutor']
  let settingsRow = { at: 0, row: null }
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  const hostCfg = () => normalize(config, { ...DEFAULTS })
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    const out = { ...hostCfg() }
    for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]
    // host 那层退回默认值、而 config.json 里有非默认值时，以 config.json 为准
    const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b } }
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] === undefined) continue
      if (same(out[k], DEFAULTS[k]) && !same(saved[k], DEFAULTS[k])) out[k] = saved[k]
    }
    return clampPatch(out)
  }
  const cfg = loadCfg()
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    // ⭐ 2026-10-21 实测事故：`dmTo` / `dmToId` 被清空过 —— 日志里连着三条 `设置已更新：{}`，
    //    设置页一渲染就把空输入框 blur 出去一次。清空的后果是私信直接发不出去（还不知道为什么）。
    //    规矩：空值不许覆盖磁盘上已有的非空值。
    const onDisk = readJson(cfgFile, {})
    for (const k of ['dmTo', 'dmToId']) {
      if (!String(cfg[k] || '').trim() && String(onDisk[k] || '').trim()) {
        cfg[k] = onDisk[k]
        log(`配置：${k} 差点被空值覆盖 —— 已保住磁盘上的原值`)
      }
    }
    writeJson(cfgFile, cfg)
  }
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) { try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 } }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
  /** ⭐ 落配置的唯一入口：config.json + DSH 原生设置页，钳完范围一起写 */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    syncCollectorCfg()               // ⭐ Python 那头的 router 读 collector.json
    const host = await saveCfgHost(clean)
    return { clean, host }
  }

  /**
  /**
   * ⭐ 把判据相关的配置同步给 Python 脚本（forward-pick.py 读它当预筛门槛）。
   *    不再有「采集来源」这条 —— 2026-10-21 砍掉 MCP 后只有一条路：只读接口取候选。
   */
  const syncCollectorCfg = () => {
    try {
      writeJson(collectorFile, {
        minDescLen: Number(cfg.minDescLen) || 0,
        minComments: Number(cfg.minComments) || 0,
        updatedAt: new Date().toISOString(),
      })
    } catch (e) { log(`写 collector.json 失败：${e?.message ?? e}`) }
  }

  ensureHomeFiles(pluginDir, stateDir, log)
  ensureCharter(pluginDir, stateDir, log)
  syncCollectorCfg()

  /* ─────────────── 环境（venv / uv） ─────────────── */
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  /** ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在 */
  const venvReadyNow = () => existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'httpx')

  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 算了 */ } }

  const spawnTo = (cmd, args, { sink = appendInstall, env = null, cwd = stateDir } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
  let uvOk = null
  const haveUv = async () => {
    if (uvOk) return true
    const ok = await probeCmd('uv')
    if (ok) uvOk = true
    return ok
  }
  const resolveUv = async () => {
    if (await haveUv()) return 'uv'
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    try {
      const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
      if (got) appendInstall('uv 已就位：' + got + '\n')
      return got
    } catch (e) { appendInstall(`下 uv 失败：${e?.message ?? e}\n`); return null }
  }
  const MIRRORS = [
    process.env.DOUYIN_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.ustc.edu.cn/pypi/simple',
    'https://mirrors.aliyun.com/pypi/simple',
  ]

  let installing = false
  /** 建 venv + 装主依赖 —— ⭐ **起完就返回，不等它装完**（否则会话会僵住几分钟） */
  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装主依赖 ===\n`)
    ;(async () => {
      try {
        const req = join(pluginDir, 'requirements.txt')
        const venvPy = venvPython()
        const uvCmd = await resolveUv()
        if (!existsSync(venvPy)) {
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', join(stateDir, '.venv')])
          if (!existsSync(venvPy)) await spawnTo(String(cfg.pythonPath || 'python'), ['-m', 'venv', join(stateDir, '.venv')])
        }
        if (!existsSync(venvPy)) {
          const msg = '建不了 Python 环境 —— 这台机器上既没有可用的 uv，也没有可用的 python。\n'
            + '装一个就行：uv（单文件 exe，https://docs.astral.sh/uv/）或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次。\n'
          appendInstall(msg); log('装依赖：建环境失败'); installing = false; return
        }
        let code = 1
        for (const m of MIRRORS) {
          if (code === 0) break
          if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', req])
          if (code !== 0) code = await spawnTo(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', req])
        }
        if (code === 0 && existsSync(venvPy)) {
          await persistCfg({ pythonPath: venvPy })
          appendInstall(`已把 pythonPath 设为 ${venvPy}\n`)
        }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装主依赖结束：exit=${code} venvReady=${venvReadyNow()}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖（走国内镜像，通常几十秒）' }
  }

  /* ─────────────── MCP（已移除） ───────────────
   * 2026-10-21：原来这里起一份内置 Python MCP（家里那份 mcp_server.py），
   * 把「搜 / 预筛 / 评论 / 状态」注册成工具。那套走 bb-browser / playwright / cookie 三个驱动，
   * 一个都没跑通过真数据，还要求开浏览器 —— 整包删掉，改用下面的 runPy() 直接调 tools/*.py。
   */

  /* ─────────────── 工具 ─────────────── */
  /* ─────────────── 顺序哨兵：先卡片，后文字 ───────────────
   * 🔴 使用者 2026-10-21 亲自立的规矩：既要发卡片又要发文字时，**永远先卡片、后文字**。
   *    反过来他先看到一句话，却不知道在说哪条视频。
   *    2026-10-21 真翻过车：Chrome 被 DSH 重启带走，卡片那步 ECONNREFUSED 崩掉，
   *    紧接着发理由的脚本却自己把 Chrome 拉起来发出了 —— 结果他先收到「这条一定要发你…」，
   *    过一会儿才收到卡片。这就是要防的形态。
   *    这里只做**软拦**（返回值里带 order_warning），不硬拒绝 —— 顺序错了也要发，但要说出来。
   */
  const recentDm = { at: 0, secUid: '', kind: '' }
  const noteDm = (kind, secUid) => { recentDm.at = Date.now(); recentDm.secUid = String(secUid || ''); recentDm.kind = String(kind || '') }
  /** 发卡片之前问一句：刚是不是已经给同一个人发过纯文字了？ */
  const orderWarning = (secUid) => {
    if (recentDm.kind !== 'text') return null
    const age = Date.now() - recentDm.at
    if (age > 180_000) return null
    if (secUid && recentDm.secUid && String(secUid) !== recentDm.secUid) return null
    return `⚠️ 规矩是「先卡片，后文字」—— ${Math.round(age / 1000)} 秒前刚给同一个人发过纯文字，卡片这次才到，顺序反了。下次用 share_card 的 reason 一次办完。`
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  /** 工具返回值一律过这里：宿主只吃"无损 JSON" */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  /**
   * 跑插件自带的 node 脚本（tools/*.mjs），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-22：这里以前写死 `IM_CDP_PORT: '9334'` —— 那等于把 lib/chrome.mjs 的
   *    端口自动探测**废掉**（强制 9334，撞上就死）。现在只注入家目录，端口交给 lib 自己找。
   */
  const runNodeTool = (script, args = [], { timeout = 240_000 } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    const r = spawnSync(process.execPath, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }
  /**
   * 跑插件自带的 Python 脚本（tools/*.py），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-21：这里以前是一份内置 MCP server（vendor/douyin-mcp，33 个文件 / 506 KB）+
   *    5 个 bb-browser/cookie 驱动。那套东西一个都没跑通过真数据，还被「必须开浏览器」绑着；
   *    现在采集/发送全走「HTTP + 无头 Chrome」，那些全删了。
   */
  const runPy = (script, args = [], { timeout = 240_000 } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    const py = existsSync(venvPython()) ? venvPython() : (cfg.pythonPath || 'python')
    const r = spawnSync(py, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }

  /** 从脚本输出里抠出最后一个完整 JSON 对象 */
  const pickJson = (s) => {
    const t = String(s || '')
    const i = t.indexOf('{'), j = t.lastIndexOf('}')
    if (i < 0 || j <= i) return null
    try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
  }

  tool({
    name: 'douyin_doctor',
    description: '⭐ **环境体检**（换台设备 / 装完插件第一件事就跑它）：家目录、Python、venv、Cookie、'
      + 'Node、浏览器、CDP 端口、关键脚本 —— 八项逐个查，哪项红了直接给「怎么办」。'
      + '只读，什么都不改。',
    parameters: {},
    async execute() {
      // ⭐ 用纯 Node 版：第一次装的时候还没有 Python，不能让它依赖 Python
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return {
          ok: false, error: '体检脚本没返回可解析结果',
          stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300),
        }
      }
      const bad = j.must_fix || []
      const warn = j.warns || []
      if (bad.length) log(`doctor: ${bad.length} 项要修（${bad.map((x) => x.item).join('、')}）`)
      return {
        ok: j.ok !== false,
        items: j.items,
        must_fix: bad,
        todo: warn,
        hint: bad.length
          ? `先把这些修掉：${bad.map((x) => x.item).join('、')}`
          : (warn.length ? `没有硬伤，这些装完依赖/登录后会自己变绿：${warn.map((x) => x.item).join('、')}` : '全绿，可以跑值班了'),
      }
    },
  })

  tool({
    name: 'douyin_whoami',
    description: '看抖音这边的登录状态（会话还活着吗、nick 是谁）。不确定时先调它 —— **只读体检**，不影响登录态。',
    parameters: {},
    async execute() {
      if (!hasCredential(stateDir)) {
        return { ok: false, logged_in: false, hint: '还没有 Cookie —— 设置页「抖音 Cookie / 登录」扫码，或粘一条 Cookie' }
      }
      const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检没返回结果', stderr: String(r.stderr || '').slice(0, 300) }
      return { ok: true, logged_in: j.alive === true, ...j }
    },
  })

  tool({
    name: 'douyin_backend',
    description: '看当前这套采集 / 发送分别是怎么走的、各自的限制是什么。',
    parameters: {},
    async execute() {
      return {
        ok: true,
        stack: [
          { part: '取候选（清单）', how: '不签名的只读接口 tab/feed + hot/search', tool: 'douyin_forward', risk: '不碰写接口 ⇒ 不影响登录态' },
          { part: '读评论 / 读通知', how: '签名只读（dy-signer.mjs 出 a_bogus）', tool: 'douyin_comments / douyin_notices', risk: '低' },
          { part: '发私信 / 发卡片 / 发评论', how: '无头 Chrome 里跑抖音自己的前端', tool: 'douyin_dm / douyin_share_card / douyin_comment_reply', risk: '≈0（页面自己签名），但发前必须先问用户' },
        ],
        removed_2026_10_21: '删掉了 vendor/douyin-mcp（33 个文件 / 506 KB）和 bb-browser 那套驱动 —— 一个真数据都没跑通过',
        browser_policy: '可见浏览器只在扫码登录时用一次（tools/qr-login.mjs）；其余全是无头 Chrome 或纯 HTTP',
        not_available: ['关键词搜索（抖音 web 没有可用搜索接口，只有推荐流）', '视频详情（web 详情接口被 ArgusSecurityPlugin 挡）'],
      }
    },
  })

  tool({
    name: 'douyin_prescreen',
    description: '⭐ 一轮的主入口：取候选 → 打分 →（可选）给前几条拉高赞评论 → 返回「判断用的证据包」。'
      + '**判断就基于返回的 list[].evidence，别自己再逐条搜。**',
    parameters: {
      top: { type: 'number', description: '返回前几条（默认 10，最多 30）' },
      with_comments: { type: 'number', description: '给前 N 条拉评论（默认 5；0 = 不拉）' },
    },
    async execute(args = {}) {
      const top = Math.max(1, Math.min(Number(args.top) || 10, 30))
      const wcRaw = args.with_comments === undefined ? 5 : Number(args.with_comments)
      const withComments = Math.max(0, Math.min(Number.isFinite(wcRaw) ? wcRaw : 5, 15))
      const r = runPy('forward-pick.py', [], { timeout: 300_000 })
      if (r.status !== 0) return { ok: false, error: '取候选失败', stderr: String(r.stderr || '').slice(0, 400) }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, top)
      if (!rows.length) return { ok: true, kept: 0, note: '推荐流这轮没返回候选，稍后再试' }
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
        }
        if (i < withComments && Number(x.comment) > 0) {
          const c = runPy('api-comments.py', [String(x.aweme_id)], { timeout: 200_000 })
          const lines = String(c.stdout || '').split('\n').filter((l) => /^\s{2}cid=/.test(l))
          item.evidence = lines.length
            ? lines.slice(0, 5).map((s) => s.replace(/^\s+/, '').replace(/^cid=\d+\s+/, '').slice(0, 160))
            : ['（没拉到评论）']
        }
        list.push(item)
      }
      return { ok: true, kept: list.length, sources: picked.meta || [], dropped: picked.dropped || {}, thresholds: picked.thresholds || {}, list }
    },
  })

  tool({
    name: 'douyin_forward',
    description: '⭐「转发视频给我」：拉推荐流候选 → 打分 → 出清单（含 douyin.com 分享链接），可同时弹 Windows 通知。'
      + '只用**不签名**的只读接口（tab/feed、hot/search），不碰写接口，因此**不会**影响登录态。',
    parameters: {
      toast: { type: 'boolean', description: '是否弹 Windows 通知（默认 true）' },
      top: { type: 'number', description: '通知里放几条（默认 3，最多 4）' },
    },
    async execute(args = {}) {
      const script = join(pluginDir, 'tools', 'forward-pick.py')
      if (!existsSync(script)) return { ok: false, error: '缺少 tools/forward-pick.py（插件包不完整）' }
      if (!existsSync(cookiePath(stateDir))) {
        return { ok: false, error: '还没有 Cookie', hint: '先扫码登录（tools/qr-login.mjs start），或设置页粘贴 Cookie' }
      }
      const venvPy = join(stateDir, '.venv', 'Scripts', 'python.exe')
      const py = existsSync(venvPy) ? venvPy : (cfg.pythonPath || 'python')
      const r = spawnSync(py, [script], {
        encoding: 'utf8',
        timeout: 240_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }),
        windowsHide: true,
      })
      if (r.status !== 0) {
        return { ok: false, error: 'forward-pick.py 执行失败', stderr: String(r.stderr || r.error || '').slice(0, 400) }
      }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = Array.isArray(picked.rows) ? picked.rows : []
      if (!rows.length) return { ok: true, picked: 0, note: '这一轮没拉到候选（推荐流可能返回空），稍后再试' }

      const fm = (n) => {
        n = Number(n) || 0
        if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
        if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
        return String(n)
      }
      const wantToast = args.toast !== false
      let toastRes = { ok: true, sent: false, skipped: 'disabled' }
      if (wantToast) {
        const n = Math.max(1, Math.min(Number(args.top) || 3, 4))
        const head = rows.slice(0, n).map((x) => `· ${fm(x.digg)}赞｜${String(x.desc || '').replace(/\s+/g, ' ').slice(0, 34)}`)
        const more = rows.length > n ? `\n… 还有 ${rows.length - n} 条，见 out/` : ''
        toastRes = toastSend({ title: `刷抖音 · 挑到 ${rows.length} 条`, body: head.join('\n') + more })
      }
      log(`forward: 挑到 ${rows.length} 条，通知=${toastRes.ok && toastRes.sent ? '已弹' : (toastRes.error || toastRes.skipped || '未弹')}`)
      return {
        ok: true,
        picked: rows.length,
        sources: picked.meta || [],
        toast: toastRes,
        list: rows.map((x) => ({
          aweme_id: x.aweme_id,
          desc: x.desc,
          author: x.author,
          duration_s: x.duration_s,
          digg: x.digg,
          comment: x.comment,
          collect: x.collect,
          share: x.share,
          share_url: x.share_url,
          share_desc: x.share_desc,
          web_url: x.web_url,
        })),
      }
    },
  })

  tool({
    name: 'douyin_dm',
    description: '通过**无头 Chrome**（屏幕上不出现任何窗口）把一条私信发给指定抖音好友。'
      + '消息由抖音自己的前端发出 —— 连接、签名、protobuf 编码都由它完成，'
      + '所以**不会像自己拼签名那样把登录态搞掉**。'
      + 'from_list=true 时自动取最近一轮清单当正文（用官方 share_url 分享链接）。'
      + '🔴 规矩：**先卡片，后文字** —— 这次如果还要把视频给他，先调 `douyin_share_card`'
      + '（它的 `reason` 就是那条文字），**不要**先用这里发文字再补卡片。',
    parameters: {
      to: { type: 'string', description: '发给谁（抖音昵称，只用于显示；leave空用配置 dmTo）' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。重名时**必须**给这个；留空用配置 dmToId' },
      text: { type: 'string', description: '私信正文（与 from_list 二选一）' },
      from_list: { type: 'boolean', description: '用最近一轮刷到的清单当正文（默认 false）' },
      top: { type: 'number', description: 'from_list 时放几条（默认 3，最多 5）' },
      dry: { type: 'boolean', description: '只验证通道，不真发（默认 false）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只返回草稿不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      let file = ''
      if (args.from_list) {
        const n = String(Math.max(1, Math.min(Number(args.top) || 3, 5)))
        const r1 = runNodeTool('mk-msg.mjs', [n], { timeout: 60_000 })
        if (r1.status !== 0) return { ok: false, error: '生成清单正文失败', stderr: r1.stderr.slice(0, 300) }
        file = join(stateDir, 'forward-msg.txt')
      }
      const text = String(args.text || '').trim()
      if (!file && !text) return { ok: false, error: '正文为空', hint: '传 text，或 from_list=true' }
      // 🔴 用户闸：没经本人当场同意，只回草稿，绝不发出
      if (args.confirm !== true) {
        let draft = text
        if (file) { try { draft = readFileSync(file, 'utf8') } catch { draft = '' } }
        return {
          ok: true, sent: false, needsConfirm: true, to, to_id: toId || undefined,
          draft: draft.slice(0, 1500), len: draft.length,
          note: '没发送 —— 先把这段草稿给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      if (file) argv.push('--file', file)
      else argv.push('--text', text)
      if (args.dry) argv.push('--dry')
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const res = pickJson(r.stdout)
      if (!res) return { ok: false, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
      if (res.ok) log(`dm -> ${res.to || to}${res.to_sec_uid ? ' (' + res.to_sec_uid + ')' : ''}: ${res.sent ? '已发送' : res.dry ? 'dry-run' : '未发送'}（${res.len} 字）`)
      if (res.sent) noteDm('text', res.to_sec_uid || toId)
      return res
    },
  })

  tool({
    name: 'douyin_share_card',
    description: '⭐ 把视频以**抖音分享卡片**发给好友 —— 不是文字链接。'
      + '（文字链接在抖音里点不开，卡片才是「分享→发送给好友」那种可点的预览图。）'
      + '走无头 Chrome 里抖音自己的「分享给朋友」面板，屏幕上无窗口。'
      + '发完会**回读核实**卡片真的出现在「我发的」消息里；核实通过后再隔几秒自动补发 `reason`（为什么值得看）。'
      + '🔴 规矩：**先卡片，后文字** —— 要给文字就用 `reason`（会自动排在卡片后面），'
      + '别再调一次 `douyin_dm`，那样顺序会反成「文字 → 卡片」。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 ID（19 位）。不给就用最近一轮清单里的' },
      to: { type: 'string', description: '发给谁（昵称，只用于显示）；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid）。重名时必须给这个；留空用配置 dmToId' },
      top: { type: 'number', description: '不给 aweme_id 时，发清单前 N 条（默认 1，最多 3）' },
      reason: { type: 'string', description: '⭐ 分享的理由（卡片之后单独发的一条正文，≤300 字）。'
        + '写"为什么值得你看"，不是操作台账；留空就只有一张光秃秃的卡片' },
      reason_delay_sec: { type: 'number', description: '卡片发出后隔几秒再发 reason（默认 5，0 = 立刻发）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回预览不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      const reasonText = String(args.reason || '').trim()
      const gapSec = args.reason_delay_sec === undefined ? 5 : Math.max(0, Math.min(Number(args.reason_delay_sec) || 0, 60))
      const orderWarn = orderWarning(toId)
      let ids = []
      if (args.aweme_id) {
        ids = [String(args.aweme_id).trim()]
      } else {
        let rows = []
        const readRows = () => {
          try { return JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { return [] }
        }
        rows = readRows()
        if (!rows.length) {
          runNodeTool('forward-run.mjs', ['--no-toast'], { timeout: 300_000 })
          rows = readRows()
        }
        ids = rows.slice(0, Math.max(1, Math.min(Number(args.top) || 1, 3))).map((r) => String(r.aweme_id))
      }
      if (!ids.length) return { ok: false, error: '没有可用视频 ID', hint: '先 douyin_forward 拉一轮' }
      // 🔴 用户闸
      if (args.confirm !== true) {
        let rows = []
        try { rows = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { rows = [] }
        const preview = ids.map((id) => {
          const r = rows.find((x) => String(x.aweme_id) === id) || {}
          return { aweme_id: id, desc: String(r.desc || '').slice(0, 60), author: r.author || '', digg: r.digg || 0, share_url: r.share_url || '' }
        })
        return {
          ok: true, sent: false, needsConfirm: true, to, count: ids.length, preview,
          reason: reasonText || undefined,
          reason_delay_sec: reasonText ? gapSec : undefined,
          warn: reasonText ? undefined : '没给 reason —— 卡片后面会一句话都没有，建议补一条「为什么值得看」',
          order_warning: orderWarn || undefined,
          note: '没发送 —— 先把这几条给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      const results = []
      for (const id of ids) {
        const argv = [id, to]
        if (toId) argv.push('--to-id', toId)
        const r = runNodeTool('card-share.mjs', argv, { timeout: 200_000 })
        const j = pickJson(r.stdout)
        results.push(j || { ok: false, aweme_id: id, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 200) })
        if (!(j && j.ok)) break
        await new Promise((res) => setTimeout(res, 2200))
      }
      const sentN = results.filter((x) => x && x.sent).length
      // ⭐ 回读核实 —— 以前只验「分享面板关掉了」，那什么都证明不了。
      //    现在把会话读一遍，确认这张卡片真的出现在「我发的」消息里（aweType=800 + 同一个视频 id）。
      let readback = null
      if (sentN) {
        await new Promise((res) => setTimeout(res, 1500))
        const rArgs = ['--read']
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        const r2 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j2 = pickJson(r2.stdout)
        if (j2 && j2.ok) {
          const mineCards = (Array.isArray(j2.messages) ? j2.messages : []).filter((m) => m.from === 'me' && m.awe === 800)
          readback = {
            ok: true,
            sender_attribution: j2.sender_attribution,
            checked: ids.map((id) => ({
              aweme_id: id,
              in_my_messages: mineCards.some((m) => String(m.item) === String(id)),
            })),
            my_cards_in_view: mineCards.length,
          }
        } else {
          readback = { ok: false, error: '回读失败', detail: (j2 && j2.error) || String(r2.stderr || '').slice(0, 200) }
        }
      }
      const verified = !!(readback && readback.ok && readback.checked.every((c) => c.in_my_messages))
      if (sentN) noteDm('card', toId)

      // ⭐ 卡片之后隔几秒，补一句「为什么值得你看」。
      //    光一张卡片过去，对方只看到封面和标题，不知道你想让他注意哪儿 —— 理由才是分享这件事的一半。
      //    只在卡片**核实通过**之后才发：卡片都没落地就说"我为什么发给你"，对方会一头雾水。
      let reasonResult = null
      if (verified && reasonText) {
        if (gapSec > 0) await new Promise((res) => setTimeout(res, gapSec * 1000))
        const rArgs = []
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        rArgs.push('--text', reasonText)
        const r3 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j3 = pickJson(r3.stdout)
        reasonResult = j3
          ? {
            ok: !!j3.ok, sent: !!j3.sent, len: reasonText.length,
            readback: !!j3.readback, my_msg_before: j3.my_msg_before, my_msg_after: j3.my_msg_after,
            newest_from: j3.newest_from, error: j3.error,
          }
          : { ok: false, error: '理由那一条没返回可解析结果', stderr: String(r3.stderr || '').slice(0, 200) }
        if (reasonResult.ok) log(`share-card reason -> ${to || toId}: 已发送（卡片后隔 ${gapSec}s，${reasonText.length} 字）`)
        else log(`share-card reason 发送失败：${reasonResult.error || '未知'}`)
      }

      const allOk = sentN === ids.length && verified && (!reasonResult || reasonResult.ok)
      if (sentN) log(`share-card -> ${to}: 发出 ${sentN}/${ids.length} 张卡片，回读${verified ? '核实通过' : '未核实'}${reasonResult ? '，理由' + (reasonResult.ok ? '已发' : '失败') : ''}`)
      return {
        ok: allOk, sent: sentN, total: ids.length, to,
        readback,
        reason: reasonResult || undefined,
        reason_skipped: (verified && !reasonText) ? '没给 reason —— 只发了卡片，后面一句话都没跟上' : undefined,
        order_warning: orderWarn || undefined,
        results: results.map((x) => ({ aweme_id: x.aweme_id, ok: !!x.ok, sent: !!x.sent, error: x.error })),
        hint: verified ? undefined
          : (sentN ? '面板已经发出去点击了，但回读没在「我发的」消息里找到这张卡片 —— 别跟用户说发出去了，也没发理由' : undefined),
      }
    },
  })

  tool({
    name: 'douyin_notices',
    description: '读抖音互动通知：**谁 @ 了你**（含「别人评论区里的 @」）、谁关注/评论/点赞了你。'
      + '网页版没有通知中心页面，这个工具直接打通接口（只读，is_mark_read=0 不改变已读状态）。'
      + '返回里 at_n 就是 @ 你的条数。',
    parameters: {
      raw: { type: 'boolean', description: '连原始条目一起返回（默认 false）' },
    },
    async execute(args = {}) {
      const venvPy = join(stateDir, '.venv', 'Scripts', 'python.exe')
      if (!existsSync(venvPy)) return { ok: false, error: '还没装运行环境', hint: '设置页点「装主依赖」' }
      if (!existsSync(cookiePath(stateDir))) return { ok: false, error: '还没有 Cookie', hint: '先扫码登录' }
      const argv = [join(pluginDir, 'tools', 'notice-read.py')]
      if (args.raw) argv.push('--raw')
      const r = spawnSync(venvPy, argv, {
        encoding: 'utf8', timeout: 150_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }), windowsHide: true,
      })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
      if (j.n) log(`notices: ${j.n} 条，其中 @ 我 ${j.at_n} 条`)
      return j
    },
  })

  tool({
    name: 'douyin_comment_reply',
    description: '⭐ 在抖音评论区发言 / 回复某条评论 —— **一条 fetch 就发出去**：'
      + '不点开评论面板、不滚视口、**也不会弹短信验证**（点 UI 那条路一定会弹，实测过）。'
      + '传 comment_id 就是回复那条评论；不传就是发一条顶层评论。'
      + '配合 douyin_notices 用：它返回的 comment_id 就是这里的 comment_id。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 id（douyin_notices 返回的 aweme_id）' },
      text: { type: 'string', description: '评论正文（≤500 字）' },
      comment_id: { type: 'string', description: '要回复的评论 cid；留空 = 发顶层评论' },
      mention_name: { type: 'string', description: '要真 @ 的昵称（正文里必须原样出现「@昵称」；不传 = 当普通文字）' },
      mention_uid: { type: 'string', description: '被 @ 人的 uid —— 🔴 必须是**被 @ 人自己的**（从他的评论 user.uid 或主页接口拿，形如 11-1289250254）。⚠️ 别拿 account.json 的 me.uid —— 那是登录号自己，填了 @ 就变成 @ 自己（2026-10-21 踩过：点了名字进的是大肥鱼的主页）' },
      mention_secuid: { type: 'string', description: '被 @ 人的 sec_uid（真 @ 必须给）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回草稿不发送' },
    },
    async execute(args = {}) {
      const aweme = String(args.aweme_id || '').trim()
      const text = String(args.text || '').trim()
      const replyTo = String(args.comment_id || '').trim()
      const mentionName = String(args.mention_name || '').trim()
      const mentionUid = String(args.mention_uid || '').trim()
      const mentionSecUid = String(args.mention_secuid || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id', hint: '先 douyin_notices 拿到 aweme_id' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字），抖音评论放不下` }
      // 🔴 用户闸
      if (args.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true,
          aweme_id: aweme, comment_id: replyTo || '(顶层评论)',
          draft: text, len: text.length,
          note: '没发送 —— 先把这段给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      const argv = ['--aweme', aweme, '--text', text]
      if (replyTo) argv.push('--reply', replyTo)
      // ⭐ 真 @：三个参数齐了才传 —— 少一个都只会发出「普通文字的 @」（不变蓝、无通知，2026-10-21 主人实测）
      // 🔴 uid 必须是**被 @ 人**的：session-guard / account.json 里的 uid（4376484329564484）
      //    是**登录号（大肥鱼）自己** —— 抄错了就会 @ 成自己：名字照样蓝，但点进自己的主页、
      //    通知也永远不会来（2026-10-21 实测翻车）。要 @ 谁，就从**他的**评论 user 字段或
      //    他的主页接口拿 uid（形如 11-1289250254）。
      if (mentionName && mentionUid && mentionSecUid) {
        // 宿主自己的登录 uid 懒加载一次，用来拦「@ 自己」
        if (!selfUidCache) {
          const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
          const j = pickJson(g.stdout)
          if (j?.uid) selfUidCache = String(j.uid)
        }
        if (selfUidCache && String(mentionUid) === selfUidCache) {
          return { ok: false, error: `mention_uid=${mentionUid} 是登录号自己的 uid —— 这是 @ 自己。要 @ 谁，就从他的评论 user.uid 或主页接口拿 uid（别人的形如 11-1289250254）` }
        }
        if (!text.includes('@' + mentionName)) {
          return { ok: false, error: `正文里没有「@${mentionName}」原样出现 —— 真 @ 需要正文带这个 token，或去掉 mention_* 参数发普通评论` }
        }
        argv.push('--mention-name', mentionName, '--mention-uid', mentionUid, '--mention-secuid', mentionSecUid)
      }
      const r = runNodeTool('comment-api.mjs', argv, { timeout: 200_000 })
      const res = pickJson(r.stdout)
      if (!res) return { ok: false, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
      // ⭐ 回读：接口 200 + 给了 cid 只说明**服务端收下了**，不代表它出现在评论区里。
      //    再拉一遍评论，看这个 cid 在不在。
      //    ⚠️ 拉不到**不算失败** —— 新评论有审核/延迟，用"未核实"如实说，别谎报成功也别谎报失败。
      let readback = null
      if (res.ok && res.cid) {
        for (let i = 0; i < 3; i++) {
          await new Promise((done) => setTimeout(done, 1800))
          const cr = runPy('api-comments.py', [aweme], { timeout: 300_000 })
          const txt = String(cr.stdout || '')
          readback = { found: txt.includes(String(res.cid)), cid: String(res.cid), scanned: (txt.match(/cid=/g) || []).length, attempt: i + 1 }
          if (readback.found) break
        }
        if (!readback.found) readback.note = '评论区里还没刷到这条（审核或延迟），不代表没发出去 —— 报告里写「已提交，未在评论区核实到」'
      }
      if (res.ok) log(`comment-reply -> ${aweme}/${replyTo || 'top'}: cid=${res.cid}，回读${readback && readback.found ? '已确认在评论区' : '未核实'}`)
      return readback ? { ...res, readback } : res
    },
  })

  tool({
    name: 'douyin_im_read',
    description: '读私信：无头 Chrome（无窗口）打开会话，返回最近的对话 —— 每条都带 `from`（me / them / unknown），'
      + '所以能分清「他刚回了什么」和「我上次说了什么」。只读，不发任何东西。',
    parameters: {
      to: { type: 'string', description: '要打开的会话昵称；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 稳定 id（sec_uid）；重名时给这个' },
      limit: { type: 'number', description: '返回最近几条（默认 30，最多 60）' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道读谁的会话', hint: '传 to / to_id，或在设置里填私信对象' }
      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '读不到会话', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 300) }
      if (!j.ok) return j
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 60))
      const allMsgs = Array.isArray(j.messages) ? j.messages : []
      const msgs = allMsgs.slice(-limit)
      if (j.count) log(`im-read <- ${j.to || to}: ${j.count} 条（我 ${j.mine} / 他 ${j.them} / 不明 ${j.unknown}）`)
      return {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid, matched_by: j.matched_by,
        count: j.count, mine: j.mine, them: j.them, unknown: j.unknown,
        sender_attribution: j.sender_attribution,
        messages: msgs,
        // 他最近说的话（从新到旧），方便一眼看出要不要回。
        // ⚠️ 从**全量**算，不是从截断后的 msgs 算 —— 不然 limit 一小，他刚说的话就被切没了。
        their_latest: allMsgs.filter((m) => m.from === 'them').slice(-3).reverse(),
      }
    },
  })

  tool({
    name: 'douyin_comments',
    description: '取一个作品/图文下的评论（**签名的只读接口**，带楼中楼层级）。这是判断「好不好玩」的主要文本依据。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 ID' },
    },
    async execute(args = {}) {
      const id = String(args.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺 aweme_id' }
      const r = runPy('api-comments.py', [id], { timeout: 300_000 })
      const text = String(r.stdout || '')
      const lines = text.split('\n')
      const head = lines.find((l) => /status_code=/.test(l)) || ''
      const items = lines.filter((l) => /^\s{2}cid=|^\s{6}└ /.test(l)).map((s) => s.replace(/^\s+/, ''))
      if (r.status !== 0) return { ok: false, error: '拉评论失败', stderr: String(r.stderr || '').slice(0, 300), head }
      return {
        ok: true, aweme_id: id, head,
        count: items.filter((s) => s.startsWith('cid=')).length,
        comments: items,
      }
    },
  })

  tool({
    name: 'douyin_comment_status',
    description: '查「发评论」这套现在什么状态：三个闸开没开、今天发了几条、还剩多少额度。'
      + '只读，什么都不发。**真要发评论用 douyin_comment_reply。**',
    parameters: {},
    async execute() {
      let today = 0
      try {
        const log = JSON.parse(readFileSync(join(stateDir, 'comment-log.json'), 'utf8'))
        today = (log[dayKey()] || []).length
      } catch { today = 0 }
      const perDay = Number(cfg.commentPerDay) || 0
      return {
        ok: true,
        autoComment: Boolean(cfg.autoComment),
        commentExecutor: cfg.commentExecutor || 'off',
        mentionName: cfg.mentionName || '',
        perRun: Number(cfg.commentPerRun) || 0,
        perDay,
        today,
        quotaLeft: Math.max(0, perDay - today),
        note: '真正发评论走 douyin_comment_reply，而且必须用户点头（confirm:true）才发得出去',
      }
    },
  })

  tool({
    name: 'douyin_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、后端/登录/环境怎么样。',
    parameters: {},
    async execute() { return status() },
  })

  tool({
    name: 'douyin_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。',
    parameters: {},
    async execute() { return { ok: true, ...runDuty('manual') } },
  })

  tool({
    name: 'douyin_update',
    description: '检查「刷抖音」插件有没有新版本。只读，不安装、不自动升级 —— 只告诉你当前版本、最新版本和升级命令。',
    parameters: { force: { type: 'boolean', description: '忽略 10 分钟缓存，立刻重查（默认 false）' } },
    async execute(args = {}) { return checkUpdate(args?.force === true) },
  })

  tool({
    name: 'douyin_notify',
    description: '**往用户屏幕上发一条消息**（Windows 通知）。不给参数就用当前通知方式做一次连通性测试；'
      + '给了 title/body 就直接把这条内容弹出去。返回到底弹没弹成功。',
    parameters: {
      title: { type: 'string', description: '通知标题（可省）' },
      body: { type: 'string', description: '通知正文（可省，建议 ≤ 200 字）' },
    },
    async execute(args) {
      const t = String(args?.title ?? '').trim()
      const b = String(args?.body ?? '').trim()
      if (!t && !b) return notifyTest()
      const r = toastSend({ title: t || '刷抖音', body: b || '（空消息）' })
      log(`手动通知：${r.sent ? '已弹出' : '失败'}${r.error ? ' / ' + r.error : ''}`)
      return { ok: r.ok, sent: r.sent, via: 'toast', error: r.error || '' }
    },
  })

  tool({
    name: 'douyin_setup',
    description: '装运行环境：在插件家目录建独立 venv、装 MCP 依赖，装完自动把 pythonPath 指过去。'
      + '**第一次用之前跑一次**。起完就返回，进度看 install.log。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'douyin_login_save',
    description: '存抖音 Cookie（现在只有一条采集路，所以**所有功能都要它**）。'
      + '把浏览器 F12 → Network → 任意 douyin.com 请求 → Request Headers → 整行 Cookie 粘进来。',
    parameters: { cookie: { type: 'string', description: '整行 Cookie 字符串' } },
    async execute(args) {
      const r = saveCookie(stateDir, String(args.cookie ?? ''), log)
      // ⭐ 日志里绝不出现明文 Cookie
      log(`收到 Cookie（${redactCookie(String(args.cookie ?? '')).slice(0, 40)}…）`)
      return r
    },
  })

  tool({
    name: 'douyin_config',
    description: '读 / 改「刷抖音」的设置。不给 patch 就是读；给了就改。'
      + '**只认 schema 里真有的字段**，别的键一律丢掉（塞一个未知键会让 DSH 那边整批拒绝）。'
      + '私信投递是这两个：`dmTo`（昵称，只显示用）+ `dmToId`（**稳定 id，真正决定发给谁**）。'
      + '例：`{"perDay":5,"noon":true,"night":true,"keywords":["搞笑","猫"],"dmTo":"某帅气用户","dmToId":"MS4wLjABAAAA…"}`',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        host = (await persistCfg(args.patch)).host
      }
      return { ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(), host }
    },
  })

  /* ─────────────── 跑一轮 ─────────────── */
  const dutyStateFile = join(stateDir, 'state.json')
  // 登录号自己的 uid（懒加载缓存）—— 用于拦「@ 自己」
  let selfUidCache = ''
  /**
   * ⭐ 跨天翻篇：插件可能连续挂好几天，`state.json` 的 day 不该停在旧日期。
   *    只重置**按天算的计数**（轮数 / 挑了几条 / 谷时窗口），
   *    `dutyRunningAt` / `roundActive` 必须留着 —— 半夜跨点那一轮可能还在跑，不能把防双开的闸拆了。
   */
  const rollDay = () => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day === today) return st
    const next = { ...st, day: today, count: 0, picked: 0, windows: {} }
    writeJson(dutyStateFile, next)
    return next
  }
  const bumpState = (patch) => {
    const st = { ...rollDay(), ...patch }
    writeJson(dutyStateFile, st)
    return st
  }
  // 加载时先翻一次篇：哪怕今天还没跑过任何一轮，state.json 也不该显示昨天
  rollDay()

  /**
   * ⭐ 「每天最多挑几条」承诺的是**全天总量** ⇒ 数**今天报告里那些 `### <视频ID>` 标题行**。
   *    围栏 ``` 里的内容一律不看（兜底报告会把日志尾部贴进去，那里的 ID 是"看过的"不是"挑中的"）。
   *    数不出来就当 0 条 —— 宁可少算，也别把"提到过"算成"挑中"。
   */
  const PICK_RE = /^#{2,3}[ \t]*(\d{15,25})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  /**
   * ⭐ 优先用**真正的 Node.js** 去跑 dsh，而不是 Electron 的 `process.execPath`。
   *
   * 🔴 2026-10-20 实测（桌面版真机上必现）：
   *    用 `process.execPath`（Electron）+ `ELECTRON_RUN_AS_NODE=1` 起 dsh 会崩在启动阶段：
   *      `unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
   *       (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)`
   *    原因是 dsh 里有个 native addon（node-addon-require-builtin）按 Electron 大版本白名单校验，
   *    这台机器的 Electron 版本不在白名单里 ⇒ **那一轮直接 code=1 挂掉**。
   *    ⇒ 只要机器上有独立 node（开发机基本都有），就用它；没有才退回 Electron。
   *    （这也是 bili-scroll「桌面版上自动跑会卡/失败」那类反馈的根因之一。）
   */
  const findNodeExe = () => {
    try {
      const probe = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      if (probe.status !== 0) return ''
      if (!/^v\d+\./.test(String(probe.stdout || '').trim())) return ''
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      const first = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      return first || 'node'
    } catch { return '' }
  }
  let nodeExeCache
  const nodeExe = () => {
    if (nodeExeCache === undefined) nodeExeCache = findNodeExe()
    return nodeExeCache
  }

  const resolveDsh = () => {
    // 运行时脚本用哪个解释器：有独立 node 就用它（见上面那段实测说明）
    const jsRunner = () => nodeExe() || process.execPath
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: jsRunner(), args: [explicit], shell: false }
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    // ⭐ 桌面版是 Electron 安装包，不是 npm -g 装的 ⇒ 按 process.resourcesPath 猜
    // 🔴 2026-10-20 实测修正：这台机器上真实的 dsh 在
    //    `D:\DeepSeek\dsh-data\extracted-asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`
    //    （asar 被解开到 DSH_HOME/extracted-asar，而不是 resources 下面）⇒ 必须加上这个候选，
    //    否则只在 PATH 上找 'dsh'，而桌面版 PATH 里没有 ⇒ 那一轮必然起不来。
    if (process.resourcesPath) {
      for (const rel of [
        ['app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(process.resourcesPath, ...rel)
        if (existsSync(p)) return { command: jsRunner(), args: [p], shell: false }
      }
    }
    // ⭐ 桌面版另一条真实路径：DSH_HOME/extracted-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
    try {
      const dshHome = process.env.DSH_HOME || dirname(stateDir)
      for (const rel of [
        ['extracted-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['extracted-asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(dshHome, ...rel)
        if (existsSync(p)) return { command: jsRunner(), args: [p], shell: false }
      }
    } catch { /* 找不到就走下面的兜底 */ }
    for (const g of guesses) if (existsSync(g)) return { command: jsRunner(), args: [g], shell: false }
    log('⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js')
    return { command: 'dsh', args: [], shell: true }
  }

  /**
   * ⭐ 值班轮能看到哪些 MCP 工具（抄 bili-scroll 的白名单思路）：
   *    overlay 把整个 server 挂成 stdio server ⇒ 那一轮的模型能看见**注册的所有工具**。
   *    发评论那条链路只该在用户显式打开时才给 ⇒ 用 env 在**注册层**拦掉。
   *    扫码登录（`douyin_login_interactive`）**永远不给** —— 那是给人做的。
   */
  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    // ⭐ 0.2.1-rc.2 的 headless 自带 patch 把这三个服务 disabled 了 —— 在这里打开
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yml.push('- id: ' + id, '  disabled: false', '')
    }
    /**
     * 🔴 2026-10-20 实测（本机必现，不修就永远写不出报告）：
     *    headless 那一轮的沙箱默认把**工作区**当成唯一可写目录（本机是 `D:\aiagent\deepseek`），
     *    而报告要写到插件家（`<DSH_HOME>/douyin-duty/out/`）——**在插件家外面** ⇒ 被拒：
     *      「该路径在工作区 D:\aiagent\deepseek 之外，workspace-write 模式下拒绝访问」
     *    ⇒ 模型明明把 `douyin_prescreen` 调通了、也写出了正文，**最后一步落盘失败**，
     *      报告为空。而且它可能会**自作主张写到别处**或放弃。
     *    ✅ 修法：把这一轮的 sandbox 工作区**改成插件家**（仍然受限，不是 danger-full-access）：
     *       只放开"它该写的那一亩三分地"，别的照旧禁止。
     *    ⚠️ 注意这里必须用 **posix 路径**（YAML 里反斜杠会被当转义）。
     */
    yml.push(
      // ⭐ 让那一轮**的工作目录 = 插件家**（这是 bili-scroll 那条"cwd=插件家"的设计真正落地的地方）：
      //    `working-directory.defaultDirectory` 决定会话工作区，而 sandbox 的 workspaceRoot 默认跟着它走。
      //    只设 sandbox-policy 不够 —— 实测模型仍然把报告写到了 D:\aiagent\deepseek（宿主当前工作区）。
      '- id: working-directory',
      '  config:',
      `    defaultDirectory: '${posix(stateDir)}'`,
      '',
      // ⭐ 再显式钉一次 sandbox 工作区：两道都设，避免哪一层被 profile 自己那份覆盖掉。
      '- id: sandbox-policy',
      '  config:',
      "    mode: 'workspace-write'",
      `    workspaceRoot: '${posix(stateDir)}'`,
      '',
    )
    // ⭐ 让那一轮跟随桌面版当前选的模型（overlay 是最后叠加的一层 ⇒ 它赢）
    try {
      const deskPatch = join(dirname(stateDir), 'profiles', 'desktop', 'cordis.patch.yml')
      if (existsSync(deskPatch)) {
        const dlines = readFileSync(deskPatch, 'utf8').split(/\r?\n/)
        let start = -1
        for (let i = 0; i < dlines.length; i++) {
          if (/^-\s+id:\s*agent-default-model\s*$/.test(dlines[i])) { start = i; break }
        }
        if (start >= 0) {
          let end = dlines.length
          for (let j = start + 1; j < dlines.length; j++) {
            if (/^-\s+id:/.test(dlines[j])) { end = j; break }
          }
          const block = dlines.slice(start + 1, end).join('\n')
          const grab = (k) => {
            const m = new RegExp('^\\s+' + k + ':\\s*(.+?)\\s*$', 'm').exec(block)
            return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : ''
          }
          const provider = grab('provider'); const model = grab('model'); const effort = grab('reasoningEffort')
          if (provider && model) {
            yml.push('- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:',
              `    provider: '${provider}'`, `    model: '${model}'`, ...(effort ? [`    reasoningEffort: '${effort}'`] : []), '')
            log(`overlay: 模型跟随桌面版 = ${provider} / ${model}`)
          }
        }
      }
    } catch (e) { log(`读桌面版模型配置失败（不影响跑）：${e?.message ?? e}`) }
    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  const promptFor = (why = 'manual') => {
    let duty = charterPath(pluginDir, stateDir)
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 按原文用 */ }
    const kws = Array.isArray(cfg.keywords) ? [...new Set(cfg.keywords.filter(Boolean))] : []
    const chs = Array.isArray(cfg.channels) ? [...new Set(cfg.channels.filter(Boolean))] : []
    const aus = Array.isArray(cfg.authors) ? [...new Set(cfg.authors.filter(Boolean))] : []
    // ⭐ 关键词轮转：每轮取「最久没刷」的 6 个，再打乱顺序（别每轮把全库搜一遍，那太慢太贵）
    const kwPick = (() => {
      if (!kws.length) return { take: [], note: '用章程里的默认那几组' }
      let st = {}
      try { st = readJson(join(stateDir, 'kw_rotation.json'), {}) || {} } catch { st = {} }
      const roundNo = (Number(st.round) || 0) + 1
      const used = (st.used && typeof st.used === 'object') ? st.used : {}
      const take = kws.slice().sort((a, b) => (Number(used[a]) || 0) - (Number(used[b]) || 0)).slice(0, Math.min(6, kws.length))
      for (let i = take.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[take[i], take[j]] = [take[j], take[i]] }
      try {
        const nextUsed = { ...used }
        for (const k of take) nextUsed[k] = roundNo
        writeJson(join(stateDir, 'kw_rotation.json'), { round: roundNo, used: nextUsed })
      } catch { /* 写不了就退化成随机，不影响这一轮 */ }
      return { take, note: '' }
    })()
    const nowBJT = (() => {
      try {
        const d = new Date(Date.now() + 8 * 3600_000).toISOString()
        return d.slice(0, 10) + ' ' + d.slice(11, 16) + '（Asia/Shanghai，+08:00）'
      } catch { return '' }
    })()
    // ⭐ 人设：**三层**，从上往下找，找到就用，绝不读插件外面任意路径。
    //    ① `$DOUYIN_HOME/persona.md` —— 使用者自己那份（设置页「我的人设」写的，或他手放进去的）
    //    ② `prompts/persona.md`     —— 发布包自带的那份（作者自己的，**不随公开仓库发布**）
    //    ③ `prompts/persona.default.md` —— 中性默认（谁装了都能用，不带任何具体人）
    //    身份牌必须对得上，对不上就往下退 —— 这样用户放错文件也不会串人设。
    let ownerDoc = ''
    let personaWarn = ''
    let personaFrom = ''
    try {
      const cands = [
        { file: join(stateDir, 'persona.md'), who: 'douyin-scroll', from: '使用者自己那份（$DOUYIN_HOME/persona.md）' },
        { file: join(pluginDir, 'prompts', 'persona.md'), who: 'douyin-scroll', from: '插件自带' },
        { file: join(pluginDir, 'prompts', 'persona.default.md'), who: 'default', from: '默认中性人设' },
      ]
      const bad = []
      for (const c of cands) {
        if (!existsSync(c.file)) continue
        const raw = readFileSync(c.file, 'utf8')
        const firstLine = raw.split(/\r?\n/, 1)[0] || ''
        const m = /persona:\s*([A-Za-z0-9_-]+)/i.exec(firstLine)
        const who = m ? m[1].toLowerCase() : ''
        if (who !== c.who) { bad.push(`${c.file}（牌子是「${who || '没有'}」，应为 ${c.who}）`); continue }
        ownerDoc = `\n\n===== 我的人设（${c.from}，**按这个来**）=====\n` + raw.slice(0, 6000) + '\n===== 设定结束 =====\n'
        personaFrom = c.from
        break
      }
      if (bad.length) {
        personaWarn = `\n\n⚠️ 有 ${bad.length} 份人设文件的身份牌不对，已跳过：${bad.join('；')}\n`
        log(`人设身份牌不对，已跳过：${bad.join(' | ')}`)
      }
      if (personaFrom) log(`本轮人设来源：${personaFrom}`)
    } catch (e) { log(`读人设失败：${e?.message ?? e}`) }

    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countPickedToday()
    const left = Math.max(0, quota - already)
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.commentExecutor !== 'off')

    return `你是这个账号的抖音助手。`
      + `⏰ **现在时间（真实北京时间）：${nowBJT}** —— 报告里凡是提到时间，一律用这个，**别自己猜**。`
      + `⭐ 这一轮的工作目录是 ${stateDir}（插件家），**报告和判重表都写在这里面**。`
      + ownerDoc
      + personaWarn
      + (ownerDoc ? '' : '⭐ 这一轮**没有**拿到使用者的人设 ⇒ **按中性说话**，别扮演任何人。')
      + `\n\n⭐ **这一轮只有一件事**：读章程 ${duty}，按里面的判据刷一轮抖音，把报告写到 `
      + `${join(outDir, `${dayKey()}.md`)}。`
      + (cfg.reportLevel === 'brief'
        ? `日报写成**薄版**：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮**不要写日报文件**；只有真发了评论才留一句话。`
          : `日报写**完整版**（为什么值得 + 你自己的一句话）。`)
      + (cfg.reportLevel === 'off' ? '' : `⚠️ 今天那份报告里可能已有上一轮的内容 ⇒ **追加到末尾，别覆盖**（配额按全天算）。`)
      + (cfg.reportLevel === 'off' ? '' : '⭐ 报告里**每挑中一条**，第一行必须顶格写 `### 视频ID`（例 `### 7401234567890123401`）—— 宿主**就数这些标题行**算今天挑了几条。只是提到 / 跳过 / 判断不了 的**不要**加这种标题（加了会吃掉额度）。')
      + `\n\n📋 **这一轮的输入**：`
      + `关键词：${kwPick.take.length ? kwPick.take.join('、') : kwPick.note}`
      + (chs.length ? `；分类：${chs.join('、')}` : '')
      + (aus.length ? `；指定作者：${aus.join('、')}` : '')
      + `。⭐ **就搜这些，别自己加词**（尤其是别自造"翻跳/宅舞"那类词把类型带偏）。`
      + `\n🎯 **先读** \`${join(stateDir, 'round-evidence.json')}\` —— 候选和证据已经帮你抓好放在那儿了。`
      + ` 每条都有：文案 / 作者 / 时长 / 发布时长 / 四个互动数 / 三个比值 / 前几条的高赞评论。`
      + ` ⚠️ 这一轮**你手上没有 douyin_* 工具，也不需要** —— 采集和算比值是代码干的活，你只负责判断和写报告。`
      + `⚠️ 抖音 web **没有可用的关键词搜索接口**，上面这些关键词/分类**只能当报告里的标注**，别以为它按词搜了。`
      + `\n🔎 **判断口径**（章程里有更细的）：你**看不到画面**，只能看**文案 + 标签 + 互动比值 + 高赞评论**。`
      + `所以你要回答的是「**值不值得他花 15 秒点开**」，不是「视频讲了什么」。`
      + `⭐ **每条结论都要引用具体证据**（哪条评论、哪个比值）；证据不够就写「判断不了」，**别硬猜**。`
      + `\n📉 **跳过要计数**：证据包里的 \`dropped\` 就是采集侧硬筛掉的条数——`
      + `\`no_desc\` 没文案 / \`too_short_video\` 时长<12 秒 / \`short_and_quiet\` 文案太短且评论少。`
      + `照实写进报告（「因文案太短且评论少跳过 N 条」…），别让使用者以为漏抓了。`
      + `\n`
      + (already > 0
        ? `今天已经挑过 ${already} 条 ⇒ **这一轮最多再挑 ${left} 条**（「每天最多 ${quota} 条」是全天总量，不是每轮）；`
        : `今天最多挑 ${quota} 条；`)
      + `采集：推荐流只读接口（不签名、不碰写接口）。`
      + `\n判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**）；读不出来/写不进去**必须在报告里明说**。`
      + `\n`
      + (commentOn
        ? `🔴 **自动评论是开着的**：每轮最多 ${Number(cfg.commentPerRun) || 0} 条，每条 **≤120 字**，`
          + `**正文必须以「@${cfg.mentionName} 」开头**。发之前**先调 \`douyin_comment_status\`** 确认 allowed=true。`
          + `⚠️ 只对**最有把握的「推荐」档**发，不是每条都发。`
        : `🔴 **自动评论关着**：**一个字都不要往抖音发**（只写报告）。`)
      + `\n⭐ 保底：不管发生什么，**报告至少留一行**（哪怕只写「本轮失败：原因是 X」），别让 out/ 空着。`
      + `\n最后用两三句话汇报你挑到了什么。`
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   *    （bili-scroll 的用户实测反馈：卡住时 out/ 是空的 ⇒ 使用者完全看不到发生了什么）
   */
  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      writeFileSync(f, [
        `# 刷抖音 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '> 常见原因：工具连续失败、或者把预算烧完了。下一轮它会重来。',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }

  /* ⭐ 防双开：内存标记 + 落盘标记（改配置会重新挂载插件，内存标记会丢） */
  let dutyRunning = false
  const ROUND_STALE_MS = 30 * 60 * 1000
  const roundBusyInState = () => {
    try {
      const st = readJson(dutyStateFile, {})
      if (!st || !st.roundActive) return false
      const at = Number(st.dutyRunningAt || 0)
      if (!at || Date.now() - at > ROUND_STALE_MS) { bumpState({ roundActive: false }); return false }
      return true
    } catch { return false }
  }

  /**
   * 一轮结束后：按 notifyMode 把结果推出去。
   *   toast   —— Windows 通知（默认；零配置，真能弹到用户屏幕上）
   *   file    —— 不额外提醒（报告照样写进 out/）
   *   webhook —— 推群/机器人
   *   both    —— toast + webhook
   * 报告文件**永远**写，这里只管"额外提醒"。
   */
  const notifyRoundEnd = async (code) => {
    try {
      const mode = String(cfg.notifyMode || 'toast')
      if (mode === 'file') return
      const wantToast = mode === 'toast' || mode === 'both'
      const wantHook = mode === 'webhook' || mode === 'both'
      const f = join(outDir, `${dayKey()}.md`)
      const text = (() => { try { return readFileSync(f, 'utf8') } catch { return '' } })()
      const fallback = `（这一轮没有产出报告，退出码 ${code}）`

      if (wantToast) {
        const s = toastSummary(text || fallback, { day: dayKey() })
        const r = toastSend({ title: s.title, body: s.body })
        log(`通知：Toast ${r.sent ? '已弹出' : '失败'}${r.error ? ' / ' + r.error : ''}`)
      }
      if (!wantHook) return
      const url = String(cfg.webhookUrl || '').trim()
      if (!url) { log('通知：选了 webhook 但没填地址 ⇒ 跳过'); return }
      const { title, text: body } = condense(text || fallback, { title: `刷抖音 · ${dayKey()}` })
      const r = await sendWebhook({ url, preset: cfg.webhookPreset, title, markdown: body })
      log(`通知：webhook ${r.ok ? '已发送' : '失败'} → ${maskUrl(url)}${r.error ? ' / ' + r.error : ''}`)
    } catch (e) { log(`通知异常（不影响这一轮）：${e?.message ?? e}`) }
  }

  /** 设置页「测试通知」：按当前 notifyMode 真发一次，返回到底通没通 */
  const notifyTest = async () => {
    const mode = String(cfg.notifyMode || 'toast')
    const out = { mode, toast: null, webhook: null, ok: false, error: '' }
    try {
      if (mode === 'file') {
        out.error = '当前是「只写文件」，不会弹通知/推 webhook —— 先换成别的通知方式再测'
        return out
      }
      if (mode === 'toast' || mode === 'both') {
        const r = toastSend({
          title: '刷抖音 · 通知测试',
          body: `能看到这条，就说明消息通道通了 ✅\n${new Date().toLocaleString('zh-CN')}\n报告目录：${outDir}`,
        })
        out.toast = r
        if (!r.ok) out.error = 'Toast 失败：' + (r.error || '未知')
      }
      if (mode === 'webhook' || mode === 'both') {
        const r = await sendWebhook({
          url: cfg.webhookUrl,
          preset: cfg.webhookPreset,
          title: '刷抖音 · 通知测试',
          markdown: `这是一条测试消息。\n\n- 时间：${new Date().toISOString()}\n- 预设：${cfg.webhookPreset}\n- 报告目录：\`${outDir}\`\n\n收到这条就说明通知通了 ✅`,
        })
        out.webhook = r
        if (!r.ok && !out.error) out.error = 'webhook 失败：' + (r.error || '未知')
      }
      out.ok = Boolean((out.toast?.sent) || (out.webhook?.ok))
      return out
    } catch (e) {
      out.error = String(e?.message ?? e)
      return out
    } finally {
      log(`通知测试（${mode}）：${out.ok ? '通过' : '没通过'} ${out.error || ''}`)
    }
  }

  /**
   * ⭐ 这一轮给模型看的证据包：**在插件里先抓好**，写到 `<家>/round-evidence.json`。
   *
   * 为什么不在那一轮里调工具：2026-10-21 砍掉内置 MCP 之后，headless 那一轮手上已经没有
   * 任何 douyin_* 工具了 —— 而且本来也不该有：采集 + 预筛 + 算比值是**代码活**，
   * 交给模型只会烧 token、还会因为"工具失败两次"把整轮预算耗光。
   */
  const buildEvidence = (limit = 12) => {
    try {
      const max = Math.max(1, Math.min(Number(limit) || 12, 30))
      const r = runPy('forward-pick.py', ['--limit', String(max)], { timeout: 300_000 })
      if (r.status !== 0) return { ok: false, error: String(r.stderr || '').slice(0, 300) }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, max)
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
        }
        // 前 5 条顺手拉一下高赞评论 —— 这是判断"好不好玩"最有力的证据
        if (i < 5 && Number(x.comment) > 0) {
          const c = runPy('api-comments.py', [String(x.aweme_id)], { timeout: 200_000 })
          const lines = String(c.stdout || '').split('\n').filter((l) => /^\s{2}cid=/.test(l))
          item.top_comments = lines.slice(0, 5).map((s) => s.replace(/^\s+/, '').replace(/^cid=\d+\s+/, '').slice(0, 160))
        }
        list.push(item)
      }
      writeJson(join(stateDir, 'round-evidence.json'), {
        builtAt: new Date().toISOString(),
        sources: picked.meta || [],
        dropped: picked.dropped || {},
        thresholds: picked.thresholds || {},
        count: list.length,
        list,
      })
      return { ok: true, count: list.length }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  const runDuty = (why = 'window') => {
    try {
      if (dutyRunning || roundBusyInState()) {
        log(`刷抖音已在跑，忽略这次触发（${why}）`)
        return { started: false, why, busy: true, error: '上一轮还没结束，别重复点' }
      }
      refreshCfg()
      syncCollectorCfg()
      // ⭐ 手动触发也要过每日配额闸（bili-scroll 踩过：连点两次手动，一天从 20 条刷到 80 条）
      const quota = Number(cfg.perDay || 0)
      const picked = countPickedToday()
      if (quota > 0 && picked >= quota) {
        log(`配额已满：今天已挑 ${picked} 条（上限 ${quota}），这一轮不跑`)
        return { started: false, why, quotaFull: true, picked, quota, error: `今天的配额已经用完了（已挑 ${picked} / 上限 ${quota}）` }
      }
      // ⭐ 先把闸拉上（防双开），再去异步准备证据包 + 起那一轮 —— 准备证据要十几秒，
      //    同步做会把宿主卡住（HTTP 请求和定时器都在这条线程上）。
      dutyRunning = true
      bumpState({
        dutyRunningAt: Date.now(),
        roundActive: true,
        lastRunAt: new Date().toISOString(),
        lastWhy: why,
        count: roundsToday() + 1,
      })
      ;(async () => {
        try {
          const ev = buildEvidence(Math.max(1, Math.min(Number(cfg.maxPerRun) || 12, 30)))
          log(ev.ok
            ? `证据包已备好：${ev.count} 条 → ${join(stateDir, 'round-evidence.json')}`
            : `证据包没备成（${ev.error}）—— 这一轮照样起，模型会读到空包并如实写进报告`)
          const dsh = resolveDsh()
          const overlay = ensureOverlay()
          const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
          if (overlay) args.push('--patch', overlay)
          args.push(promptFor(why))
          const cwd = stateDir
          log(`刷抖音开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
          const child = spawn(dsh.command, args, {
            cwd,
            shell: dsh.shell,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: pyEnv({ DOUYIN_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
          })
          /**
           * ⭐ 超时看门狗（2026-10-20 实测加）：那一轮**干完活之后可能不退出** ——
           *    实测模型已经把报告写完了、也回话了，但进程又挂了十几分钟（MCP 子进程把事件循环撑住）。
           *    没有这道闸，`dutyRunning` 会一直是 true ⇒ 之后的定时器全被"防双开"挡掉，
           *    直到 30 分钟后陈旧标记才恢复。
           *    ⇒ 超过 roundTimeoutMin（默认 15 分钟）就杀掉，并按"超时"记账。
           */
          const timeoutMin = Math.max(3, Math.min(Number(process.env.DOUYIN_ROUND_TIMEOUT_MIN) || 15, 120))
          const watchdog = setTimeout(() => {
            try {
              log(`⚠️ 这一轮超过 ${timeoutMin} 分钟没结束 ⇒ 强制结束（报告可能已经写了）`)
              child.kill()
              // 再给 10 秒收尸，还不退就硬杀整棵子树
              setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经没了 */ } }, 10_000).unref?.()
            } catch (e) { log(`看门狗杀进程失败：${e?.message ?? e}`) }
          }, timeoutMin * 60_000)
          watchdog.unref?.()
          // ⚠️ 这里是 stream 的 data 回调 —— 抛异常会**杀掉整个宿主进程** ⇒ rawWrite 内部已全包 try/catch
          child.stdout?.on('data', (b) => rawWrite(String(b)))
          child.stderr?.on('data', (b) => rawWrite(String(b)))
          child.on('exit', (code) => {
            try { clearTimeout(watchdog) } catch { /* 无所谓 */ }
            dutyRunning = false
            bumpState({ dutyRunningAt: 0, roundActive: false })
            log(`刷抖音结束（${why}，code=${code}）`)
            stubReportIfMissing(code)
            rotateLogIfBig()
            try {
              const st = readJson(dutyStateFile, {})
              const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
              const picked = countPickedToday()
              if (picked > prev) { bumpState({ picked }); log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`) }
            } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
            // 通知（不阻塞、失败只记日志）
            Promise.resolve(notifyRoundEnd(code)).catch((e) => log('通知异常：' + (e?.message ?? e)))
          })
          child.on('error', (e) => { dutyRunning = false; bumpState({ roundActive: false }); log(`刷抖音起不来：${e?.message ?? e}`) })
        } catch (e) {
          dutyRunning = false
          bumpState({ dutyRunningAt: 0, roundActive: false })
          log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
        }
      })()
      return { started: true, why, profile: cfg.headlessProfile, note: '正在准备证据包（十几秒），随后起那一轮 —— 进度看 duty.log' }
    } catch (e) {
      dutyRunning = false
      bumpState({ roundActive: false })
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 定时器回调里抛的异常**没人接**，会直接把整个宿主进程带走 ⇒ 必须自己兜住所有异常。
   */
  const tick = () => {
    try {
      refreshCfg()
      // ⚠️ 2026-10-22：去掉了 `if (!cfg.peakValley) return`。
      //    那个总开关在设置页重构后**已经没有 UI 了**，而它的默认值是 false ⇒
      //    用户怎么配时段都不会跑，属于"配了没反应"的死锁。
      //    现在「有没有任何一个时段开着」本身就是开关：全关 = 只手动跑。
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return
      // ⭐ 把所有生效的时段拼成一个列表：内置中午/晚上 + 用户自定义
      //    自定义的也按「每天一次」去重，key 用 `custom:<下标>`，改时段后旧 key 自然失效。
      const range = []
      if (cfg.noon) range.push({ key: 'noon', label: '中午', ...WINDOWS.noon })
      if (cfg.night) range.push({ key: 'night', label: '晚上', ...WINDOWS.night })
      const customs = Array.isArray(cfg.windows) ? cfg.windows : []
      customs.forEach((w, i) => {
        const s = String(w?.start || '').trim()
        const e = String(w?.end || '').trim()
        if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e)) return
        range.push({ key: `custom:${i}`, label: String(w?.label || '').trim() || `${s}–${e}`, start: s, end: e })
      })

      for (const w of range) {
        if (!inWindow(now, w)) continue
        const key = `${today}:${w.key}`
        if (st.windows?.[key]) continue
        // 只记「这个时段用过了」；轮数 / lastRunAt / lastWhy 由 runDuty 统一记
        bumpState({ windows: { ...(st.windows || {}), [key]: true } })
        runDuty(`window:${w.key}`)
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 健康信号 ─────────────── */
  const healthFile = join(stateDir, 'health.json')
  const writeHealth = () => {
    try {
      const st = rollDay()
      const alerts = []
      if (!venvReadyNow()) alerts.push('venv_missing: 没装运行环境（设置页点「装主依赖」）')
      if (!hasCredential(stateDir)) alerts.push('cred_missing: 还没登录（设置页扫码，或粘一条 Cookie）')
      if (dutyRunning && st.dutyRunningAt && Date.now() - Number(st.dutyRunningAt) > 20 * 60_000) {
        alerts.push(`duty_slow: 当前轮已经跑了 ${Math.round((Date.now() - Number(st.dutyRunningAt)) / 60_000)} 分钟还没结束`)
      }
      writeFileSync(healthFile, JSON.stringify({
        ts: new Date().toISOString(),
        plugin: myVersion(),
        peakValley: cfg.peakValley,
        dutyRunning,
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        pickedToday: countPickedToday(),
        perDay: Number(cfg.perDay || 0),
        loggedIn: hasCredential(stateDir),
        venvReady: venvReadyNow(),
        alerts,
      }, null, 2), 'utf8')
    } catch { /* 健康文件写不进去也不能出事 */ }
  }
  writeHealth()
  try {
    const ht = setInterval(writeHealth, 90_000)
    ht.unref?.()
    ctx.effect(() => () => clearInterval(ht), 'douyin-duty: 健康信号')
  } catch { /* 起不来就算了 */ }

  /* ─────────────── HTTP（设置页用） ─────────────── */
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  /* ─────────────── 检查更新 ───────────────
   * 🔴 三条设计约束：
   *   ① **不能拖慢面板**：走异步 fetch + 3 秒超时，查不到就报"查不到"，绝不让设置页转圈。
   *   ② **不写死仓库地址**：发布者可能换 GitHub 用户名、也可能只发 npm ⇒ 按下面顺序自己找。
   *   ③ **不自动升级**：只告诉有没有新版本 + 怎么升。装插件是使用者的事（改 profile 是他的机器）。
   *   查过的结果落 `<家>/update.json`，10 分钟内不重复打网络（面板会反复渲染）。
   */
  const updateFile = join(stateDir, 'update.json')
  let updateCache = null
  const cmpVer = (a, b) => {
    const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x > y ? 1 : -1
    }
    return 0
  }
  const pkgMeta = () => {
    try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) } catch { return {} }
  }
  /** 从 package.json 的 repository 里掏出 owner/repo（支持字符串和对象两种写法） */
  const repoSlug = () => {
    const r = pkgMeta().repository
    const url = typeof r === 'string' ? r : (r && r.url) || ''
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(String(url))
    return m ? `${m[1]}/${m[2]}` : ''
  }
  const fetchJson = async (url, timeoutMs = 3000) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, json: await res.json() }
    } catch (e) {
      return { ok: false, error: String(e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? e)).slice(0, 160) }
    } finally { clearTimeout(timer) }
  }
  /**
   * 查一次最新版本。没网/没发布都不算错，返回 checked:false + 为什么。
   * @param {boolean} force 忽略 10 分钟缓存
   */
  const checkUpdate = async (force = false) => {
    const cur = myVersion()
    const explicit = String(cfg.updateUrl || '').trim()
    // ⚠️ 缓存必须带**来源指纹**：改了「更新地址」还拿旧缓存，用户会以为新地址没生效
    //    （2026-10-22 实测踩过：把 updateUrl 指到本地假服务，面板还显示旧结果）
    const sig = `${cur}|${explicit}`
    const cached = readJson(updateFile, null)
    const fresh = (o) => o && Date.now() - Number(o.at || 0) < 600_000 && o.sig === sig
    if (!force && fresh(updateCache)) return { ...updateCache, cached: true }
    if (!force && fresh(cached)) return { ...cached, cached: true }
    const meta = pkgMeta()
    const name = String(meta.name || 'dsh-douyin-scroll')
    const sources = []
    if (explicit) sources.push({ kind: 'url', name: '自定义地址', url: explicit })
    sources.push({ kind: 'npm', name: 'npm registry', url: `https://registry.npmjs.org/${encodeURIComponent(name)}/latest` })
    const slug = repoSlug()
    if (slug) {
      for (const br of ['main', 'master']) {
        sources.push({ kind: 'github', name: `GitHub ${slug}@${br}`, url: `https://raw.githubusercontent.com/${slug}/${br}/package.json` })
      }
    }
    const tried = []
    let latest = ''
    let from = ''
    for (const s of sources) {
      const r = await fetchJson(s.url)
      if (r.ok && r.json && r.json.version) {
        latest = String(r.json.version)
        from = s.name
        tried.push({ source: s.name, ok: true, version: latest })
        break
      }
      tried.push({ source: s.name, ok: false, error: r.error || '没有 version 字段' })
    }
    const out = {
      ok: true,
      current: cur,
      latest: latest || '',
      source: from,
      checked: Boolean(latest),
      hasUpdate: Boolean(latest) && cmpVer(latest, cur) > 0,
      tried,
      sig,
      at: Date.now(),
      // 升级怎么做——别让使用者猜
      how: latest && cmpVer(latest, cur) > 0
        ? `dsh plugin --profile <你的profile> add ${name}@${latest}  然后重启 dsh`
        : '',
      note: latest ? '' : `查不到最新版本（试了 ${sources.length} 个来源）。插件可能还没发布到 npm / GitHub，或者这台机器连不上外网 —— 可以在设置里填「更新地址」。`,
    }
    updateCache = out
    try { writeJson(updateFile, out) } catch { /* 写不进去不影响 */ }
    log(`检查更新：当前 ${cur} / 最新 ${latest || '(查不到)'}${from ? '（' + from + '）' : ''}`)
    return out
  }

  const status = () => {
    refreshCfg()
    const st = rollDay()
    const today = dayKey()
    const tail = (f) => { try { return readFileSync(f, 'utf8').slice(-1400) } catch { return '' } }
    const cred = credentialInfo(stateDir)
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows: WINDOWS,
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,
      pickedToday: countPickedToday(),
      perDay: Number(cfg.perDay || 0),
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: cred.hasCredential,
      hasCredential: cred.hasCredential,
      keys: cred.important.length ? cred.important : cred.keys.slice(0, 8),
      venvReady: venvReadyNow(),
      installing,
      installLog: installLogFile,
      installTail: tail(installLogFile),
      report: reportFileOf(new Date()),
      version: myVersion(),
      cookieFile: cookiePath(stateDir),
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/douyin-duty/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/douyin-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of Object.keys(DEFAULTS)) if (k in body) patch[k] = body[k]
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/run') return sendJson(res, 200, { ok: true, ...runDuty('manual') })

    /* ── 检查更新 ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/update') {
      const force = String(url.searchParams.get('force') || '') === '1'
      return sendJson(res, 200, await checkUpdate(force))
    }

    /* ── 新手流程说明（面板上「怎么用？」拿这份）── */
    if (req.method === 'GET' && path === '/api/douyin-duty/guide') {
      let text = ''
      let err = ''
      try { text = readFileSync(join(pluginDir, 'GUIDE.md'), 'utf8') } catch (e) { err = String(e?.message ?? e) }
      return sendJson(res, 200, { ok: true, text, file: join(pluginDir, 'GUIDE.md'), error: err || undefined })
    }

    /* ── 给别的 AI 用：MCP 配置 + 使用说明 ──
     * 面板上「复制这段配置」拿的就是这里生成的东西 —— 路径按**这台机器**算好，
     * 不写盘符（不然别人抄过去一定错）。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/ai-usage') {
      const serverPath = join(pluginDir, 'tools', 'mcp-server.mjs')
      const mcpConfig = {
        mcpServers: {
          douyin: {
            command: 'node',
            args: [serverPath],
            env: { DOUYIN_HOME: stateDir },
          },
        },
      }
      let doc = ''
      let docError = ''
      try { doc = readFileSync(join(pluginDir, 'AI-USAGE.md'), 'utf8') } catch (e) { docError = String(e?.message ?? e) }
      return sendJson(res, 200, {
        ok: true,
        doc,
        doc_error: docError || undefined,
        file: join(pluginDir, 'AI-USAGE.md'),
        mcp: {
          server: serverPath,
          exists: existsSync(serverPath),
          selfTest: `node "${serverPath}" --selftest`,
          home: stateDir,
          config: mcpConfig,
          configText: JSON.stringify(mcpConfig, null, 2),
          note: '任何支持 MCP 的工具（Claude Code / Cursor / Cline / 另一个 DSH）把这段填进它的 MCP 配置即可。',
        },
        // DSH 自己也能把这份 server 挂成 MCP —— 给一段可以直接抄的 patch
        dshPatch: [
          '- id: mcp-douyin',
          "  name: '@deepseek-ai/dsh-mcp-client'",
          '  config:',
          '    serverName: douyin',
          '    transport: stdio',
          `    command: 'node'`,
          `    args: ['${serverPath.replace(/\\/g, '/')}']`,
          '    env:',
          `      DOUYIN_HOME: '${stateDir.replace(/\\/g, '/')}'`,
          '',
        ].join('\n'),
      })
    }

    /* ── 环境体检（纯 Node，不需要 Python —— 用户第一次点它时还没有 venv） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/doctor') {
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, items: [], must_fix: [],
          error: '体检脚本没返回可解析结果',
          stderr: String(r.stderr || '').slice(0, 300),
        })
      }
      log(`doctor: ${(j.must_fix || []).length} 项必须修 / ${(j.warns || []).length} 项待办`)
      return sendJson(res, 200, j)
    }

    /* ── 人设：读 / 写使用者自己那份（$DOUYIN_HOME/persona.md）──
     * 优先级：使用者自己那份 > 插件自带 > 默认中性。
     * 这里只让写使用者那份 —— 插件包里那两份是随包发布的，不该被页面改。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/persona') {
      const mine = join(stateDir, 'persona.md')
      const has = existsSync(mine)
      let text = ''
      try { if (has) text = readFileSync(mine, 'utf8') } catch { text = '' }
      let defText = ''
      try { defText = readFileSync(join(pluginDir, 'prompts', 'persona.default.md'), 'utf8') } catch { defText = '' }
      return sendJson(res, 200, {
        ok: true, custom: has, text, default_text: defText,
        file: mine,
        hint: has ? '正在用你这份' : '还没写自己的 —— 现在用的是插件自带 / 默认人设',
      })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/persona') {
      const body = await readBody(req)
      const text = String(body.text ?? '')
      const mine = join(stateDir, 'persona.md')
      if (!text.trim()) {
        // 空 = 删掉自己那份，退回默认
        try { if (existsSync(mine)) rmSync(mine) } catch { /* 已经没了 */ }
        log('人设：已清空自定义，退回默认')
        return sendJson(res, 200, { ok: true, custom: false })
      }
      // ⭐ 身份牌必须有，否则下一轮会被跳过 —— 帮用户补上，别让他踩坑
      let out = text
      if (!/^<!--\s*persona:/i.test(out.trimStart())) {
        out = '<!-- persona: douyin-scroll -->\n' + out
      }
      try {
        writeFileSync(mine, out, 'utf8')
        log(`人设：已保存自定义（${out.length} 字）→ ${mine}`)
        return sendJson(res, 200, { ok: true, custom: true, file: mine })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/install') return sendJson(res, 200, runInstall())
    if (req.method === 'POST' && path === '/api/douyin-duty/install-browser') {
      return sendJson(res, 200, { ok: false, gone: true, hint: '2026-10-21 起不再需要浏览器依赖 —— bb-browser / playwright 那套已经整个删掉了' })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/check') {
      const out = { ok: false, steps: [] }
      if (!venvReadyNow()) { out.error = '环境还没装好 —— 点「装主依赖」'; return sendJson(res, 200, out) }
      if (!hasCredential(stateDir)) { out.error = '还没登录 —— 先扫码，或粘一条 Cookie'; return sendJson(res, 200, out) }
      try {
        const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
        const j = pickJson(r.stdout) || {}
        out.session = { alive: j.alive === true, nick: j.nick || null, code: j.code ?? null }
        if (j.alive === true) out.steps.push(`登录有效${j.nick ? '（' + j.nick + '）' : ''}`)
        else { out.error = `会话不健康：code=${j.code ?? '?'} ${j.why || ''}`; return sendJson(res, 200, out) }
      } catch (e) { out.error = '体检失败：' + (e?.message ?? e); return sendJson(res, 200, out) }
      try {
        runPy('forward-pick.py', [], { timeout: 300_000 })
        let picked = {}
        try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
        const rows = Array.isArray(picked.rows) ? picked.rows : []
        out.sample = JSON.stringify(rows.slice(0, 2).map((x) => String(x.desc || '').slice(0, 40))).slice(0, 300)
        out.ok = rows.length > 0
        if (out.ok) out.steps.push(`能拿到候选（${rows.length} 条）`)
        else out.error = '拿不到候选 —— 推荐流这轮可能返回空，过会儿再试'
      } catch (e) { out.error = '取候选失败：' + (e?.message ?? e) }
      return sendJson(res, 200, out)
    }
    if (req.method === 'GET' && path === '/api/douyin-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, opened: dir, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }
    // ── Cookie ──
    if (req.method === 'GET' && path === '/api/douyin-duty/login/status') {
      const info = credentialInfo(stateDir)
      return sendJson(res, 200, {
        ok: true, hasCredential: info.hasCredential, keys: info.keys,
        who: info.important.join(', '), at: info.at, bytes: info.bytes,
        backend: 'feed（只读推荐流接口）',
      })
    }

    /* ⭐ 扫码登录（2026-10-22 加）—— 以前只写在文档里让人敲命令行，新手根本走不到。
     *   现在面板一键：出二维码 → 手机扫 → 点「我扫完了」。
     *
     *   QR 是**有头** Chrome 截的图，存 $DOUYIN_HOME/login-qr.png；
     *   面板拿 `qr_url` 直接 <img> 显示（同一个 webServer 下加了一条静态路由）。
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/login/qr') {
      const force = String((await readBody(req))?.force || '') === '1'
      // 先确保后台无头浏览器不占着 profile —— 它和扫码窗口共用一个 user-data-dir
      if (force) {
        runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
        await new Promise((r) => setTimeout(r, 1200))
      }
      const r = runNodeTool('qr-login.mjs', ['start'], { timeout: 120_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        log(`扫码登录：出码失败（exit=${r.status}）${String(r.stderr || '').slice(0, 160)}`)
        return sendJson(res, 200, {
          ok: false,
          error: '出二维码失败',
          detail: String(r.stderr || r.stdout || '').slice(-600),
          hint: '常见原因：没装浏览器 / Chrome 被别的进程锁住。点「关掉后台浏览器重试」再试一次',
        })
      }
      if (!j.ok) {
        log(`扫码登录：${j.conflict || '失败'} ${j.error || ''}`)
        return sendJson(res, 200, j)
      }
      // 转成浏览器能直接 <img src> 的地址
      const qrName = String(j.qr || '').split(/[\\/]/).pop() || 'login-qr.png'
      log(`扫码登录：二维码已出（${qrName}，端口 ${j.port}）`)
      return sendJson(res, 200, {
        ...j,
        qr_url: `/api/douyin-duty/login/qr.png?v=${Date.now()}`,
      })
    }
    // 二维码图片本身（面板 <img src> 用）
    if (req.method === 'GET' && path === '/api/douyin-duty/login/qr.png') {
      const f = join(stateDir, 'login-qr.png')
      if (!existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('还没有二维码 —— 先点「扫码登录」') }
      try {
        const buf = readFileSync(f)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(String(e?.message ?? e))
      }
    }
    // 「我扫完了」：轮询到登录成功（最多 ~120 秒）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/wait') {
      const body = await readBody(req)
      const sec = Math.max(10, Math.min(Number(body?.seconds) || 120, 300))
      const r = runNodeTool('qr-login.mjs', ['watch', String(sec)], { timeout: (sec + 30) * 1000 })
      // watch 会打多行 JSON，取最后一个完整对象
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      let last = null
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        try { last = JSON.parse(lines[i]) } catch { /* 继续往上找 */ }
      }
      if (!last) {
        return sendJson(res, 200, { ok: false, error: '没等到结果', detail: String(r.stderr || r.stdout || '').slice(-400) })
      }
      if (last.ok) {
        log(`扫码登录：成功，凭证已保存（${last.cookies || '?'} 条 Cookie）`)
        // 登完把有头浏览器收掉，别让它一直占着 profile（不然发私信会起不来）
        try { runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 }) } catch { /* 关不掉也不致命 */ }
        refreshCfg()
      }
      return sendJson(res, 200, last)
    }
    // 关掉登录用的浏览器（用户嫌窗口碍事 / 出码失败要重来时）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/close') {
      const r = runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
      return sendJson(res, 200, pickJson(r.stdout) || { ok: true })
    }

    /* ⭐ 列出会话里的人（昵称 + sec_uid）—— 让用户点选"私信发给谁"，
     *    别再让他手填 sec_uid（新手根本不知道那是什么，也找不到）。只读。 */
    if (req.method === 'POST' && path === '/api/douyin-duty/dm/people') {
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: false, error: '还没登录', hint: '先在上面扫码登录' })
      // 后台无头浏览器可能正在跑；先让它别占着（跟登录窗口同一个 profile）
      const r = runNodeTool('im-send.mjs', ['--list'], { timeout: 180_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, error: '没读到会话列表',
          detail: String(r.stderr || r.stdout || '').slice(-500),
          hint: '确认已登录；如果一直读不到，点「检查环境」看看浏览器那一项',
        })
      }
      if (j.ok) log(`会话列表：${j.count} 个人${j.no_id_count ? `（${j.no_id_count} 个没拿到稳定 id）` : ''}`)
      return sendJson(res, 200, j)
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/login/save') {
      const body = await readBody(req)
      const r = saveCookie(stateDir, String(body?.cookie ?? ''), log)
      log(`Cookie 已保存（${redactCookie(String(body?.cookie ?? '')).slice(0, 40)}…）`)
      return sendJson(res, 200, r)
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/login/clear') {
      return sendJson(res, 200, clearCredential(stateDir))
    }
    // ── 通知测试 ──
    if (req.method === 'POST' && path === '/api/douyin-duty/notify/test') {
      const result = await notifyTest()
      return sendJson(res, 200, result)
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'douyin-duty: /api/douyin-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'douyin-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，采集=推荐流只读接口，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
