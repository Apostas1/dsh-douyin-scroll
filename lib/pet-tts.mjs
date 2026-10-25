/**
 * lib/pet-tts.mjs —— 桌宠「真的把话说出声」：edge-tts 合成 + 口型要用的时间轴
 * ============================================================================
 * 主人 2026-10-25 原话：「你能接入语音输出吗…其中语音输出要跟嘴型对上」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么是 edge-tts 的**命令行**，不是它那套 Python API、也不退化成 SAPI
 *
 *   · SAPI 本机只有 David / Zira 两个英文音色（实测），念中文是噪音。
 *     ⇒ 宁可不出声，也**不许**降级成 SAPI —— 这条写死在这里，见 synthesize 注释。
 *   · edge-tts 7.2.8 起会 403 `WSServerHandshakeError`（实测踩过），7.3.1 正常。
 *     所以 python 探测还要验一下 `edge_tts.__version__`，版本不对就如实报错，
 *     让主人去 `pip install -U edge-tts`，而不是抛个看不懂的 handshake 异常。
 *   · 用 `python -m edge_tts`，不 import 它的 API：它内部是 asyncio + aiohttp，
 *     跨版本签名变过；命令行参数则是稳定契约，而且超时可以直接 kill 子进程。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴 口型怎么和声音对上（这是本模块第二个产出，别只盯着 mp3）
 *
 *   edge-tts 的 `--write-subtitles` 写出来的是 **SRT**（不是 json，文件名随便叫），
 *   里面每条 cue 是「一句话 → 起止毫秒」。默认 boundary=SentenceBoundary，
 *   ⇒ 中文长句只有 ~1 条 cue（实测 289 字也才 51 行）。
 *   所以这里把 srt 解析成 `cues[]` 交给前端：她在念哪一句、这句从几秒到几秒。
 *   前端再叠一条音频振幅包络（AnalyserNode）驱动 mouthOpen —— 声音响就张嘴，
 *   这是**天生对齐**，不需要 viseme/音素表（中文音素表根本拿不到）。
 *
 * ⚠️ 字幕不是必须的：拿不到 cues 就返回空数组，声音照放，只是嘴型退化成包络。
 *    **不许**因为少个 srt 就让整句话没声音。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认音色：年轻活泼的女声（Lively）。主人挑的就是这个。 */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/**
 * 一句最长多少字。
 * 300 是接口层和这里**同一个数**：接口截断到 300，这里再兜一层 ——
 * 因为 synthesize 也可能被别的地方直接调用，不该指望调用方守规矩。
 * 实测 289 字 = 4.3 秒合成、370KB，超过这个量级前端听着也累。
 */
export const MAX_TEXT = 300

/** 短句阈值：低于这个字节数的 mp3 基本是"空文件"或半截包，当失败处理 */
const MIN_MP3_BYTES = 500

/** edge-tts 最低可用版本（7.2.8 会 403 WSServerHandshakeError，实测） */
const MIN_EDGE_TTS = '7.3.0'

/**
 * `python -m edge_tts` 的探测脚本。
 *
 * 为什么一次问三件事：起一个 python 要 ~0.9 秒（实测），三次探测就是 2.7 秒，
 * 而我们只是想确认"这个解释器能用"。一次问完，探测成本压到一档。
 * 输出用 `|` 分隔，避免 JSON 解析在异常输出上翻车。
 */
const PROBE_CODE = [
  'import sys',
  'try:',
  '    import edge_tts',
  'except Exception:',
  '    print("NOEDGE|" + sys.executable)',
  '    raise SystemExit(0)',
  'print("OK|" + sys.executable + "|" + str(getattr(edge_tts, "__version__", "")))',
].join('\n')

/* ────────────────────────────── 文本清洗 ────────────────────────────── */

/**
 * 括号包起来、里面**一个汉字/字母/数字都没有**的东西 ⇒ 整块删掉。
 * `(๑•̀ㅂ•́)و✧`、`(>_<)`、`(｡･ω･｡)`、`(´▽｀)` 都靠这条清；
 * 而 `（三条）`、`（我吃过饭了）` 里有汉字，留着。
 *
 * ⚠️ 光用正则匹配括号不够 —— 一定要**看括号里有什么**再决定删不删。
 *    第一版我写的是"只要匹配到括号就删"，结果 `（很好玩）` 这种正常的中文注
 *    也被吃了（实测输出少半句）。所以这里用 replace 回调做判断。
 */
const ANY_PARENS = /[([{（【「『][^)\]}）】」』\n]{0,24}[)\]}）】」』]/gu
const HAS_SPEAKABLE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9]/

/**
 * ⭐ **白名单**：清洗最后一步只留"TTS 念得出来"的字符，别的一律变空格。
 *
 * 🔴 为什么用白名单而不是黑名单（这一步返工过，别再改回去）：
 *   一开始我列了一堆要删的符号区（`\u3000-\u303F`、`\uFF00-\uFFEF`…），
 *   结果那两个区里**正好装着中文逗号句号问号感叹号**（`，。？！：；`），
 *   实测输出变成「重点 今天刷到一条 好玩的视频」—— 标点全没了，
 *   TTS 把整段念成一口气。黑名单的坑是：符号区永远是"混装"的，
 *   你想删颜文字就一定会误伤中文标点。
 *   ⇒ 反过来做：只列**要留**的字符，剩下的一律当噪音。
 *
 * 留下的东西：
 *   · 汉字（基本区 + 扩展 A + 兼容区）
 *   · 拉丁字母 / 数字：`git push`、`3 条`、`API` 这些念出来有意义
 *   · 中文标点：TTS 靠它们断句，删了反而更假
 */
const KEEP_RE = /[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9，。！？、；：""''（）《》〈〉「」『』【】…—～·\s]/gu

/**
 * 把 markdown / 代码块 / 链接 / 颜文字 / emoji 从一句话里清掉，只留能念的正文。
 *
 * 🔴 为什么这件事必须做（不是"顺手美化"）：
 *   DSH 的回复天生带 markdown（`**重点**`、`### 标题`、`- 列表`、代码块），
 *   还常带颜文字。直接喂 edge-tts，会念出"星号星号 重点 星号星号"、
 *   "井号 井号 井号"，颜文字则变成一串含混的音节 —— **全是噪音**，
 *   主人听到的是一台机器在念乱码，不是小鱼在说话。
 *
 * @param {unknown} text
 * @param {{ maxLen?: number }} [opts]
 * @returns {string} 可以直接喂 TTS 的中文（可能为空串：全是符号的句子清完就是空）
 */
export function cleanForSpeech(text, { maxLen = MAX_TEXT } = {}) {
  let s = String(text ?? '')
  if (!s) return ''

  // ① 代码块整块丢（```...``` 和 ~~~...~~~）—— 念代码没有意义，而且里面全是符号
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ')
  // 行内代码 `x`：留内容不留反引号（`git push` 这种念出来还有用）
  s = s.replace(/`([^`\n]{0,80})`/g, '$1')

  // ② 图片 ![alt](url) 整块丢；链接 [文字](url) 只留文字（念 URL 是纯噪音）
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]{1,80})\]\([^)]*\)/g, '$1')
  // 剩下的裸 URL / 邮箱：念出来是一串字母，直接删
  s = s.replace(/https?:\/\/\S+/gi, ' ')
  s = s.replace(/\bwww\.\S+/gi, ' ')
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' ')

  // ③ markdown 结构符：标题井号、引用 >、列表 -/*/+、分隔线 ---、表格竖线
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '')                 // ### 标题
  s = s.replace(/^\s{0,3}>\s?/gm, '')                      // > 引用
  s = s.replace(/^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+/gm, '')  // - 列表 / 1. 编号
  s = s.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '')         // --- / *** 分隔线
  s = s.replace(/^\s*\|.*\|\s*$/gm, '')                    // | 表格行 | 整行丢
  s = s.replace(/^\s*:?-{2,}:?\s*$/gm, '')                 // 表格对齐行 |---|---|

  // ④ 强调符：**粗** *斜* __粗__ _斜_ ~~删~~ —— 只去符号，字留下
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2')
  s = s.replace(/(\*|_)([^*_\n]+?)\1/g, '$2')
  s = s.replace(/~~(.+?)~~/g, '$1')

  // ⑤ 颜文字：括号里**没有**可念的字符 ⇒ 整块删掉（`(>_<)` `(๑•̀ㅂ•́)و✧` 的括号部分）。
  //    括号里真有汉字的（`（很好玩）`）留着 —— 那是主人想听的内容。
  s = s.replace(ANY_PARENS, (m) => (HAS_SPEAKABLE.test(m) ? m : ' '))

  // ⑥ ⭐ 白名单兜底：不认识的字符一律变空格。
  //    这一步之后不可能再有 emoji / 颜文字 / markdown 符号 —— 宁可漏掉一句台词，
  //    也不能让主人听到一串"呜呜啊啊"的噪音。
  s = s.replace(KEEP_RE, ' ')

  // ⑦ 收尾：标点归一 + 空白压平
  s = s.replace(/[～〜]/g, '，')
  s = s.replace(/…+/g, '。')
  s = s.replace(/[“”]/g, '')     // 引号念不出声，反而会让 TTS 停顿
  s = s.replace(/['']/g, '')
  s = s.replace(/[ \t\u00A0]+/g, ' ')
  s = s.replace(/\s*\n\s*/g, '。')     // 换行 = 句号，别让 TTS 把两句话念成一口气
  s = s.replace(/[，。、；：]{2,}/g, (m) => (m.includes('。') ? '。' : '，'))
  s = s.replace(/([，、；：])(?=[。！？])/g, '')   // `，。` → `。`
  s = s.replace(/^[，。、；：\s]+/, '')
  s = s.replace(/[，、；：\s]+$/, '')
  s = s.trim()

  // ⑧ 截断：在标点处断，别把一句话拦腰砍断（不然末尾半句听起来像断线）
  if (s.length > maxLen) {
    const head = s.slice(0, maxLen)
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('，'), head.lastIndexOf('！'), head.lastIndexOf('？'))
    s = cut > maxLen * 0.6 ? head.slice(0, cut + 1) : head
  }
  return s.trim()
}

/* ────────────────────────────── python 探测 ────────────────────────────── */

/** 版本比较：只比前三段数字，`7.3.1` vs `7.3.0` */
function verAtLeast(have, need) {
  const a = String(have || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const b = String(need || '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * 跑一条命令拿输出（内部用，永不抛）。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runOnce(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      // windowsHide：桌宠在主人屏幕上，弹黑框会吓人
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) })
    }
    let out = '', err = '', done = false
    const finish = (r) => { if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* 已死 */ } resolve(r) } }
    const timer = setTimeout(() => finish({ code: -2, stdout: out, stderr: 'timeout' }), timeoutMs)
    child.stdout?.on('data', (b) => { out += String(b); if (out.length > 64_000) out = out.slice(-64_000) })
    child.stderr?.on('data', (b) => { err += String(b); if (err.length > 64_000) err = err.slice(-64_000) })
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, stdout: out, stderr: String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ code: typeof code === 'number' ? code : -1, stdout: out, stderr: err }) })
  })
}

/**
 * 依次探测可用的 python 解释器，返回第一个**能 `import edge_tts`** 的。
 *
 * 候选顺序（先到先得）：
 *   ① 配置里的 pythonPath（主人自己指的那个，最该尊重）
 *   ② 插件 venv 里的 python（可能有 edge-tts，不检查依赖就白搭 —— 所以下面脚本会 import 一次）
 *   ③ `python`
 *   ④ `py -3`（Windows 启动器；`py` 本身不是解释器，要带 `-3`）
 *   ⑤ `python3`
 *
 * 🔴 结果**要缓存**（默认缓存一整个进程生命周期）：
 *    探测一次 ≈ 0.9 秒（起解释器 + import edge_tts），而这个函数会被每条语音调用一次。
 *    不缓存的话，桌宠每说一句话先花 1 秒找解释器。
 *    但缓存要能被"失败"打断：探测失败也缓存，不然每句话都白等 5 次超时。
 *
 * @param {string[]} [candidates] 覆盖候选列表（测试用）
 * @param {{ timeoutMs?: number, cache?: Map }} [opts]
 * @returns {Promise<{ok:boolean, command?:string, args?:string[], version?:string,
 *                    executable?:string, reason?:string, tried:Array}>}
 */
const PY_CACHE = new Map()

export async function resolvePython(candidates, { timeoutMs = 8000, cache = PY_CACHE, key = 'default' } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c === 'string' ? c.trim() : c))
    .filter(Boolean)

  const ck = key + '|' + JSON.stringify(list)
  const hit = cache.get(ck)
  if (hit) return hit

  const tried = []
  for (const spec of list) {
    // 一条候选可以带参数（`py -3`），拆开探测；字符串里没有空格就是纯路径
    const [cmd, ...fixedArgs] = Array.isArray(spec) ? spec : splitCmd(spec)
    if (!cmd) continue

    // ① 先 `--version`：Windows 上 `python` 可能是 Microsoft Store 的转发器，
    //    没装会直接 exit 9009 并弹商店 —— 证实用 `--version` 就能筛掉（实测过）
    const v = await runOnce(cmd, [...fixedArgs, '--version'], timeoutMs)
    const vOut = (v.stdout || '') + (v.stderr || '')
    if (v.code !== 0) {
      tried.push({ spec: String(spec), ok: false, why: `--version exit ${v.code}${vOut.trim() ? '：' + vOut.trim().slice(0, 80) : ''}` })
      continue
    }
    // ② 再确认真的有 edge_tts（且版本够）—— 只有 python 没有 edge-tts 等于没戏
    const p = await runOnce(cmd, [...fixedArgs, '-c', PROBE_CODE], timeoutMs)
    const line = String(p.stdout || '').trim().split(/\r?\n/).pop() || ''
    const parts = line.split('|')
    if (parts[0] !== 'OK') {
      tried.push({ spec: String(spec), ok: false, why: '没有 edge_tts 模块（pip install edge-tts）' })
      continue
    }
    const ver = parts[2] || ''
    if (!verAtLeast(ver, MIN_EDGE_TTS)) {
      // 🔴 这条必须挡：7.2.8 会 403 WSServerHandshakeError（实测踩过），
      //    报"版本太低 + 怎么升"比抛个握手异常有用得多。
      tried.push({ spec: String(spec), ok: false, why: `edge-tts ${ver || '?'} 太旧（<${MIN_EDGE_TTS}，会 403；pip install -U edge-tts）` })
      continue
    }
    const found = {
      ok: true, command: cmd, args: fixedArgs, version: ver,
      executable: parts[1] || cmd, pythonVersion: vOut.trim().split(/\r?\n/)[0] || '',
      tried,
    }
    cache.set(ck, found)
    return found
  }

  const miss = {
    ok: false,
    reason: tried.length
      ? '没有可用的 python + edge-tts：' + tried.map((t) => `${t.spec}（${t.why}）`).join('；')
      : '没给任何候选',
    tried,
  }
  cache.set(ck, miss)
  return miss
}

/** `py -3` → ['py','-3']；带引号的路径也能处理（`"C:\Program Files\py.exe" -3`） */
function splitCmd(s) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(String(s)))) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

/** 清掉探测缓存（主人换了 pythonPath / 刚装完 edge-tts 时用） */
export function clearPythonCache(cache = PY_CACHE) {
  cache.clear()
}

/* ────────────────────────────── 合成 ────────────────────────────── */

/**
 * 解析 edge-tts 写出来的 SRT，得到口型要用的时间轴。
 *
 * 为什么是手写解析而不是找个库：格式极简单（序号 / `00:00:00,100 --> 00:00:04,437` / 文字），
 * 而 SRT 对面就那一种写法，多引一个依赖不值。
 *
 * @returns {Array<{start:number,end:number,text:string}>} 毫秒 + 文本；解析不出就 []
 */
export function parseSrt(srt) {
  const cues = []
  const text = String(srt || '')
  // ⚠️ 用 `\r?\n` 而不是 `\n`：Windows 上 edge-tts 可能写 CRLF（实测是 LF，但不能赌）
  const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\r?\n([\s\S]*?)(?=\r?\n\r?\n\r?\n|\r?\n\r?\n\d|\r?\n?$)/g
  let m
  while ((m = re.exec(text))) {
    const g = (i) => Number(m[i]) || 0
    const start = ((g(1) * 60 + g(2)) * 60 + g(3)) * 1000 + g(4)
    const end = ((g(5) * 60 + g(6)) * 60 + g(7)) * 1000 + g(8)
    const cueText = String(m[9] || '').trim()
    if (!cueText || end <= start) continue
    cues.push({ start, end, text: cueText })
  }
  return cues
}

/**
 * 合成一句话成 mp3。**永不抛**，失败一律 `{ok:false, error}`。
 *
 * @param {object} o
 * @param {string} o.python            解释器命令（resolvePython 给的 command）
 * @param {string[]} [o.pythonArgs]    resolvePython 给的固定参数（`py -3` 的 `-3`）
 * @param {string} o.text              已经清洗过的正文
 * @param {string} [o.voice]
 * @param {string} o.outDir            临时目录（**不许**写插件包目录）
 * @param {number} [o.timeoutMs=15000] 超时就 kill 掉子进程并返回 ok:false
 * @param {string} [o.name]            文件名种子（缓存键），不给就按 text+voice 算
 * @param {Function} [o.spawn]         测试注入口（默认 node:child_process 的 spawn）
 * @returns {Promise<{ok:boolean, mp3Path?:string, bytes?:number, ms?:number,
 *                    voice?:string, cues?:Array, text?:string, error?:string, cueError?:string}>}
 */
export async function synthesize(o = {}) {
  const text = String(o.text ?? '')
  const voice = pickVoice(o.voice)
  const outDir = String(o.outDir || '')
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 15_000
  const spawnFn = typeof o.spawn === 'function' ? o.spawn : spawn
  const t0 = Date.now()

  if (!text.trim()) return { ok: false, error: '正文是空的（清洗完一个字都没剩）', voice }
  if (!outDir) return { ok: false, error: '没给 outDir —— 不许往插件包里写', voice }
  if (!o.python) return { ok: false, error: '没有可用的 python（先 pip install edge-tts）', voice }

  // 🟢 不降级声明：这里**绝不会**在 edge-tts 失败后改调 SAPI。
  //    本机 SAPI 只有英文音色，念中文就是噪音 —— 宁可没声音，也不给主人听那个。

  const stem = makeStem(o.name || `${text}\u0000${voice}`)
  const mp3Path = join(outDir, stem + '.mp3')
  const srtPath = join(outDir, stem + '.srt')

  try { mkdirSync(outDir, { recursive: true }) } catch (e) {
    return { ok: false, error: '建临时目录失败：' + String(e?.message ?? e), voice }
  }

  const argv = [
    ...(Array.isArray(o.pythonArgs) ? o.pythonArgs : []),
    '-m', 'edge_tts',
    '--voice', voice,
    // ⚠️ 用 `-f <临时文件>` 而不是 `--text`：正文里可能有换行/引号/以 `-` 开头的字符，
    //    走命令行参数在各种 shell/编码下都可能翻车；写文件最稳（实测两种都通，选稳的）。
    '-f', writeTextFile(outDir, stem, text),
    '--write-media', mp3Path,
    '--write-subtitles', srtPath,
    '--no-progress',   // 进度条画到 stderr 会让日志变噪音，而且我们对它没用
  ]

  const r = await new Promise((resolve) => {
    let child
    try {
      child = spawnFn(o.python, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: '起不来：' + String(e?.message ?? e) })
    }
    let out = '', err = '', settled = false
    let timer = null
    const finish = (v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    /**
     * 🔴 超时必须 **kill 子进程**，不能只 resolve 掉就算：
     *    留着的 python 会继续跑完、继续写文件，下一次同名的合成就会写到同一路径上
     *    （半截文件 ⇒ 前端拿到 0 字节 mp3 却以为成功）。实测过这个竞态。
     *    Windows 上 SIGKILL 不存在，用默认的 taskkill 语义（kill() 对 node 子进程就是强杀）。
     */
    timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退了 */ }
      finish({ code: -2, stdout: out, stderr: 'timeout' })
    }, timeoutMs)
    // ⚠️ 这里**不能** unref：断了 unref 的话，事件循环上除了这个定时器什么都没有时
    //    Node 会直接退出，await 那个 promise 永远等不到 ⇒ 实测报
    //    "Detected unsettled top-level await"（自测脚本里第一次就这么挂住的）。

    child.stdout?.on('data', (b) => { out += String(b); if (out.length > 4000) out = out.slice(-4000) })
    child.stderr?.on('data', (b) => { err += String(b); if (err.length > 8000) err = err.slice(-8000) })
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: 'spawn 失败：' + String(e?.message ?? e) }))
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : -1, stdout: out, stderr: err }))
  })

  const ms = Date.now() - t0
  if (r.code === -2) {
    try { rmSync(mp3Path, { force: true }) } catch { /* 清不掉也无所谓 */ }
    return { ok: false, error: `合成超时（>${timeoutMs}ms，已 kill）`, voice, ms }
  }
  if (r.code !== 0) {
    // edge-tts 的报错在 traceback 最后一行最有信息量（实测：403 那行就在最末尾）
    const tail = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / ')
    return { ok: false, error: `edge-tts 退出码 ${r.code}${tail ? '：' + tail.slice(0, 240) : ''}`, voice, ms }
  }

  // 文件真存在、真有内容才算成功 —— 空文本会 exit 0 但写出 0 字节（实测过）
  let bytes = 0
  try { bytes = statSync(mp3Path).size } catch { bytes = 0 }
  if (bytes < MIN_MP3_BYTES) {
    return { ok: false, error: `合成的 mp3 只有 ${bytes} 字节（<${MIN_MP3_BYTES}），当失败`, voice, ms }
  }

  // 字幕：拿不到不算失败（声音是主产出，口型退化成包络也能用）
  let cues = []
  let cueError
  try {
    cues = parseSrt(readFileSync(srtPath, 'utf8'))
    if (!cues.length) cueError = 'srt 里没有可解析的 cue'
  } catch (e) {
    cueError = String(e?.message ?? e)
  }

  return { ok: true, mp3Path, bytes, ms, voice, cues, text }
}

/** 写正文临时文件（返回路径）。用不带 BOM 的 UTF-8：带 BOM 会念出怪音。 */
function writeTextFile(dir, stem, text) {
  const p = join(dir, stem + '.txt')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 上面已经试过一次了 */ }
  // writeFileSync 写字符串就是 UTF-8 无 BOM；显式转 Buffer 是为了不吃 Node 默认编码的变动
  writeFileSync(p, Buffer.from(String(text), 'utf8'))
  return p
}

/** 文件名种子：text+voice 的 sha1 前 16 位（够长，又不至于让路径长到 Windows 受不了） */
function makeStem(s) {
  return createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16)
}

/* ────────────────────────────── 音色 ────────────────────────────── */

/**
 * 挑音色。给了合口味的就用，认不出就退回默认 —— **不静默换成别的语言**。
 *
 * 为什么只认 `zh-CN-` 开头的：主人的要求是"说中文"。传进来一个 `en-US-Aria`
 * 就照用的话，她会突然用英文念中文句子（实测 SAPI 那条路就是这么完的）。
 * 所以非中文音色一律**替换**成默认中文音色，并把请求的原值留在返回值里方便排查。
 *
 * @param {string} [want]
 * @returns {string}
 */
export function pickVoice(want) {
  const v = String(want ?? '').trim()
  if (!v) return DEFAULT_VOICE
  // edge-tts 的 ShortName 形状：`zh-CN-XiaoyiNeural`（区分大小写，但这里放宽一点）
  if (/^zh-CN-[A-Za-z]+Neural$/i.test(v)) return normalizeVoiceCase(v)
  return DEFAULT_VOICE
}

/** `zh-cn-xiaoyineural` → `zh-CN-XiaoyiNeural`（edge-tts 认大小写，别送错） */
function normalizeVoiceCase(v) {
  const m = /^(zh-cn)-([a-z]+)(neural)$/i.exec(v)
  if (!m) return v
  const canon = m[2].toLowerCase()
  const name = canon.charAt(0).toUpperCase() + canon.slice(1)
  return `zh-CN-${name}Neural`
}

/* ────────────────────────────── LRU 缓存 ────────────────────────────── */

/**
 * 按 text+voice 做 LRU：同一句话第二次不再合成，直接把上一次的 mp3 路径给回去。
 *
 * 为什么需要：她的话很多是**重复的**（"嗯嗯""好哦～""鱼在想…"，
 * 还有定时播报里那几句固定的）。每句都重新走一遍云端合成 = 每句 2~4 秒 + 一次网络，
 * 桌宠那边就会"说完话才出声"，嘴型也对不上。
 *
 * 设计取舍：
 *   · 只缓**路径**不缓字节 —— 文件在磁盘上，HTTP 那头直接 createReadStream 发出去，
 *     进程内存里不留几百 KB 的 buffer（长会话会一直涨）。
 *   · `max` 是**文件数**上限，超了删最久没用的那个 mp3（连 mp3 一起删，不留垃圾）。
 *   · 命中时可选 `touch: true` 做一次 mtime 刷新 —— 这里不用，因为我们的淘汰顺序
 *     完全由 Map 的插入顺序决定（Map 重设 key 会挪到末尾，这就是"用过"）。
 *
 * @param {{max?:number, onEvict?:(path:string)=>void}} [o]
 */
export function makeTtsCache({ max = 48, onEvict } = {}) {
  /** @type {Map<string, {mp3Path:string, bytes:number, cues:Array, text:string, voice:string, at:number}>} */
  const map = new Map()
  let hits = 0, misses = 0

  const keyOf = (text, voice) => pickVoice(voice) + '\u0000' + String(text ?? '').trim()

  /**
   * 删一条缓存对应的**全部**磁盘文件：`.mp3` + `.srt` + `.txt`。
   *
   * 🔴 为什么三样一起删（第一版只删了 mp3，返工过）：
   *    合成时同一 stem 会生成三个文件（合成脚本写进来一个正文临时文件，
   *    edge-tts 再写 mp3 和 srt）。只删 mp3 的话，淘汰一条就漏两个文件，
   *    桌宠说上一天，`tts-cache/` 里堆的是成倍的 srt/txt 垃圾。
   */
  const purge = (mp3Path) => {
    if (!mp3Path) return
    for (const ext of ['.mp3', '.srt', '.txt']) {
      const p = mp3Path.replace(/\.mp3$/i, ext)
      try { rmSync(p, { force: true }) } catch { /* 删不掉就留着，下次覆盖 */ }
    }
  }

  const evictOne = () => {
    const first = map.keys().next()
    if (first.done) return null
    const k = first.value
    const v = map.get(k)
    map.delete(k)
    purge(v?.mp3Path)
    try { onEvict?.(v?.mp3Path) } catch { /* 回调不许影响主流程 */ }
    return k
  }

  return {
    /** 查缓存（不会触发淘汰）；命中会把这条挪到"最近用过" */
    get(text, voice) {
      const k = keyOf(text, voice)
      const v = map.get(k)
      if (!v) { misses++; return null }
      // 文件被人手动删了 / 清理工具扫了 ⇒ 当没缓存，别把死路径交给前端
      try { if (!existsSync(v.mp3Path) || statSync(v.mp3Path).size < MIN_MP3_BYTES) throw new Error('gone') } catch {
        map.delete(k)
        misses++
        return null
      }
      map.delete(k)
      map.set(k, v)     // 重新插入 = 挪到末尾 = "最近用过"
      hits++
      return v
    },
    /** 记一条（超上限就淘汰最久没用的） */
    set(text, voice, value) {
      const k = keyOf(text, voice)
      map.delete(k)
      map.set(k, { ...value, voice: pickVoice(voice), at: Date.now() })
      while (map.size > Math.max(1, Number(max) || 1)) evictOne()
      return value
    },
    /** 删一条（合成失败时要清掉半截缓存） */
    drop(text, voice) {
      const k = keyOf(text, voice)
      const v = map.get(k)
      map.delete(k)
      purge(v?.mp3Path)
    },
    clear() {
      for (const v of map.values()) purge(v?.mp3Path)
      map.clear()
    },
    /** 只读统计（面板/自检用） */
    stats: () => ({ size: map.size, max, hits, misses }),
    keys: () => [...map.keys()],
  }
}

/**
 * 清掉临时目录里**不属于任何缓存**的残留文件。
 *
 * 为什么要这一步：进程被杀 / 合成超时 / 半截文件，都会在 tts-cache/ 里留垃圾。
 * 每次启动扫一遍比"相信没人漏"实在。只删超过 `olderThanMs` 的，避免删掉
 * 正在被另一个进程（比如刚重启前的自己）写的那份。
 */
export function sweepTtsDir(dir, { olderThanMs = 6 * 3600_000, keep = new Set() } = {}) {
  let removed = 0
  try {
    const now = Date.now()
    for (const n of readdirSync(dir)) {
      if (!/\.(mp3|srt|txt)$/i.test(n)) continue
      const p = join(dir, n)
      if (keep.has(p)) continue
      try {
        if (now - statSync(p).mtimeMs < olderThanMs) continue
        rmSync(p, { force: true })
        removed++
      } catch { /* 单个文件删不掉不影响其它 */ }
    }
  } catch { /* 目录不存在 = 没垃圾 */ }
  return { removed }
}

/** edge-tts 的 MP3 帧头（`ff f3` / `ff fb` 这类）—— 给测试和排障用 */
export function looksLikeMp3(buf) {
  if (!buf || buf.length < 3) return false
  const b = buf
  // MPEG 帧同步：11 个 1 位
  if (b[0] !== 0xFF || (b[1] & 0xE0) !== 0xE0) return false
  return true
}
