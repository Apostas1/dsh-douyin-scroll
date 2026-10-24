/* dsh-deskpet 网页桌宠逻辑（Electron 透明窗加载）
 * 架构（抄 dsh-whale-girl-live2d desktop/windows 的思路）：
 *   Electron 主进程 = 窗口管理（透明/置顶/穿透判定/托盘），本文件 = 全部桌宠行为。
 *   配置/意图仍走文件（window.petCmdWrite / petStateRead 由 preload 暴露），
 *   网页环境里 fetch/写文件都比 WPF 稳。
 * 状态源：宿主每 10 秒写的 pet-window-state.json（经 preload 读进来）。
 */
'use strict'

const $ = (id) => document.getElementById(id)
const petBody = $('pet-body')
const bubbleEl = $('pet-bubble')
const menuEl = $('menu')
const chatEl = $('chat')
const chatLog = $('chat-log')
const chatInput = $('chat-input')

/* ── 人格档案（与 prompts/deskpet-personas/*.json 同源；自包含保离线） ── */
const PERSONAS = {
  infp: {
    name: 'INFP · 治愈小鱼',
    idle: ['主人在忙吗…我就在这里陪着～', '今天的云好像棉花糖呀', '发呆也很重要哦～', '要不要休息一下？'],
    watch: ['我看着消息呢，主人放心～', '有消息我会说的～'],
    run: ['我在挑好玩的哦～马上就好', '为了主人加油呀～'],
    sleep: ['Zzz…梦到主人了', '晚安的世界…Zzz'],
    error: ['呜…有点不舒服…等下一拍再试', '别担心，我缓一缓…'],
    feed: ['哇是大白饭！谢谢主人～', '唔姆唔姆…好幸福', '吃饱了就有力气陪主人啦！'],
    feed_full: ['我、我吃不下了啦…', '再吃就要翻白肚了…'],
    quip: ['主人的鼠标跑得好快，像小鱼群～', '窗外的光好好看…', '主人喝水了吗？要照顾好自己呀'],
    click: ['诶嘿嘿～', '在哦在哦～', '主人的手指好温柔'],
    chat_greet: ['来找我聊呀～我在听', '想说什么都行哦'],
    chat_fallback: ['嗯嗯，我在听～', '这样呀…', '主人说什么都好', '（歪头）然后呢？'],
    danmaku: ['主人加油呀～', '记得喝水哦', '休息一下眼睛吧～', '我在看着你哦（温柔的）', '不要熬夜呀主人', '慢慢来，不着急～'],
    repair: ['体检开始咯～哪里不舒服我都帮你看～', '全部正常！主人的环境很健康呀～', '找到 N 个要修的地方啦，我一条条说哦～', '按我说的点就好啦，一步一步来～', '修好啦！我这条小鱼也是能干活的嘛～'],
    bob: [4, 2.8], sway: 1.4, walkRest: [18, 40], quipEvery: [90, 240],
  },
  entp: {
    name: 'ENTP · 毒舌本鱼',
    idle: ['本鱼在思考，勿扰', '就这破桌面，也就本鱼肯待', '摸鱼？那叫战略性待机', '有事启奏，无事退朝'],
    watch: ['盯着呢，别想蒙本鱼', '消息一来本鱼就到，比你上班积极'],
    run: ['垃圾真多，慢慢挑', '本鱼出手，一个能打的都没有'],
    sleep: ['Zzz…（别吵，本鱼的美容觉）', '哼，睡了，有事明早'],
    error: ['啧，翻车了。本鱼看看是哪个环节拉胯', '不是本鱼的锅，是网络的锅（大概）'],
    feed: ['算你识相，大白饭伺候', '唔姆…勉强及格，下次米再精一点', '吃你的饭，看本鱼干活，美死你'],
    feed_full: ['本鱼是肥，不是饭桶！', '行了行了，撑得游不动了'],
    quip: ['我看你这鼠标轨迹，画画没天赋', '这屏幕亮度，眼睛不要啦？', '本鱼观察你半天了，就这效率？', '又切窗口，又摸鱼，本鱼都替你害臊', '那咋了'],
    click: ['戳什么戳，鱼是能随便戳的吗', '哼，看在本鱼心情好的份上', '再戳收戳费了啊（一条大白饭）'],
    chat_greet: ['说吧，本鱼勉为其难听一下', '有事快说，本鱼忙着呢（其实没有）'],
    chat_fallback: ['就这？就这？', '那咋了', '嗯嗯嗯（没在听）', '继续说，本鱼在酝酿毒舌', '这话你自己信吗', '6，实在是太6了', '问就是你的问题'],
    danmaku: ['就这？就这？', '本鱼看不下去了', '主人又在假装工作', '这操作，本鱼直呼内行（反话）', 'token！本鱼要token！', '大白饭呢？工钱呢？', '6，实在是太6了', '那咋了', '已老实，求放过（不许放）', '搁这儿画圈圈呢？', '本鱼要是你，早把这事干完了', '退堂鼓打得比谁都响', '问就是主人的问题'],
    repair: ['行吧，本鱼勉为其难当回维修工。哪里坏了赶紧报', '居然全绿？行，你小子环境养得不错', '逮到了，N 个问题。平时怎么用电脑的', '照着修，别磨叽。修不好再来求本鱼', '修完了，谢恩吧'],
    bob: [4, 1.6], sway: 2.2, walkRest: [10, 22], quipEvery: [45, 120],
  },
  esfp: {
    name: 'ESFP · 元气小鱼',
    idle: ['闲着也是闲着！跳舞！', '今天也是超棒的一天！', '主人主人！看我！', '嗯哼哼～♪'],
    watch: ['手机在我手上！消息跑不掉！', '瞪瞪瞪——盯着呢！'],
    run: ['刷抖音喽！冲鸭！！', '这条好玩！这条也好玩！'],
    sleep: ['Zzz…（明天继续high）', '呼…充电中…Zzz'],
    error: ['哎呀翻车了！没关系再来！', '摔了一跤，爬起来就好啦！'],
    feed: ['干饭！干饭！！', '大白饭万岁！！', '好吃到转圈圈！'],
    feed_full: ['肚子要爆炸啦！', '嗝——吃不下了！'],
    quip: ['主人加油！！你最棒！', '哇你打字好快！', '陪我玩嘛陪我玩嘛！', '这个时间了还不休息呀？'],
    click: ['戳我干嘛！再来！再戳！', '嘿嘿！好玩！', '转圈圈～♪'],
    chat_greet: ['找我玩！找我玩！', '来聊天下棋跳舞都行！'],
    chat_fallback: ['哇！！', '然后呢然后呢！', '哈哈哈这个好笑', '诶——还有这种事！', '好玩好玩！'],
    danmaku: ['冲鸭！！', '干饭！干饭！', '这也太好玩了吧', '主人最棒！！', '哈哈哈', '666', '看看我！', '元气满满！', '今天也要开心呀！', '奥利给！'],
    repair: ['维修工上线！帽子戴好——开工！', '全绿！完美！撒花！！', '抓到 N 个小问题！一个个消灭！', '点这里！然后这里！马上就好！', '修完啦！！快夸我快夸我！'],
    bob: [5, 1.8], sway: 2.4, walkRest: [8, 18], quipEvery: [40, 90],
  },
  istj: {
    name: 'ISTJ · 维修工小鱼',
    idle: ['待命中。', '例行巡逻，无异常。', '设备状态良好。'],
    watch: ['监视中。有情况会报告。'],
    run: ['任务执行中。', '进度：正常。完成后会通知。'],
    sleep: ['低功耗模式。', '已休眠。到点自动唤醒。'],
    error: ['检测到异常。正在定位。', '故障已记录。等待修复。'],
    feed: ['补给确认。谢谢。', '能量补充完毕。效率+10%。'],
    feed_full: ['摄入超限。建议停止投喂。'],
    quip: ['坐姿提醒：背部挺直。', '已连续工作 X 分钟，建议休息。', '鼠标移动距离今日已超标。'],
    click: ['在。', '请讲。', '收到。'],
    chat_greet: ['你好。请陈述事项。'],
    chat_fallback: ['已记录。', '了解。', '执行中。', '该项需要更多细节。', '收到，继续。'],
    danmaku: ['工位整洁度待改进', '该喝水了', '久坐警告', '已记录：又在摸鱼', '效率偏低，注意', '定时休息，执行'],
    repair: ['维修工就位。开始环境体检，请稍候。', '体检完成：全部通过。保持。', '体检完成：发现 N 个问题。按严重程度排序。', '按顺序处理。每完成一项，我会复核。', '全部修复完成。有需要再叫我。'],
    bob: [3, 2.2], sway: 1.0, walkRest: [25, 60], quipEvery: [180, 420],
  },
}

const state = {
  cfg: null,            // {on, persona, danmaku, walk, sprite_dir, api}
  layers: {}, props: {},
  persona: 'infp', repair: false, fedAt: 0, fedCount: 0,
  lastPropSet: '', lastAutoAt: 0,
  chatOpen: false, dragging: false,
}

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const P = (k) => (PERSONAS[state.persona] || PERSONAS.infp)[k] || []

/* ── preload 桥（Electron 注入；缺了就降级成纯网页预览） ── */
const bridge = window.dshpetBridge || null
function cmdWrite(obj) {
  if (bridge && bridge.cmdWrite) bridge.cmdWrite(obj)
  else console.log('[cmd]', obj)
}
function stateRead() {
  if (bridge && bridge.stateRead) return bridge.stateRead()
  return null
}
function sfx(which) {
  // 渲染层直接播 sprite 目录里的 wav（主进程 sfx 消息只是触发器）
  try {
    if (!state.cfg || !state.cfg.sprite_dir) return
    const f = which === 'gulp' ? 'sfx-gulp.wav' : 'sfx-pop.wav'
    let el = document.getElementById('sfx-' + which)
    if (!el) {
      el = document.createElement('audio'); el.id = 'sfx-' + which
      el.src = state.cfg.sprite_dir + '/' + f; el.style.display = 'none'
      document.body.appendChild(el)
    }
    el.currentTime = 0; el.play().catch(() => {})
  } catch {}
}

/* ── 图层加载 ── */
const LAYERS = ['back hair', 'tail', 'legwear', 'footwear', 'neck', 'topwear',
  'handwear', 'headwear', 'face', 'eyebrow', 'eyewhite', 'irides', 'eyelash', 'mouth', 'front hair']
function loadLayers(spriteDir) {
  petBody.innerHTML = ''
  state.layers = {}; state.props = {}
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/')
  const mk = (src, cls) => {
    const img = document.createElement('img')
    img.src = src; img.className = cls || ''; img.draggable = false
    return img
  }
  for (const n of LAYERS) {
    const f = (n === 'irides' && state.persona === 'entp') ? 'irides-dark.png' : `${n}.png`
    const img = mk(`${spriteDir}/layers/${enc(f)}`)
    if (n === 'irides') { img.id = 'irides' }
    if (n === 'eyelash') img.classList.add('blinkable')
    petBody.appendChild(img)
    state.layers[n] = img
  }
  petBody.firstElementChild.classList.add('anim-body')
  for (const p of ['phone', 'zzz', 'hardhat', 'wrench', 'ricebowl']) {
    const img = mk(`${spriteDir}/enc-prop-${p}.png`.replace('enc-prop-', ''))
    img.classList.add('prop'); img.style.display = 'none'; img.dataset.prop = p
    petBody.appendChild(img); state.props[p] = img
  }
}

/* ── 泡泡 / 道具 ── */
let bubbleTimer = null
function bubble(text, ms) {
  if (!text) { bubbleEl.style.display = 'none'; return }
  bubbleEl.textContent = text; bubbleEl.style.display = 'block'
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (ms) bubbleTimer = setTimeout(() => { bubbleEl.style.display = 'none' }, ms)
}
function setProp(set) {
  if (set === state.lastPropSet) return
  for (const k of Object.keys(state.props)) state.props[k].style.display = 'none'
  for (const k of set.split(',')) { const el = state.props[k.trim()]; if (el) el.style.display = 'block' }
  state.lastPropSet = set
}

/* ── 动画节奏（人格）── */
function applyMotion() {
  const m = PERSONAS[state.persona]
  petBody.style.setProperty('--bob-dur', `${m.bob[1]}s`)
  petBody.style.setProperty('--sway', `${m.sway}deg`)
}

/* ── 眼随鼠标（浏览器环境 = 已在同一坐标系，WPF 的 DPI 坑天然不存在）── */
let eyeX = 0, eyeY = 0, lastMoveAt = 0, lastCursor = null
document.addEventListener('mousemove', (e) => {
  const now = Date.now() / 1000
  if (lastCursor && (Math.abs(e.screenX - lastCursor.x) >= 2 || Math.abs(e.screenY - lastCursor.y) >= 2)) lastMoveAt = now
  lastCursor = { x: e.screenX, y: e.screenY }
})
setInterval(() => {
  const irides = state.layers.irides
  if (!irides) return
  const now = Date.now() / 1000
  const watching = now - lastMoveAt < 1.2
  const r = petBody.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.28
  let nx = 0, ny = 0
  if (watching && lastCursor) {
    const dx = lastCursor.x - cx, dy = lastCursor.y - cy
    if (Math.abs(dx) > 25) nx = Math.max(-1, Math.min(1, (dx - Math.sign(dx) * 25) / 420))
    if (Math.abs(dy) > 25) ny = Math.max(-1, Math.min(1, (dy - Math.sign(dy) * 25) / 420))
  }
  const k = watching ? 0.25 : 0.06
  eyeX += (nx - eyeX) * k; eyeY += (ny - eyeY) * k
  irides.style.transform = `translate(${(eyeX * 3.2).toFixed(2)}px, ${(eyeY * 2.2).toFixed(2)}px)`
}, 60)

/* ── 走动（Petra 式：随机目标匀速 + 休息；网页版挪的是 #pet）── */
let walkTarget = null, restUntil = 0
setInterval(() => {
  if (!state.cfg || !state.cfg.walk || state.dragging || state.chatOpen) return
  const pet = $('pet'); const now = Date.now()
  if (now < restUntil) return
  if (!walkTarget) {
    walkTarget = {
      x: 30 + Math.random() * Math.max(1, window.innerWidth - 230),
      y: 30 + Math.random() * Math.max(1, window.innerHeight - 290),
    }
  }
  const cx = pet.offsetLeft + pet.offsetWidth / 2, cy = pet.offsetTop + pet.offsetHeight / 2
  const dx = walkTarget.x - cx, dy = walkTarget.y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 14) {
    walkTarget = null
    const m = PERSONAS[state.persona]
    restUntil = now + (m.walkRest[0] + Math.random() * (m.walkRest[1] - m.walkRest[0])) * 1000
    return
  }
  const step = 1.4   // ≈42px/s @30fps
  pet.style.left = `${Math.max(0, Math.min(window.innerWidth - 200, pet.offsetLeft + (dx / dist) * step))}px`
  pet.style.top = `${Math.max(0, Math.min(window.innerHeight - 260, pet.offsetTop + (dy / dist) * step))}px`
}, 33)

/* ── 状态轮询（2s；宿主写状态文件，preload 读进来） ── */
setInterval(async () => {
  const j = stateRead()
  if (!j) return
  if (j.on === false) { location.reload(); return }
  if (!state.layers['front hair']) loadLayers(j.sprite_dir)
  const personaChanged = j.persona !== state.persona
  if (personaChanged) {
    state.persona = j.persona in PERSONAS ? j.persona : 'infp'
    loadLayers(j.sprite_dir); applyMotion()
    bubble(`换人格：${PERSONAS[state.persona].name}`, 4000)
  }
  if (!state.repair) {
    const link = (j.link && j.link.state) || 'idle'
    setProp(link === 'watch' ? 'phone' : link === 'sleep' ? 'zzz' : '')
    const nowSec = Date.now() / 1000
    if ((link === 'run' || link === 'watch' || link === 'error') && nowSec - state.lastAutoAt > 30) {
      bubble(pick(P(link))); state.lastAutoAt = nowSec
    }
  }
  // 弹幕开关（宿主权威；右键本地翻转由 15s 待确认窗口期保护）
  const wantDm = j.danmaku === true
  $('danmaku').style.display = wantDm ? 'block' : 'none'
}, 2000)

/* ── 吐槽 ── */
function scheduleQuip() {
  const m = PERSONAS[state.persona]
  const ms = (m.quipEvery[0] + Math.random() * (m.quipEvery[1] - m.quipEvery[0])) * 1000
  setTimeout(() => {
    if (state.cfg && !state.chatOpen && (!state.cfg.link || state.cfg.link.state !== 'sleep')) bubble(pick(P('quip')), 6000)
    scheduleQuip()
  }, ms)
}
scheduleQuip()

/* ── 喂饭 ── */
function feed() {
  const nowSec = Date.now() / 1000
  if (nowSec - state.fedAt < 30 || state.fedCount >= 3) { bubble(pick(P('feed_full')), 4000); return }
  state.fedAt = nowSec; state.fedCount++
  setProp('ricebowl'); bubble(pick(P('feed')), 5000); sfx('gulp')
  petBody.classList.remove('qbang'); void petBody.offsetWidth
  petBody.classList.add('qbang')
  setTimeout(() => { state.lastPropSet = '' }, 8000)
}

/* ── 聊天（本地人格小脑；全局兜底保秒回） ── */
function chatBrain(text) {
  const p = state.persona
  const rule = (pairs) => pairs.find(([re]) => re.test(text))
  if (rule) {
    const byPersona = { entp: rule[1], istj: rule[2], esfp: rule[3], default: rule[4] }
    return byPersona[p] || byPersona.default
  }
  return pick(P('chat_fallback'))
}
function chatToggle() {
  state.chatOpen = !state.chatOpen
  chatEl.style.display = state.chatOpen ? 'block' : 'none'
  if (state.chatOpen) {
    $('chat-title').textContent = PERSONAS[state.persona].name
    chatLog.innerHTML = ''
    chatAdd(pick(P('chat_greet')), 'them')
    chatInput.focus()
  }
}
function chatAdd(text, who) {
  const d = document.createElement('div')
  d.className = who; d.textContent = text
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight
}
$('chat-send').addEventListener('click', () => {
  const t = chatInput.value.trim(); if (!t) return
  chatInput.value = ''
  chatAdd(`你：${t}`, 'me')
  const reply = chatBrain(t)
  chatAdd(`${PERSONAS[state.persona].name.split(' ')[0]}：${reply}`, 'them')
  bubble(reply, 6000)
})
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chat-send').click() })

/* ── 右键菜单 ── */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  menuEl.style.display = 'block'
  menuEl.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`
  menuEl.style.top = `${Math.min(e.clientY, window.innerHeight - 320)}px`
})
document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target)) menuEl.style.display = 'none'
})
menuEl.addEventListener('click', (e) => {
  const act = e.target.dataset && e.target.dataset.act
  if (!act) return
  menuEl.style.display = 'none'
  if (act === 'chat') chatToggle()
  if (act === 'feed') feed()
  if (act === 'repair') {
    state.repair = !state.repair
    if (state.repair) { setProp('hardhat,wrench'); bubble(P('repair')[0], 6000) }
    else { state.lastPropSet = 'RESET'; bubble(P('repair')[4], 6000) }
  }
  if (act === 'danmaku') {
    const nv = !(state.cfg && state.cfg.danmaku)
    cmdWrite({ danmaku: nv })
    state.cfg = state.cfg || {}; state.cfg.danmaku = nv
    $('danmaku').style.display = nv ? 'block' : 'none'
  }
  if (act === 'walk') {
    const nv = !(state.cfg && state.cfg.walk)
    cmdWrite({ walk: nv })
    state.cfg = state.cfg || {}; state.cfg.walk = nv
  }
  if (act === 'persona') {
    const order = ['infp', 'entp', 'esfp', 'istj']
    const next = order[(order.indexOf(state.persona) + 1) % 4]
    cmdWrite({ petPersona: next })
    state.persona = next; loadLayers(state.cfg.sprite_dir); applyMotion()
    bubble(`换人格：${PERSONAS[next].name}`, 4000)
  }
  if (act === 'hide') { cmdWrite({ hide: true }); window.close && window.close() }
  if (act === 'quit') { cmdWrite({ petOn: false }); window.close && window.close() }
})

/* ── 点击她（Q 弹 + 音效 + 台词）── */
petBody.addEventListener('click', () => {
  sfx('pop')
  petBody.classList.remove('qbang'); void petBody.offsetWidth; petBody.classList.add('qbang')
  bubble(pick(P('click')), 4000)
})

/* ── 穿透判定桥 + 拖动（whale-girl 模式：主进程 90ms 轮询来问，页面答）── */
window.__hitKind = (x, y) => {
  // x,y 是窗口内坐标。UI 元素（菜单/聊天/泡泡）在 useCapture 里已经挡了 hitTest=false 的情况
  const el = document.elementFromPoint(x, y)
  if (!el) return 'none'
  if (el.closest('#chat') || el.closest('#menu') || el.id === 'pet-bubble') return 'ui'
  if (el.closest('#pet-body')) return 'pet'
  return 'none'
}
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (e.target.closest && e.target.closest('#chat,#menu')) return   // UI 上的按下不拖窗
  if (bridge && bridge.pointerHeld) bridge.pointerHeld(true)
  if (bridge && bridge.dragStart && e.target.closest && e.target.closest('#pet-body')) {
    bridge.dragStart({ x: e.screenX, y: e.screenY })
    state.dragging = true
  }
}, true)
document.addEventListener('mouseup', () => {
  if (bridge && bridge.pointerHeld) bridge.pointerHeld(false)
  if (state.dragging && bridge && bridge.dragEnd) { bridge.dragEnd(); state.dragging = false }
}, true)
/* 主进程的 sfx 触发器 → 页面 Audio 播 */
window.__sfx = (which) => sfx(which)

/* ── 首帧 ── */
applyMotion()
;(async () => {
  const j = stateRead()
  if (j && j.sprite_dir) {
    state.cfg = j; state.persona = j.persona in PERSONAS ? j.persona : 'infp'
    loadLayers(j.sprite_dir)
  } else {
    // 预览模式（无宿主）：同目录相对路径
    loadLayers('../assets/pet/sprite')
  }
})()
