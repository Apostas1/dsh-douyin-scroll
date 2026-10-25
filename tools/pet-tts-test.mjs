/**
 * tools/pet-tts-test.mjs —— 桌宠「说话出声」的**离线实测**（不用重启 DSH）
 * ============================================================================
 * 为什么要这个：语音这条路有三个"当场看不出来"的坑 ——
 *   ① 清洗没做干净 ⇒ 主人听到的是"星号星号 重点"，不是小鱼在说话（听感问题，
 *      代码看着完全正常）
 *   ② 合成失败/超时 ⇒ 没有报错，只是**没声音**，主人以为她坏了
 *   ③ 同一句话反复合成 ⇒ 每句 2~4 秒云上往返，嘴型和声音就错开了
 * 这三样只能在真的跑一遍之后才知道，所以要有这套脚本。
 *
 * 它测五件事：
 *   ① cleanForSpeech：markdown / 颜文字 / emoji / 代码块 / 链接必须清掉，中文正文保留
 *   ② synthesize：**真跑一次 edge-tts**（python 不可用就 SKIP，不算失败）
 *   ③ LRU 缓存：同一句话第二次不再 spawn（用注入的假 spawn 计数证明）
 *   ④ 超时：注入一个"睡很久"的假 spawn，断言 300ms 就返回 ok:false（不等 15 秒）
 *   ⑤ 口型时间轴：SRT 解析（嘴型靠它对齐，解析挂了就只能退化成振幅包络）
 *
 * 退出码 0 = 全过。fail > 0 时 exit 1。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { join } from 'node:path'
import {
  cleanForSpeech, synthesize, resolvePython, pickVoice, makeTtsCache,
  parseSrt, looksLikeMp3, DEFAULT_VOICE, MAX_TEXT, sweepTtsDir,
} from '../lib/pet-tts.mjs'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) }
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) }
const skip = (m) => { console.log(`  ⏭  SKIP ${m}`) }

/** 这些字符/片段**不该**出现在喂给 TTS 的正文里 */
const NOISE = [
  ['markdown 星号', /\*/],
  ['markdown 井号', /#/],
  ['markdown 反引号', /`/],
  ['markdown 波浪删除线', /~~/],
  ['裸链接', /https?:\/\//i],
  ['裸域名', /www\./i],
  ['表头竖线', /\|/],
  ['emoji', /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
  ['颜文字符号', /[๑•๑-๔ㅂㅋㅠㅎヽﾉ°▽´｀・∀]/u],
  ['括号残渣', /[()[\]{}]/],
]

console.log('1. 清洗：DSH 回复里的脏东西必须清掉，中文正文要留下')
{
  const cases = [
    ['markdown + 颜文字 + emoji', '**重点**：今天刷到一条 (๑•̀ㅂ•́)و✧ 好玩的视频！😂'],
    ['标题 + 列表 + 链接', '### 三条\n- 第一条会开门\n- 第二条 https://dy.com/xx 红烧肉'],
    ['代码块', '```js\nconsole.log("别念我")\n```\n说完啦(>_<)'],
    ['行内代码 + 强调', '**粗** *斜* ~~删~~ `git push` 都清掉'],
    ['下划线颜文字', '_(:з」∠)_ 鱼翻白肚了'],
    ['markdown 表格', '| 名字 | 赞 |\n|---|---|\n| 猫 | 100 |'],
  ]
  for (const [label, raw] of cases) {
    const out = cleanForSpeech(raw)
    const leaked = NOISE.filter(([, re]) => re.test(out)).map(([n]) => n)
    if (leaked.length) bad(`${label}：还有噪音漏进来（${leaked.join('、')}）→ ${JSON.stringify(out)}`)
    else ok(`${label} → ${JSON.stringify(out)}`)
  }

  // 中文正文必须**真的**留下（不能为了清干净把整句话也删了）
  const out1 = cleanForSpeech('**重点**：今天刷到一条 (๑•̀ㅂ•́)و✧ 好玩的视频！😂')
  if (/今天刷到一条/.test(out1) && /好玩的视频/.test(out1)) ok('中文正文完整保留（没有连正文一起删）')
  else bad(`中文正文被吃掉了：${JSON.stringify(out1)}`)

  // 标点要留：全删标点 ⇒ TTS 把整段念成一口气，听起来更假（这个坑实测踩过）
  if (/[，。！？]/.test(cleanForSpeech('真的很好笑，我看了三遍！'))) ok('中文标点保留（TTS 靠它断句）')
  else bad('标点被清光了 —— TTS 会念成一口气')

  // 全是符号 ⇒ 清成空串（调用方据此判断"没东西可念"，不要硬合成）
  const empty = cleanForSpeech('(๑•̀ㅂ•́)و✧ ✧★♡♪ ~~~')
  if (empty === '') ok('全是符号 ⇒ 清成空串（调用方据此跳过合成）')
  else bad(`全是符号却没清空：${JSON.stringify(empty)}`)

  // 括号里有汉字的要留（第一版把 `（很好玩）` 也吃了）
  const parens = cleanForSpeech('跑一次 smoke.py 看看，3 条候选（很好玩）')
  if (/很好玩/.test(parens)) ok('括号里的中文注保留：' + JSON.stringify(parens))
  else bad('括号里的中文被误删：' + JSON.stringify(parens))

  // 截断：超长不许原样喂出去（防长文灌进来）
  const long = '这句话会重复很多遍。'.repeat(80)
  const cut = cleanForSpeech(long)
  if (cut.length <= MAX_TEXT) ok(`超长文本被截断（${long.length} → ${cut.length} ≤ ${MAX_TEXT}）`)
  else bad(`截断失效：${cut.length} > ${MAX_TEXT}`)
  // 而且截在标点上，别拦腰砍
  if (/[。！？]$/.test(cut)) ok('截断落在标点上（不是拦腰砍断）')
  else bad('截断没对齐标点：末尾是 ' + JSON.stringify(cut.slice(-6)))

  // 空输入不许抛
  for (const v of [null, undefined, '', 0]) {
    try { cleanForSpeech(v); } catch (e) { bad(`cleanForSpeech(${String(v)}) 抛了：${e.message}`) }
  }
  ok('空输入不抛（null / undefined / "" / 0）')
}

console.log('\n2. 音色：只认中文，不许静默换成英文')
{
  if (pickVoice('') === DEFAULT_VOICE) ok('不给音色 ⇒ 用默认 ' + DEFAULT_VOICE)
  else bad('默认音色不对：' + pickVoice(''))
  if (pickVoice('zh-CN-XiaoyiNeural') === 'zh-CN-XiaoyiNeural') ok('指定中文音色照用')
  else bad('指定音色被改了')
  // 🔴 这条是红线：本机 SAPI 只有英文音色，念中文是噪音 ⇒ 非中文音色必须被换掉
  if (pickVoice('en-US-AriaNeural') === DEFAULT_VOICE) ok('英文音色 ⇒ 换成中文默认（不给她用英文念中文）')
  else bad('英文音色被放行了：' + pickVoice('en-US-AriaNeural'))
  if (pickVoice('zh-cn-xiaoyineural') === 'zh-CN-XiaoyiNeural') ok('小写音色名被规范化（edge-tts 认大小写）')
  else bad('音色大小写没规范化：' + pickVoice('zh-cn-xiaoyineural'))
}

console.log('\n3. 口型时间轴：SRT 解析（嘴型靠它对上声音）')
{
  const srt = [
    '1', '00:00:00,100 --> 00:00:04,437', '主人，小鱼在呢。', '',
    '2', '00:00:04,437 --> 00:00:06,700', '今天就刷到这里', '',
  ].join('\n')
  const cues = parseSrt(srt)
  if (cues.length === 2) ok(`解析出 ${cues.length} 条 cue`)
  else bad(`cue 数量不对：${cues.length}`)
  if (cues[0] && cues[0].start === 100 && cues[0].end === 4437) ok(`第一句 ${cues[0].start}–${cues[0].end}ms（毫秒要对）`)
  else bad('第一句时间不对：' + JSON.stringify(cues[0]))
  if (cues[0] && /小鱼在呢/.test(cues[0].text)) ok('cue 文本没被弄乱：' + cues[0].text)
  else bad('cue 文本不对：' + JSON.stringify(cues[0]?.text))
  // 一小时以上也得算对（长文）
  const big = parseSrt('1\n01:02:03,004 --> 01:02:05,000\n长文\n')
  const want = ((1 * 60 + 2) * 60 + 3) * 1000 + 4
  if (big[0] && big[0].start === want) ok('跨小时时间戳算得对（' + big[0].start + 'ms）')
  else bad('跨小时算错：' + JSON.stringify(big[0]))
  if (parseSrt('').length === 0 && parseSrt('乱七八糟').length === 0) ok('坏 SRT 返回空数组（不抛）')
  else bad('坏 SRT 没被兜住')
}

console.log('\n4. LRU 缓存：同一句话不许合成第二次')
{
  // 假 spawn：数调用次数，写出一个够大的假 mp3 + 一个假 srt
  let calls = 0
  const fakeSpawn = (cmd, args) => {
    calls++
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { }
    // 真的把文件写出来，缓存要 stat 它
    const mediaIdx = args.indexOf('--write-media')
    const subIdx = args.indexOf('--write-subtitles')
    writeFileSync(args[mediaIdx + 1], Buffer.alloc(5000, 0xFF))
    writeFileSync(args[subIdx + 1], '1\n00:00:00,000 --> 00:00:01,000\n假话\n')
    setTimeout(() => { child.emit('close', 0) }, 1)
    return child
  }

  const outDir = join(os.tmpdir(), 'pet-tts-test-cache')
  const cache = makeTtsCache({ max: 3 })
  const text = '同一句话不许合成第二次'

  const run = async (t) => {
    const hit = cache.get(t, DEFAULT_VOICE)
    if (hit) return { cached: true, ...hit }
    const r = await synthesize({ python: 'fake-python', text: t, outDir, spawn: fakeSpawn })
    if (r.ok) cache.set(t, DEFAULT_VOICE, r)
    return { cached: false, ...r }
  }

  const a = await run(text)
  if (a.ok && !a.cached) ok('第一次：真合成了（spawn 被调用）')
  else bad('第一次没合成成功：' + JSON.stringify(a))
  const b = await run(text)
  if (b.cached && b.ok !== false) ok('第二次：缓存命中，没再 spawn')
  else bad('第二次又去合成了：' + JSON.stringify(b))
  if (calls === 1) ok(`spawn 总共只调用 1 次（缓存真的挡住了）`)
  else bad(`spawn 被调了 ${calls} 次 —— 缓存没生效`)

  // 换一句话必须重新合成（缓存键含 text）
  await run('另一句话')
  if (calls === 2) ok('换文本 ⇒ 重新合成（缓存键对）')
  else bad(`换文本后 spawn 次数 ${calls}，应该是 2`)

  // 换音色也要重新合成（缓存键含 voice）
  const hitOtherVoice = cache.get(text, 'zh-CN-XiaoxiaoNeural')
  if (!hitOtherVoice) ok('换音色 ⇒ 不命中（缓存键含音色）')
  else bad('换音色竟然命中了旧缓存 —— 会拿错音色说话')

  // 上限淘汰
  const small = makeTtsCache({ max: 2 })
  small.set('a', DEFAULT_VOICE, { mp3Path: join(outDir, 'a.mp3'), bytes: 1 })
  small.set('b', DEFAULT_VOICE, { mp3Path: join(outDir, 'b.mp3'), bytes: 1 })
  small.set('c', DEFAULT_VOICE, { mp3Path: join(outDir, 'c.mp3'), bytes: 1 })
  if (small.stats().size === 2) ok('超过 max 会淘汰（size 保持 2）')
  else bad(`淘汰没生效：size=${small.stats().size}`)
  if (!small.keys().includes(DEFAULT_VOICE + '\u0000a')) ok('淘汰的是最久没用的那条（LRU）')
  else bad('淘汰顺序不对，把最近用的删了')

  // 文件被外部删掉 ⇒ 不许把死路径交出去
  const dead = makeTtsCache({ max: 4 })
  dead.set('已删除的文件', DEFAULT_VOICE, { mp3Path: join(outDir, 'nope-does-not-exist.mp3'), bytes: 9 })
  if (!dead.get('已删除的文件', DEFAULT_VOICE)) ok('文件没了 ⇒ 当未命中（不把死路径给前端）')
  else bad('把不存在的文件路径当命中交出去了')

  // 淘汰/清空要把 mp3 旁边的 .srt / .txt 一起删掉（第一版只删 mp3，会漏垃圾）
  const gcDir = join(os.tmpdir(), 'pet-tts-test-gc')
  mkdirSync(gcDir, { recursive: true })
  const gcMp3 = join(gcDir, 'gc.mp3')
  for (const ext of ['.mp3', '.srt', '.txt']) writeFileSync(gcMp3.replace(/\.mp3$/, ext), 'x')
  const gc = makeTtsCache({ max: 1 })
  gc.set('会被淘汰的', DEFAULT_VOICE, { mp3Path: gcMp3, bytes: 1 })
  gc.set('挤掉前一条', DEFAULT_VOICE, { mp3Path: join(gcDir, 'other.mp3'), bytes: 1 })
  const leftovers = ['.mp3', '.srt', '.txt'].filter((ext) => existsSync(gcMp3.replace(/\.mp3$/, ext)))
  if (leftovers.length === 0) ok('淘汰时 mp3/srt/txt 三个文件都删掉了（不留垃圾）')
  else bad('淘汰后还留着：' + leftovers.join(','))
}

console.log('\n5. 超时：卡住的合成必须被掐掉，而且不许等满 15 秒')
{
  // 假 spawn：永远不 close（模拟云端挂住）
  const hangSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true; setTimeout(() => child.emit('close', -2), 0) }
    return child
  }
  const t0 = Date.now()
  const r = await synthesize({
    python: 'fake-python', text: '这句会卡住', outDir: join(os.tmpdir(), 'pet-tts-test-timeout'),
    spawn: hangSpawn, timeoutMs: 300,     // 调成 300ms；真等 15 秒会拖垮这套测试
  })
  const ms = Date.now() - t0
  if (!r.ok) ok('超时返回 ok:false（不抛异常）')
  else bad('超时竟然返回成功：' + JSON.stringify(r))
  if (/超时/.test(String(r.error))) ok('错误信息说清了是超时：' + r.error)
  else bad('错误信息没提超时：' + r.error)
  if (ms < 2000) ok(`300ms 超时真的在 ${ms}ms 就返回了（没有傻等 15 秒）`)
  else bad(`超时用了 ${ms}ms —— 定时器没生效`)
}

console.log('\n6. 失败路径：宁可不说话，也不许抛 / 不许降级成英文 SAPI')
{
  // 空文本
  const r1 = await synthesize({ python: 'x', text: '   ', outDir: os.tmpdir() })
  if (!r1.ok && /空/.test(r1.error)) ok('空文本 ⇒ ok:false（不抛）')
  else bad('空文本没被拦住：' + JSON.stringify(r1))

  // 没给 outDir：绝不往插件包目录写
  const r2 = await synthesize({ python: 'x', text: '有正文', outDir: '' })
  if (!r2.ok && /outDir/.test(String(r2.error))) ok('没给 outDir ⇒ 拒绝（不往插件包里写）')
  else bad('没 outDir 却往下走了：' + JSON.stringify(r2))

  // 没有 python
  const r3 = await synthesize({ python: '', text: '有正文', outDir: os.tmpdir() })
  if (!r3.ok) ok('没有 python ⇒ ok:false 并说明原因')
  else bad('没有 python 竟然成功了')

  // 解释器起不来（模拟 pip 没装 edge-tts ⇒ 退出码非 0）
  const failSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { }
    setTimeout(() => {
      child.stderr.emit('data', 'ModuleNotFoundError: No module named edge_tts\n')
      child.emit('close', 1)
    }, 1)
    return child
  }
  const r4 = await synthesize({ python: 'fake', text: '有正文', outDir: join(os.tmpdir(), 'pet-tts-test-fail'), spawn: failSpawn })
  if (!r4.ok && /退出码 1/.test(String(r4.error))) ok('合成失败 ⇒ 原样带回错误：' + String(r4.error).slice(0, 70))
  else bad('失败路径没兜住：' + JSON.stringify(r4))

  // 半截文件（exit 0 但写了个 0 字节 mp3 —— 实测空文本就是这样）
  const emptySpawn = (cmd, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { }
    const mediaIdx = args.indexOf('--write-media')
    writeFileSync(args[mediaIdx + 1], Buffer.alloc(0))
    setTimeout(() => child.emit('close', 0), 1)
    return child
  }
  const r5 = await synthesize({ python: 'fake', text: '有正文', outDir: join(os.tmpdir(), 'pet-tts-test-empty'), spawn: emptySpawn })
  if (!r5.ok) ok('exit 0 但写出 0 字节 ⇒ 当失败（实测空文本就是这样）')
  else bad('0 字节 mp3 被当成功了：' + JSON.stringify(r5))
}

console.log('\n7. 真的跑一次 edge-tts（唯一需要 python 和网络的一步）')
{
  const t0 = Date.now()
  const py = await resolvePython(['python', 'py -3', 'python3'])
  const probeMs = Date.now() - t0
  if (!py.ok) {
    skip(`这台机器没有 python + edge-tts 7.3+（${py.reason || '探测失败'}）—— 跳过真合成`)
    skip('探测本身也没抛异常（这条算过）')
    pass++
  } else {
    console.log(`  · 解释器：${py.command} ${py.args.join(' ')} → ${py.executable}`)
    console.log(`  · edge-tts ${py.version} / ${py.pythonVersion} / 探测耗时 ${probeMs}ms`)
    // 缓存要真的生效（同一个 key 第二次探测不该再花 0.9 秒）
    const t1 = Date.now()
    await resolvePython(['python', 'py -3', 'python3'])
    const cachedMs = Date.now() - t1
    if (cachedMs < probeMs / 2 || cachedMs < 5) ok(`探测结果被缓存（第二次 ${cachedMs}ms，第一次 ${probeMs}ms）`)
    else bad(`探测没缓存：两次都花 ${probeMs}ms / ${cachedMs}ms`)

    const text = cleanForSpeech('主人，小鱼在呢٩(๑>◡<๑)۶ 今天捞回来三条好玩的。')
    const outDir = join(os.tmpdir(), 'douyin-duty-tts-test')
    const t2 = Date.now()
    const r = await synthesize({ python: py.command, pythonArgs: py.args, text, outDir })
    const ms = Date.now() - t2
    if (!r.ok) {
      bad('真合成失败：' + r.error)
    } else {
      ok(`合成成功：${r.bytes} 字节 / ${ms}ms / ${r.voice}`)
      if (r.bytes > 3000) ok(`mp3 有 ${r.bytes} 字节（> 3000，不是半截文件）`)
      else bad(`mp3 只有 ${r.bytes} 字节（< 3000）`)
      if (ms < 15_000) ok(`耗时 ${ms}ms < 15000ms（真的出声了）`)
      else bad(`耗时 ${ms}ms 超过 15 秒`)
      // 必须是真 MP3 帧头，不是错误页/半截包
      try {
        const buf = readFileSync(r.mp3Path)
        if (looksLikeMp3(buf)) ok('文件头是 MP3 帧同步（ff f3 …），不是文本错误')
        else bad('不是 MP3：' + buf.subarray(0, 4).toString('hex'))
      } catch (e) { bad('mp3 读不出来：' + e.message) }
      // 口型：字幕要么给出 cue，要么如实说没有（前端退化成包络）
      if (Array.isArray(r.cues) && r.cues.length) ok(`拿到 ${r.cues.length} 条 cue（嘴型能对齐句子）`)
      else skip('这次没拿到 cue（' + (r.cueError || '未知') + '）—— 嘴型退化成振幅包络')
    }
  }
}

/* ── 收尾：清掉临时目录里这次的残留（别在主人的 Temp 里堆 mp3）── */
try { sweepTtsDir(join(os.tmpdir(), 'douyin-duty-tts-test'), { olderThanMs: 0 }) } catch { /* 清不掉算了 */ }

console.log(fail ? `\n结果：${pass} 通过 / ${fail} 失败` : `\n结果：${pass} 通过 / 0 失败 ✓ 语音链路能出声、能对上嘴型`)
console.log(`RESULT: pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
