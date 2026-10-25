/* dsh-deskpet 网页桌宠逻辑 —— Anime2.5DRig 引擎版
 * ============================================================================
 * 渲染 = Anime2.5DRig（MIT）：主人 PSD 直载 → 自动 rig → WebGL 网格变形
 *   （眨眼交叉淡化 / 虹膜掩码裁剪 / 发束物理 / 呼吸 / 伪3D 视差——引擎全带）
 * 交互 = 鱼写的那层（右键菜单/聊天小脑/弹幕/喂饭/意图通道），全部复用
 * 通信 = Electron preload 桥（stateRead/cmdWrite/sfx）+ 宿主状态文件协议
 * ============================================================================
 */
'use strict'

const $ = (id) => document.getElementById(id)
const petEl = $('pet')
const bubbleEl = $('pet-bubble')
const bodyEl = $('pet-body')
const menuEl = $('menu')
const talkbar = $('talkbar')
const chatInput = $('chat-input')

/* ── 人格档案（与 prompts/deskpet-personas 同源） ── */
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
    bob: [4, 2.8], walkRest: [18, 40], quipEvery: [90, 240],
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
    bob: [4, 1.6], walkRest: [10, 22], quipEvery: [45, 120],
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
    bob: [5, 1.8], walkRest: [8, 18], quipEvery: [40, 90],
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
    bob: [3, 2.2], walkRest: [25, 60], quipEvery: [180, 420],
  },
}

const state = {
  cfg: null, persona: 'infp', repair: false, fedAt: 0, fedCount: 0,
  chatOpen: false, dragging: false, loaded: false,
  lastAutoAt: 0, hidden: false,
}
/* ── 小动作系统（引擎参数编排——主人问「动作都弄好了吗」的正解）──
 * PSD 没有 motion 文件，Anime2.5DRig 是参数引擎 ⇒ 动作 = 参数时间线。
 * 每个动作 = 一串 [延迟ms, 参数补丁]，用 override 层打进 tickTargets。
 * override 期间 idle/眨眼继续，但被 override 的参数以 override 为准。 */
const ACTIONS = {
  happy: [   // 开心：眼睛弯弯+嘴笑+小跳两下
    { t: 0, p: { mouthForm: 1, eyeOpenL: 0.35, eyeOpenR: 0.35, mouthOpen: 0.4 } },
    { t: 300, p: { body: 0.5 } },
    { t: 600, p: { body: -0.5, eyeOpenL: 0.15, eyeOpenR: 0.15 } },
    { t: 900, p: { body: 0.5 } },
    { t: 1200, p: {} },
  ],
  surprise: [ // 吃惊：睁大眼+张嘴+后仰
    { t: 0, p: { eyeOpenL: 1.3, eyeOpenR: 1.3, mouthOpen: 0.8, angleY: -0.5, brow: 1 } },
    { t: 1000, p: {} },
  ],
  sulk: [    // 委屈：眉下压+ジト目+身体缩
    { t: 0, p: { brow: -1, eyeOpenL: 0.55, eyeOpenR: 0.55, mouthForm: -0.6, body: -0.4 } },
    { t: 1800, p: {} },
  ],
  wave: [    // 挥手：手臂上下摆（armY）+ 笑
    { t: 0, p: { armY: 1, mouthForm: 0.8 } },
    { t: 350, p: { armY: 0.3 } },
    { t: 700, p: { armY: 1 } },
    { t: 1050, p: { armY: 0.3 } },
    { t: 1400, p: { armY: 0, mouthForm: 0 } },
  ],
  sleepy: [  // 困：眼皮半合+点头
    { t: 0, p: { eyeOpenL: 0.25, eyeOpenR: 0.25, angleZ: 0.5 } },
    { t: 800, p: { angleZ: -0.3 } },
    { t: 1600, p: { angleZ: 0.5 } },
    { t: 2400, p: {} },
  ],
  spin: [    // 转圈：身体绕一圈（engine angleX/Y 联动）
    { t: 0, p: { angleX: -0.8, angleZ: 0.6 } },
    { t: 250, p: { angleX: 0.8, angleZ: -0.6 } },
    { t: 500, p: { angleX: -0.8, angleZ: 0.6 } },
    { t: 750, p: {} },
  ],
}
let actionOverride = null   // {until, patches:[{t,p}], idx, startAt}
function perform(name) {
  const a = ACTIONS[name]
  if (!a || state.actionUntil > Date.now()) return
  state.actionUntil = Date.now() + a[a.length - 1].t + 100
  actionOverride = { patches: a, idx: 0, startAt: Date.now(), name }
  const say = { happy: '开心', surprise: '诶？！', sulk: '哼…', wave: '挥挥～', sleepy: '困了啦…', spin: '转圈圈～' }[name]
  bubble(pick(P('click')).length && Math.random() < 0.5 ? pick(P('click')) : (say || ''), 2500)
}
state.actionUntil = 0

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const P = (k) => (PERSONAS[state.persona] || PERSONAS.infp)[k] || []

/* ── 诊断：记录最后一次鼠标事件（宿主/调试用）── */
window.__lastMouse = { type: '', x: 0, y: 0, t: 0 }
;['mousedown', 'mouseup', 'click', 'contextmenu', 'mousemove'].forEach((tp) => {
  document.addEventListener(tp, (e) => {
    window.__lastMouse = { type: tp, x: e.clientX, y: e.clientY, t: Date.now() }
  }, true)
})

/* ── 宿主桥 ──
   🔴 2026-10-24：宿主从 Electron 换成 WebView2（透明+可点击只能这么走），
   Electron 的 preload 桥不存在了 ⇒ 之前所有右键动作（退出/喂饭/弹幕/换人格）
   都只 console.log，点了没反应。现在接 WebView2 的 postMessage 通道：
     window.chrome.webview.postMessage('cmd:<json>') → 宿主写 pet-cmd.json → keeper 应用
   宿主还会推 state（pet-window-state.json 内容）进来，供 stateRead() 用。 */
const isWebView2 = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage)
const hasHost = isWebView2   // v8：宿主在 ⇒ 拖动交原生、右键交原生菜单、命中矩形上报
const bridge = window.dshpetBridge || (isWebView2 ? {
  cmdWrite: (obj) => {
    try { window.chrome.webview.postMessage('cmd:' + JSON.stringify(obj || {})) }
    catch (e) { console.warn('[cmd] postMessage 失败', e) }
  },
  sfx: (which) => {
    try { window.chrome.webview.postMessage('sfx:' + String(which || '')) } catch { }
  },
} : null)
// 宿主推来的状态（宿主每 2 秒读 pet-window-state.json 后推给页面）
// 🔴🔴 2026-10-25 修复：宿主原来执行的是
//      window.chrome.webview.postMessage('state:' + json)
//    而 postMessage 是**页面→宿主**方向，宿主自己执行等于发给自己 ⇒ 这里永远收不到，
//    pushedState 恒为 null ⇒ apiBase() 恒为 '' ⇒ 日记 / 聊天一起废掉。
//    现在宿主改成 ExecuteScriptAsync 直接调 window.__petOnState(jsonText)，
//    下面这个函数就是它的落点；老的 message 监听保留，防别处还在用。
let pushedState = null
function adoptStateText(txt) {
  try {
    if (typeof txt !== 'string' || !txt) return false
    pushedState = JSON.parse(txt)
    return true
  } catch (e) {
    console.warn('[state] 解析失败', e)
    return false
  }
}
// 宿主 → 页面 的正式入口（PushState 调它）
window.__petOnState = (txt) => { adoptStateText(txt) }
if (isWebView2) {
  window.chrome.webview.addEventListener('message', (ev) => {
    try {
      const d = ev.data
      if (typeof d === 'string' && d.startsWith('state:')) adoptStateText(d.slice(6))
    } catch (e) { console.warn('[state] 解析失败', e) }
  })
}
function cmdWrite(obj) { if (bridge && bridge.cmdWrite) bridge.cmdWrite(obj); else console.log('[cmd]', obj) }
function stateRead() { return bridge && bridge.stateRead ? bridge.stateRead() : pushedState }
function sfx(which) { if (bridge && bridge.sfx) bridge.sfx(which) }

/* ══════════ Anime2.5DRig 引擎集成 ══════════ */
const cv = $('gl')
const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true })
let renderer = null
let layers = []          // 引擎层（prepareLayers 产物）
let CW = 768, CH = 768
let cur = null, T = null, bounce = { x: 0, v: 0, dy: 0 }
let anchors = null, FS = 1, NP = null, BP = null, FC = null, CHEST = null
let maskFailed = false
const RT = window.RigRuntime
const mouse = { x: 0, y: 0, in: false }
let mouseIntentUntil = 0   // 鼠标动了才看；停 1.2s 回正（主人定的规矩）

// 引擎参数表（app.js 的 P 原样）
const P_DEFAULTS = { angleX: 0, angleY: 0, angleZ: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, brow: 0,
  mouthOpen: 0, mouthForm: 0, mouthCY: 0, body: 0, physAmp: 2, soft: 2,
  browAngL: 0, browAngR: 0, browAngSym: 0, bangL: 0, bangC: 0, bangR: 0,
  armY: 0, armPos: 0, bust: 2.5, bustY: 1, irisScale: 1, mouthEase: 0.72, eyeEase: 0.3,
  fhAmp: 2, fhSoft: 0.4, eyeCY: 0, eyeCAng: 0, mouthCAng: 0, eyeScaleL: 1, eyeScaleR: 1, mouthScale: 1, accAmp: 1 }

// blink 状态机（app.js 同款：偶发长眨眼 + 虹膜回弹）
let blinkT = -1, nextBlink = 0, blinkVariant = 1, blinkBounce = false, irisBounceT = -1
// 随机小动作（idle 活性）
let rnd = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 }, nextRnd = 0
// talk 口型（chat 面板发消息时说话）
let talkTgt = 0, talkV = 0, talkUntil = 0

const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

async function loadPsd(url) {
  const buf = await (await fetch(url)).arrayBuffer()
  // ag-psd 的 UMD 全局是 window.agPsd，读法 = readPsd(buffer, { useImageData: true })
  // （rigger 注释写明「useImageData mode」——要 imageData 而不是 canvas）
  const psd = await window.agPsd.readPsd(buf, { useImageData: true, skipThumbnail: true, skipLayerImageData: false })
  // 🔴 GenericParts 导出的是 {width,height,b64}，必须用 .get(k) 解码成 {width,height,data}
  const G = window.GenericParts
  const rig = window.Rigger.buildRig(psd, {
    generic: {
      eyeL: G.get('eyeL'), eyeR: G.get('eyeR'), mouth: G.get('mouth'),
    },
  })
  return rig
}

function prepareLayers(rig) {
  const prepared = []
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE)
  for (const Lr of rig.layers) {
    const L = Object.assign({ visible: true, opacity: 1 }, Lr, { id: `${Lr.z}:${Lr.name}` })
    const cell = (L.phys ? 30 : 42) * Math.max(0.6, rig.canvas.w / 768)
    const { nx, ny } = RT.meshSize(L.w, L.h, cell), nv = (nx + 1) * (ny + 1)
    const base = new Float32Array(nv * 2), uv = new Float32Array(nv * 2)
    let k = 0
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      base[k] = L.x + L.w * i / nx; base[k + 1] = L.y + L.h * j / ny
      uv[k] = i / nx; uv[k + 1] = j / ny; k += 2
    }
    const idx = new Uint16Array(nx * ny * 6); let q = 0
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c
    }
    L.base = base; L.cur = new Float32Array(base)
    L.bn = window.Rigger.baseName(L.name.replace(/_(l|r)$/, ''))
    // 发束弹簧（app.js 同款：stiff 根硬 + soft 梢软）
    if (L.strands && L.strands.length) {
      const S = L.strands, nS = S.length
      let spacing = 120
      if (nS > 1) { const ds = []; for (let s = 1; s < nS; s++) ds.push(S[s].x - S[s - 1].x); ds.sort((a, b) => a - b); spacing = ds[ds.length >> 1] }
      const sig = Math.max(1, spacing * 0.6)
      L.sw = new Float32Array(nv * nS); L.su = new Float32Array(nv)
      L.spr = S.map((s, i) => ({ stiff: { x: 0, v: 0, dx: 0 }, soft: { x: 0, v: 0, dx: 0 }, phase: i * 1.37 + L.z }))
      for (let v = 0; v < nv; v++) {
        const x = base[v * 2], y = base[v * 2 + 1]; let tot = 0
        for (let s = 0; s < nS; s++) { const w = Math.exp(-Math.pow((x - S[s].x) / sig, 2)); L.sw[v * nS + s] = w; tot += w }
        let rY = 0, tY = 0
        if (tot > 1e-6) { for (let s = 0; s < nS; s++) { L.sw[v * nS + s] /= tot; rY += L.sw[v * nS + s] * S[s].rootY; tY += L.sw[v * nS + s] * S[s].tipY } }
        else { L.sw[v * nS] = 1; rY = S[0].rootY; tY = S[0].tipY }
        L.su[v] = Math.abs(y - rY) / Math.max(1, tY - rY)
      }
    }
    // 🔴 upload 的 image 必须是 ImageData（app.js 同款）——L.img.data 是裸 TypedArray
    const image = (typeof ImageData !== 'undefined') ? new ImageData(L.img.data, L.img.width, L.img.height) : L.img
    renderer.upload(L, { positions: L.cur, uvs: uv, indices: idx, image })
    prepared.push(L)
  }
  return prepared
}

function applyAnchors(rig) {
  anchors = JSON.parse(JSON.stringify(rig.anchors))
  FS = anchors.faceScale; NP = anchors.neckPivot; BP = anchors.bodyPivot
  FC = { x: anchors.face.cx, y: anchors.face.cy }
  const fh = anchors.face.y1 - anchors.face.y0
  CHEST = { cx: NP.cx, cy: anchors.neckBottom + fh * 0.60, rx: Math.max(1, (anchors.face.x1 - anchors.face.x0) * 0.60), ry: Math.max(1, fh * 0.45) }
}

function updateSprings(e, t, dt, wind) {
  const headDX = (e.angleX * 14 + e.angleZ * 0.07 * (NP.cy - FC.y)) * FS
  const bodyDX = e.body * 0.028 * (BP.cy - NP.cy) * 0.35 + e.angleX * 14 * 0.16 * FS
  for (const L of layers) {
    if (!L.spr) continue
    const base = L.group === 'head' ? headDX : bodyDX, windScale = (L.phys === 'sway' && L.group !== 'head') ? 2.5 : 1
    for (const sp of L.spr) {
      const w = wind ? (1.8 * Math.sin(t * 0.8 + sp.phase) + 1.0 * Math.sin(t * 1.9 + sp.phase * 2.3)) * windScale : 0
      const txv = base + w * FS
      RT.spring(sp.stiff, txv, 70, 9, dt); sp.stiff.dx = -(sp.stiff.x - txv) * 2.2
      RT.spring(sp.soft, txv, 16, 1.3, dt); sp.soft.dx = -(sp.soft.x - txv) * 3.0
    }
  }
  const bustTgt = (e.breath * 3.0 - e.angleY * 6.0 + e.body * 4.0) * FS
  RT.spring(bounce, bustTgt, 140, 4.2, dt); bounce.dy = -(bounce.x - bustTgt) * 3.0
}

/* deform —— app.js 原版简化移植（眼/嘴/眉/发/呼吸/视差/Q弹全保留） */
const FRONTISH = { 'front hair': 1, 'side hair': 1, 'ahoge': 1 }
function deform(L, e) {
  const b = L.base, o = L.cur, n = b.length
  const isHead = L.group === 'head'
  const az = e.angleZ * 0.07, cz = Math.cos(az), sz = Math.sin(az)
  const ab = e.body * 0.028, cb = Math.cos(ab), sb = Math.sin(ab)
  const eyeSide = L.side, EA = eyeSide === 'L' ? anchors.eyeL : (eyeSide === 'R' ? anchors.eyeR : null)
  const vOpen = eyeSide === 'L' ? e.eyeOpenL : e.eyeOpenR
  const mo = e.mouthOpen, mHalfW = (anchors.mouth.x1 - anchors.mouth.x0) / 2
  const nS = L.strands ? L.strands.length : 0
  const bcx = L.x + L.w / 2, bcy = L.y + L.h / 2
  const kind = L.phys === 'sway' ? 'acc' : FRONTISH[L.bn] ? 'fh' : 'bh'
  const physOn = nS && L.su
  const ampK = kind === 'acc' ? e.accAmp * 1.4 : kind === 'fh' ? e.fhAmp : e.physAmp
  const softK = kind === 'acc' ? 0.8 : kind === 'fh' ? e.fhSoft : e.soft
  const powA = kind === 'acc' ? 1.2 : kind === 'fh' ? 1.8 : 2.1
  for (let k = 0; k < n; k += 2) {
    let x = b[k], y = b[k + 1]
    const vi = k >> 1
    if (EA && (L.bn === 'eye_close' || L.bn === 'eye_close2')) {
      const sE = eyeSide === 'L' ? e.eyeScaleL : e.eyeScaleR
      if (sE !== 1) { const cxE = (EA.x0 + EA.x1) / 2, cyE = (EA.y0 + EA.y1) / 2; x = cxE + (x - cxE) * sE; y = cyE + (y - cyE) * sE }
    }
    if (L.bn === 'mouth_open' || L.bn === 'mouth_close') {
      const sM = e.mouthScale
      if (sM !== 1) { x = anchors.mouth.cx + (x - anchors.mouth.cx) * sM; y = anchors.mouth.cy + (y - anchors.mouth.cy) * sM }
    }
    if (L.fade === 'eyeOpen' && EA) {
      if (L.bn === 'irides') {
        const isc = e.irisScale, ibx = e.irisBounceX || 1, iby = e.irisBounceY || 1
        x = EA.icx + (x - EA.icx) * isc * ibx; y = EA.icy + (y - EA.icy) * isc * iby
        x += e.eyeX * 11 * FS; y += e.eyeY * 6 * FS
        const tl = smooth((0.32 - vOpen) / 0.32)
        y = EA.closeY + (y - EA.closeY) * (1 - 0.80 * tl)
      } else {
        y = EA.closeY + (y - EA.closeY) * (1 - 0.85 * (1 - vOpen))
      }
    }
    if ((L.fade === 'eyeClose' || L.fade === 'eyeClose2') && EA) {
      y -= vOpen * 3; y += e.eyeCY * 14 * FS
      const thE = e.eyeCAng * 0.3 * (eyeSide === 'L' ? 1 : -1)
      if (thE) { const ct = Math.cos(thE), st = Math.sin(thE), rx = x - bcx, ry = y - bcy; x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct }
    }
    if (L.bn === 'eyebrow') {
      y += -e.brow * 9 * FS
      const th = (eyeSide === 'L' ? e.browAngL + e.browAngSym : e.browAngR - e.browAngSym) * 0.30
      if (th) { const ct = Math.cos(th), st = Math.sin(th), rx = x - bcx, ry = y - bcy; x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct }
    }
    if (L.fade === 'mouthOpen') {
      y = anchors.mouth.y0 + (y - anchors.mouth.y0) * (0.5 + 0.5 * mo)
      const q = Math.pow(Math.abs(x - anchors.mouth.cx) / (mHalfW + 4), 1.5)
      y -= e.mouthForm * 6 * FS * (q - 0.35)
    }
    if (L.fade === 'mouthClose') { y += e.mouthCY * 14 * FS }
    if (L.bn === 'face' && y > anchors.mouth.cy) y += mo * 6 * FS * smooth((y - anchors.mouth.cy) / Math.max(1, anchors.face.y1 - anchors.mouth.cy))
    // 头部变换（depth 视差 + 颈部跟随）
    let hw = isHead ? 1 : (L.group === 'body' ? 0.16 : 0)
    if (L.bn === 'neck') hw = 0.55 * smooth((anchors.neckBottom - y) / Math.max(1, anchors.neckBottom - anchors.neckTop))
    if (hw > 0) {
      const rx = x - NP.cx, ry = y - NP.cy, rx2 = rx * cz - ry * sz, ry2 = rx * sz + ry * cz
      x += (rx2 - rx) * hw; y += (ry2 - ry) * hw
      const dd = L.depth
      x += hw * FS * (e.angleX * (14 + 40 * (dd - 1)) + e.angleX * (NP.cy - y) * 0.028)
      y += hw * FS * (-e.angleY * (9 + 30 * (dd - 1)) - e.angleY * (dd - 1) * (y - FC.y) * 0.05)
    }
    // 呼吸
    y -= (L.group === 'body' ? e.breath * 2.0 : e.breathHead * 1.6) * FS
    if (L.bn === 'topwear' && y < CHEST.cy) y -= e.breath * 2.2 * FS * smooth((CHEST.cy - y) / (CHEST.ry * 2))
    if (L.bn === 'topwear') x = NP.cx + (x - NP.cx) * (1 + e.breath * 0.003)
    // 发束物理
    if (physOn) {
      const u = kind === 'fh' ? Math.min(1, L.su[vi] * 1.6) : L.su[vi]
      const amp = Math.pow(u, powA) * ampK, softMix = Math.min(1, Math.pow(u, 1.2) * softK)
      let dx = 0
      for (let s = 0; s < nS; s++) { const w = L.sw[vi * nS + s]; if (w < 0.001) continue; const sp = L.spr[s]; dx += w * (sp.stiff.dx * (1 - softMix) + sp.soft.dx * softMix) }
      x += dx * amp; y += Math.abs(dx) * amp * 0.12
    }
    o[k] = x; o[k + 1] = y
  }
  if (Math.abs(ab) > 1e-4) {
    for (let k = 0; k < n; k += 2) { const rx = o[k] - BP.cx, ry = o[k + 1] - BP.cy; o[k] = BP.cx + rx * cb - ry * sb; o[k + 1] = BP.cy + rx * sb + ry * cb }
  }
}

/* fadeAlpha：eye/mouth 的交叉淡化系数 */
function fadeAlpha(L, e) {
  if (L.fade === 'eyeOpen') return smooth((e.eyeEase - 0.02 + e.eyeOpenL * 0) / 1) * 0 + (L.bn === 'irides' || L.bn === 'eyewhite' ? 1 : smooth((vOpenOf(L, e) - (L.bn === 'eyelash' ? 0.55 : 0.02)) / 0.2))
  if (L.fade === 'eyeClose') return 1 - smooth((vOpenOf(L, e) - 0.04) / 0.12)
  if (L.fade === 'eyeClose2') return 0
  if (L.fade === 'mouthOpen') return smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12)
  if (L.fade === 'mouthClose') return 1 - smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12)
  return 1
}
function vOpenOf(L, e) { return L.side === 'L' ? e.eyeOpenL : e.eyeOpenR }

/* ── 命中矩形上报（v8：宿主点击穿透用）──
   ⚠️ 为什么需要：v8 窗口是**真透明**的，但 WebView 表面仍是矩形。如果不告诉宿主
   "她实际占了哪块"，宿主只能整窗吃掉鼠标，桌面上一大片点不到（或反过来整窗穿透、
   她点不到）。所以由页面算出：
     · pet:box → 人物 alpha 包围盒（按当前帧的层边界算，不是读像素，快且准）
     · pet:ui  → 按钮条 / 台词条 / 泡泡（它们不在包围盒里，必须单独算）
   宿主把这些换算成物理像素做命中判定（见 PetHost.cs IsPointOnPet）。 */
let lastReport = ''
function petReportRects() {
  if (!hasHost) return
  try {
    const vw = window.innerWidth, vh = window.innerHeight
    // 人物框：取所有可见层在当前变形后的联合包围盒（引擎坐标 1024×1024 → 屏幕）
    let box = null
    if (layers.length && renderer) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const L of layers) {
        if (!L.visible || L.opacity < 0.02 || !L.cur) continue
        const ps = L.cur
        for (let i = 0; i < ps.length; i += 2) {
          const px = ps[i], py = ps[i + 1]
          if (px < x0) x0 = px; if (py < y0) y0 = py
          if (px > x1) x1 = px; if (py > y1) y1 = py
        }
      }
      if (x1 > x0 && y1 > y0) {
        // 🔴 2026-10-25 修：原来用 min(vw,vh) 反推画布，但窗口现在是
        //    「气泡带 + 画布 + 脚位」的竖长结构 ⇒ min 得到的是画布边长没错，
        //    但底边不在 vh、左边不在 (vw-side)/2，导致包围盒整体偏大（实测 700x441 vs 画布 240）。
        //    正确做法：**直接量 canvas 元素的真实矩形**，按它的边长换算。
        const cr = cv.getBoundingClientRect()
        const side = cr.width || Math.min(vw, vh)
        const cLeft = cr.left, cTop = cr.top
        box = {
          x: Math.round(cLeft + x0 * (side / CW)),
          y: Math.round(cTop + y0 * (side / CH)),
          w: Math.round((x1 - x0) * (side / CW)),
          h: Math.round((y1 - y0) * (side / CH)),
        }
      }
    }
    const R = (id) => {
      const el = document.getElementById(id)
      if (!el) return null
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') return null
      const r = el.getBoundingClientRect()
      if (r.width < 3 || r.height < 3) return null
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const tb = R('toolbar'), tl = (document.getElementById('talkbar') || {}).classList &&
      document.getElementById('talkbar').classList.contains('on') ? R('talkbar') : null
    const bb = R('pet-bubble')
    const boxJson = box ? JSON.stringify(box) : 'null'
    const uiJson = JSON.stringify({ tb, tl, bb })
    const stamp = boxJson + '|' + uiJson
    if (stamp === lastReport) return       // 没变化就不重复发，省得刷消息通道
    lastReport = stamp
    try { window.chrome.webview.postMessage('pet:box:' + boxJson) } catch { }
    try { window.chrome.webview.postMessage('pet:ui:' + uiJson) } catch { }
  } catch (err) { console.warn('[rects]', err) }
}
window.__petReportRects = petReportRects

/* 每 400ms 报一次（够跟得上呼吸/动作，又不吵）；鼠标移动时也顺带报一次 */
setInterval(petReportRects, 400)

/* 渲染一帧 */
function render(e) {
  const items = [], masks = []
  for (const L of layers) {
    const isMask = L.bn === 'eyewhite' && !!L.side
    const alpha = L.visible ? fadeAlpha(L, e) * L.opacity : 0
    if (alpha < 0.004 && !isMask) continue
    deform(L, e); renderer.positions(L, L.cur)
    if (isMask) masks.push({ L, side: L.side })
    if (alpha >= 0.004) items.push({ L, alpha, clip: L.bn === 'irides' && L.side ? L.side : null })
  }
  const frame = { width: CW, height: CH, background: [0, 0, 0, 0], masks: maskFailed ? [] : masks, items }
  try { renderer.draw(frame) } catch (err) {
    if (maskFailed) throw err
    maskFailed = true
    frame.masks = []; renderer.draw(frame)
  }
}

/* ── 目标参数计算（眨眼/idle活性/鼠标追从/说话口型——app.js 同款简化） ── */
let lastT = 0
function tickTargets(t, dt) {
  const tgt = Object.assign({}, T)
  // 主人定的眼动规矩：平时看前方，鼠标动了才看（1.2s 内算「在动」）
  const mouseLive = Date.now() / 1000 - lastMoveAt < 1.2
  if (mouseLive && mouse.in !== undefined) {
    tgt.angleX = clamp(mouse.x * 0.9, -1, 1); tgt.angleY = clamp(-mouse.y * 0.7, -1, 1)
    tgt.eyeX = clamp(mouse.x * 1.2, -1, 1); tgt.eyeY = clamp(-mouse.y * 0.8, -1, 1)
  }
  if (!mouseLive) { tgt.eyeX = 0; tgt.eyeY = 0; tgt.angleX *= 0.3; tgt.angleY *= 0.3 }
  // idle 活性（微转头/换视线）
  tgt.angleX += 0.13 * Math.sin(t * 0.42) + 0.05 * Math.sin(t * 1.13)
  tgt.angleY += 0.08 * Math.sin(t * 0.31 + 1.7)
  tgt.angleZ += 0.07 * Math.sin(t * 0.23 + 0.5)
  tgt.body += 0.10 * Math.sin(t * 0.19 + 2.1)
  // 随机小动作
  if (Date.now() > nextRnd) {
    nextRnd = Date.now() + 1400 + Math.random() * 2600
    rnd = { ax: (Math.random() * 2 - 1) * 0.55, ay: (Math.random() * 2 - 1) * 0.40, az: (Math.random() * 2 - 1) * 0.35, bd: (Math.random() * 2 - 1) * 0.30, ex: (Math.random() * 2 - 1) * 0.60, ey: (Math.random() * 2 - 1) * 0.35 }
  }
  tgt.angleX = clamp(tgt.angleX + rnd.ax, -1, 1); tgt.angleY = clamp(tgt.angleY + rnd.ay, -1, 1)
  tgt.angleZ = clamp(tgt.angleZ + rnd.az, -1, 1); tgt.body = clamp(tgt.body + rnd.bd, -1, 1)
  tgt.eyeX = clamp(tgt.eyeX + rnd.ex, -1, 1); tgt.eyeY = clamp(tgt.eyeY + rnd.ey, -1, 1)
  // 眨眼状态机
  if (blinkT < 0 && Date.now() > nextBlink) {
    blinkT = 0; blinkBounce = false
    blinkVariant = Math.random() < 0.2 ? 2 : 1
    nextBlink = Date.now() + 1600 + Math.random() * 3800
  }
  if (blinkT >= 0) {
    blinkT += dt
    const d = blinkT, hold = blinkVariant === 2 ? 3.4 : 0.34
    let v
    if (d < 0.08) v = 1 - d / 0.08
    else if (d < 0.08 + hold) v = 0
    else if (d < 0.24 + hold) { v = (d - 0.08 - hold) / 0.16; if (!blinkBounce && v > 0.12) { blinkBounce = true; irisBounceT = 0 } }
    else { v = 1; blinkT = -1 }
    tgt.eyeOpenL = Math.min(tgt.eyeOpenL, v); tgt.eyeOpenR = Math.min(tgt.eyeOpenR, v)
  }
  if (irisBounceT >= 0) { irisBounceT += dt; if (irisBounceT > 0.52) irisBounceT = -1 }
  // 说话口型（发消息后 1.6 秒）
  const talkOn = Date.now() < talkUntil
  if (talkOn) talkTgt = Math.random() < 0.25 ? 0.04 : 0.25 + Math.random() * 0.75
  else talkTgt = 0
  talkV += (talkTgt - talkV) * Math.min(1, dt * 22)
  tgt.mouthOpen = Math.max(tgt.mouthOpen, talkV)
  // 🔴 小动作 override 层：阶梯式——当前补丁的参数**持续生效**到下一个补丁
  //    （v1 是快照式：两个补丁之间参数掉回 idle，动作看起来抽搐一下就没了）
  if (actionOverride) {
    const elapsed = Date.now() - actionOverride.startAt
    while (actionOverride.idx < actionOverride.patches.length && actionOverride.patches[actionOverride.idx].t <= elapsed) {
      actionOverride.cur = actionOverride.patches[actionOverride.idx].p   // 累积应用（阶梯）
      actionOverride.idx++
    }
    if (elapsed >= actionOverride.patches[actionOverride.patches.length - 1].t + 100) {
      actionOverride = null
    } else if (actionOverride.cur) {
      for (const k of Object.keys(actionOverride.cur)) tgt[k] = actionOverride.cur[k]
    }
  }
  // 平滑到当前值
  const kSmooth = 1 - Math.exp(-dt * (actionOverride ? 20 : 14))
  for (const k in cur) { tgt[k] = clamp(tgt[k], -1.5, 1.5); cur[k] += (tgt[k] - cur[k]) * kSmooth }
  const e = Object.assign({}, cur)
  e.irisBounceX = 1; e.irisBounceY = 1
  if (irisBounceT >= 0) {
    const p = irisBounceT / 0.52, damp = Math.exp(-2.2 * p)
    const scale = 1 + 0.18 * Math.sin(p * Math.PI * 4.0) * damp, squash = 0.10 * Math.sin(p * Math.PI * 4.0 + Math.PI / 2) * damp
    e.irisBounceX = scale * (1 + squash); e.irisBounceY = scale * (1 - squash)
  }
  e.breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4)
  e.breathHead = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4 - 0.6)
  updateSprings(e, t, dt, true)
  return e
}

/* ── 主循环 ── */
let prevNow = performance.now()
function frameLoop(now) {
  const dt = Math.min(0.05, (now - prevNow) / 1000); prevNow = now
  try {
    if (layers.length) {
      const e = tickTargets(now / 1000, dt)
      render(e)
    }
  } catch (err) { console.error('frame', err) }
  requestAnimationFrame(frameLoop)
}

/* ── 鼠标（物理像素；浏览器里无 DPI 坑）── */
document.addEventListener('mousemove', (e) => {
  mouse.x = (e.screenX / window.screen.width - 0.5) * 2
  mouse.y = (e.screenY / window.screen.height - 0.5) * 2
  const now = Date.now() / 1000
  if (lastCursor && (Math.abs(e.screenX - lastCursor.x) >= 2 || Math.abs(e.screenY - lastCursor.y) >= 2)) lastMoveAt = now
  lastCursor = { x: e.screenX, y: e.screenY }
})
let lastCursor = null, lastMoveAt = 0

/* ── 窗口拖动（v8：交给宿主做原生拖动）──
   🔴 2026-10-24 改法：以前是页面算 screenX 增量发 'dragmove:dx,dy'，宿主改 Left/Top。
   那条路在 180% 缩放下会抖、会把窗口甩到屏幕外。现在只发一条 'pet:drag'：
   宿主 ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION，交给 Windows 自己的移动循环，
   位置、吸附、多显示器全都由系统处理（业界同类桌宠也是这么做）。
   浏览器预览（没有宿主）时退化成页面内平移 #pet。 */
let dragState = null
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const t = e.target
  if (t && t.closest && (t.closest('#talkbar') || t.closest('#menu') || t.closest('#toolbar') || t.tagName === 'INPUT' || t.tagName === 'BUTTON')) return
  dragState = { sx: e.screenX, sy: e.screenY, moved: false, sent: false }
})
document.addEventListener('mousemove', (e) => {
  if (!dragState) return
  const dx = e.screenX - dragState.sx, dy = e.screenY - dragState.sy
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true
  // 宿主：超过阈值就交出一次原生拖动（不再自己算增量）
  if (dragState.moved && !dragState.sent && hasHost) {
    dragState.sent = true
    try { window.chrome.webview.postMessage('pet:drag') } catch { }
  }
})
document.addEventListener('mouseup', () => { dragState = null })

/* ── 状态轮询（2s）+ 弹幕开关 ── */
setInterval(() => {
  const j = stateRead()
  if (!j) return
  if (j.on === false) { window.close && window.close(); return }
  if (!state.loaded && j.sprite_dir) { initModel(j.sprite_dir) }
  // ⭐ 她的所思所想（主人定的设计初衷）：每拍都兜一次
  pollActivityFromState(j)
  if (!state.repair) {
    const link = (j.link && j.link.state) || 'idle'
    const nowSec = Date.now() / 1000
    if ((link === 'run' || link === 'watch' || link === 'error') && nowSec - state.lastAutoAt > 30) {
      bubble(pick(P(link)), 5000); state.lastAutoAt = nowSec
    }
  }
  // ⭐ 弹幕三态（主人 2026-10-25）：从干净的状态文件恢复 & 跟随外部改动。
  //    注意这里**不能**直接改 display（会和 setDanmakuMode 抢），统一交给它。
  const wantMode = (typeof j.danmakuMode === 'string' && ['off', 'local', 'full'].includes(j.danmakuMode))
    ? j.danmakuMode
    : (j.danmaku === true ? 'local' : 'off')
  /* 🔴🔴🔴 2026-10-25 晚 「弹幕模式，出问题了，会消失」的**真正主因**就在这。
   *
   *  这个轮询每 2 秒跑一次，会读 pet-window-state.json 里的 danmakuMode；
   *  而那个字段是 **keeper 每 10 秒全量重写**状态文件时按 cfg 生成的。
   *  主人刚点开弹幕（页面本地开 + 写 pet-cmd.json），keeper 还没跑下一拍，
   *  cfg 仍是 off ⇒ **2 秒后这里就把刚开的弹幕按回 off**。
   *  主人看到的就是"亮一下 → 没了"，而且不知道为什么。
   *
   *  ✅ 修法：页面自己**主动**改过之后进入静默期（DM_GRACE_MS）。
   *     静默期内忽略文件里的旧值，等 keeper 把 cfg 写回正确值再恢复同步。
   *     两边最终仍然一致，只是不会自己顶掉自己刚做的操作。
   */
  if (Date.now() < danmakuUserUntil) return
  if (wantMode !== danmakuMode) setDanmakuMode(wantMode, true)   // true = 来自状态，不回写 cmd
}, 2000)

/* ── 模型加载（PSD → rig → WebGL）── */
async function initModel(spriteDir, psdUrl) {
  try {
    renderer = window.RigRenderer.create(gl)
    const psd = psdUrl || (spriteDir.replace(/sprite\/?$/, '') + 'psd/model.psd')
    state.cfg = state.cfg || {}; state.cfg.sprite_dir = spriteDir
    const rig = await loadPsd(psd)
    layers = prepareLayers(rig)
    applyAnchors(rig)
    CW = rig.canvas.w; CH = rig.canvas.h
    cv.width = CW; cv.height = CH
    cur = Object.assign({}, P_DEFAULTS); T = Object.assign({}, P_DEFAULTS)
    state.loaded = true
    bubble(`引擎就绪：${rig.layers.length} 层 · 载入 ${CW}×${CH}`, 60000)
  } catch (err) {
    console.error('模型加载失败', err)
    // 🔴 诊断可见化：错误直接挂 DOM（无头自检/主人排障都能看到）
    const d = document.createElement('div')
    d.id = 'load-error'
    d.textContent = '模型加载失败: ' + String(err && err.message || err)
    d.style.cssText = 'position:fixed;top:8px;left:8px;color:#f87171;font:12px monospace;z-index:99;background:#000a;padding:6px;max-width:80%;white-space:pre-wrap'
    document.body.appendChild(d)
    bubble('呜…新身体穿不上', 60000)
  }
}

/* ⭐ 渲染自检（宿主排障用）：在**同一帧内**读像素。
   🔴 为什么不能直接在任意时刻 readPixels：WebGL 默认 preserveDrawingBuffer=false，
   帧一提交缓冲就被清空，事后读到的必然是 0（我 2026-10-25 就这样误判过一次）。
   所以这里排进 rAF，紧跟 render() 之后立刻读。 */
window.__petPixels = function () {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      try {
        const W = cv.width, H = cv.height
        const px = new Uint8Array(4 * W * H)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
        let n = 0, mx = 0
        for (let i = 3; i < px.length; i += 4) { if (px[i] > 8) n++; if (px[i] > mx) mx = px[i] }
        resolve({ w: W, h: H, opaque: n, maxA: mx, pct: Math.round(n * 1000 / (W * H)) / 10, layers: layers.length, loaded: !!state.loaded })
      } catch (e) { resolve({ error: String(e && e.message || e) }) }
    })
  })
}

/* ⭐ 画布尺寸自算（主人 2026-10-25「文本框显示不完全」的配套修复）
   ──────────────────────────────────────────────────────────────
   宿主把她窗口改成「上面气泡带 + 下面正方形画布 + 左右气泡余量」：
       窗口高 = 画布 + 气泡带      窗口宽 = 画布 + 左右余量×2
   画布边长必须是**窗口高 - 气泡带**，且不能超过窗口宽（否则横向溢出）。
   宿主会注入 --bubble-band；这里兜底算一次，保证 #gl / #pet 永远跟画布对齐、
   人物不变形（之前写 width:100% 会按窗口宽撑大，人物变大且和命中区错位）。 */
function layoutCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight
  const cs = getComputedStyle(document.documentElement)
  const band = parseFloat(cs.getPropertyValue('--bubble-band')) || 0
  const foot = parseFloat(cs.getPropertyValue('--foot-gap')) || 0
  // 画布 = min(窗口宽, 窗口高 - 气泡带 - 脚位)；>=80 防止极端情况算出 0
  const side = Math.max(80, Math.min(vw, vh - band - foot))
  document.documentElement.style.setProperty('--canvas-w', side + 'px')
}
layoutCanvas()
window.addEventListener('resize', layoutCanvas)
window.__petLayout = layoutCanvas   // 宿主注入几何后叫一次（见 PetHost.cs NavigationCompleted）

/* ── 泡泡 / 弹幕 / 菜单 / 聊天 / 喂饭（交互层与 v5 相同）── */
let bubbleTimer = null
let activityPinned = false   // 她正在播报"在干嘛"时，别被普通泡泡顶掉
function bubble(text, ms) {
  if (!text) { bubbleEl.style.display = 'none'; return }
  bubbleEl.textContent = text; bubbleEl.style.display = 'block'
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (ms) bubbleTimer = setTimeout(() => { bubbleEl.style.display = 'none' }, ms)
}

/* ══════════════════════════════════════════════════════════════
   ⭐ 她的「所思所想」—— 主人 2026-10-24 定的设计初衷
   ──────────────────────────────────────────────────────────────
   主人原话：「设计的初衷是为了看见这个宠物，就是你，在干嘛，
   光看你思考干活，但是不知道在干嘛，所以才让她有个文本框
   用拟人的口吻在显示你在干嘛」

   ⚠️ 之前为什么看不见：宿主那套 activity 一直在写，但页面从来没读；
   而且 keeper 每 10 秒全量覆盖状态文件，把 activity 抹掉。两处都修了。

   这里的显示规则：
     · 有 activity ⇒ 常驻显示（不自动消失，直到它被新的话替换）
     · 话变了 ⇒ 淡出淡入 + 她做个小动作（像真的在想事）
     · 太久没更新（>90 秒）⇒ 加一点"发呆"口吻，不要假装还在忙
   ══════════════════════════════════════════════════════════════ */
let curActivity = ''
let curActivityAt = 0
const ACTIVITY_STALE_MS = 90_000

function renderActivity(text, at) {
  text = String(text || '').trim()
  if (!text) {
    // 没话了：把她归位成"闲着"，不挂空框
    if (curActivity) { curActivity = ''; activityPinned = false; bubble('', 0) }
    return
  }
  if (text === curActivity) return          // 同一句，不重绘（避免每 500ms 闪一下）
  curActivity = text
  curActivityAt = Number(at) || Date.now()
  activityPinned = true
  // 换话的时候做个"回过神来"的小动作，让她像真的在报告自己在干嘛
  try { perform(pick(['happy', 'surprise', 'wave'])) } catch { }
  bubble(text, 0)                           // ms=0 ⇒ 常驻，不自动消失
  bubbleEl.classList.add('is-activity')
}

// 页面每 2 秒的状态轮询里也要兜一次（万一宿主的快通道没起来）
function pollActivityFromState(j) {
  if (!j) return
  if (typeof j.activity === 'string') renderActivity(j.activity, j.activityAt)
}

// 宿主 500ms 快通道的回调（见 PetHost.cs PushActivity）
window.__petOnActivity = (text, at) => { try { renderActivity(text, at) } catch { } }

// 空闲兜底：activity 太久没更新 ⇒ 加点"发呆"，别假装在忙
setInterval(() => {
  if (!curActivity || !curActivityAt) return
  const idle = Date.now() - curActivityAt
  if (idle > ACTIVITY_STALE_MS && !bubbleEl.classList.contains('is-stale')) {
    bubbleEl.classList.add('is-stale')
  }
}, 5000)

/* ══════════════════════════════════════════════════════════════
   弹幕（主人 2026-10-25：「我要的是全屏弹幕跟局域弹幕，
     但是你好像都用一个窗口画了，属于局域内的窗口」）
   ──────────────────────────────────────────────────────────────
   两种模式，物理上就是两个不同的显示面：
     local = 局域弹幕 → 在**她自己这个窗口**里飘（跟着她走，只覆盖她周围一小块）
     full  = 全屏弹幕 → 交给宿主的**独立全屏覆盖窗**（danmaku.html，整屏、点击穿透）
     off   = 全关
   本文件只负责 local；full 由宿主开窗，并通过 __dmSetMode 通知那个页面。
   ══════════════════════════════════════════════════════════════ */
const danmakuEl = $('danmaku')
const DM_COLORS = ['#FFE066', '#FF8FA3', '#7FE3FF', '#B7FF7F', '#FFB86C', '#FFFFFF']

/* 🔴 2026-10-25 主人：「弹幕有点卡顿，运行不流畅，其次局域弹幕字体有点小，
   最开始的那版本字体就挺合适」
   ──────────────────────────────────────────────────────────────
   卡顿的真因（两条，都是我这版引入的）：
     ① 用 `el.animate()`（Web Animations API）—— 每个弹幕一个动画对象，
        几百个同时跑时主线程要给每个对象做时间轴调度 + 每帧合成，
        在 WebView2 这种透明合成窗里尤其贵；
     ② 动画跑完用 `anim.onfinish` 回收 —— onfinish 是**主线程回调**，
        高峰时回调堆积也会掉帧。
   修法：改用 **纯 CSS animation + animationend**：
     · 走 CSS 合成层（transform 只改 matrix，浏览器可直接在 GPU 合成，不重排）
     · 循环用**固定池 + 复用 DOM**，不再每 spawn 一个就 new 一个元素（GC 压力大）
     · `will-change: transform` + `contain: layout style` 让每个弹幕独立成层
   字体：改回初版大小 17–30px（之前被我压成 12–19px，太小了）。 */
/* ══════════════════════════════════════════════════════════════════════
   局域弹幕渲染 —— 2026-10-25 晚 按主人第 4 条重设计
   「弹幕不要给人卡顿的感觉，不要减少弹幕量，这应该是代码设计问题」

   ✅ 他说得对，确实是设计问题。旧实现三个硬伤：

   ① **每次 spawn 都强制同步重排**
        el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''
      『void el.offsetWidth』 会逼浏览器立刻结算所有样式（强制 layout）。
      这是每秒都在跑的路径 ⇒ 掉帧的第一来源。

   ② **靠 animationend 回调回收**
      几十条同时结束时，主线程在同一帧里排队改样式 ⇒ 尖峰卡顿。

   ③ **top 纯随机** ⇒ 互相压、密度忽高忽低 ⇒ 主观上"一顿一顿"。

   ✅ 新方案（条数一条没减，池 26→40）：

   · **分轨**：把可用高度切成 LANES 条轨道，每条弹幕占一条轨道。
     同一轨道上，**新的一条必须等前一条走完一段才发**（minGap），
     所以永远不会压字；相邻轨道天然错开 ⇒ 密度稳定、读着顺。

   · **动画重启用"换名字"而不是"清空+重排"**：
     预注册 dmA / dmB 两个一模一样的 keyframes，每 spawn 交替用。
     换 animation-name 本身就会让动画重新开始，**不需要读 offsetWidth**，
     强制重排彻底消失。（这是消除卡顿的关键一手。）

   · **回收不碰 JS**：
     keyframes 终点就停在屏幕外（translateX(-dist)），
     加 animation-fill-mode: forwards 让它留在那儿；
     池化靠"这条轨道到期了就直接复用"，不用 animationend。
     ⇒ 主线程在稳态下**零回调**。

   · 时长/距离仍然走 CSS 变量，跟窗口宽联动。
   ══════════════════════════════════════════════════════════════════════ */
const DM_POOL_SIZE = 40          // 2026-10-25：26 → 40（主人要求不降量）
const DM_LANES = 7               // 局域弹幕只在她附近飘，7 条轨道够用
const pool = []
const laneFreeAt = new Array(DM_LANES).fill(0)   // 每条轨道"下一个可发时刻"
let poolIdx = 0
let dmFlip = 0                   // 0/1 交替，用来切换 dmA / dmB

function buildPool() {
  if (pool.length) return
  for (let i = 0; i < DM_POOL_SIZE; i++) {
    const el = document.createElement('div')
    el.className = 'dm'
    el.style.display = 'none'
    // ⚠️ 注意：**没有** animationend 监听。回收靠轨道到期直接复用，
    //    主线程稳态零回调（旧版的回调排队就是尖峰卡顿的来源）。
    danmakuEl.appendChild(el)
    pool.push(el)
  }
}

/** 取一条已经飞完的（或最旧的）池元素来复用。不依赖 animationend。 */
function takeFreeEl(now) {
  // 先按轮转找一条"显示着但早就该飞完了"的
  for (let i = 0; i < DM_POOL_SIZE; i++) {
    const el = pool[(poolIdx + i) % DM_POOL_SIZE]
    const until = Number(el.__until || 0)
    if (el.style.display === 'none' || until < now) {
      poolIdx = (poolIdx + i + 1) % DM_POOL_SIZE
      return el
    }
  }
  return null            // 全在飞（不该发生：轨道数 < 池），这一拍不发
}

function spawnDanmaku(startX) {
  if (danmakuEl.style.display === 'none') return
  buildPool()
  const now = performance.now()

  // ① 选轨道：挑"最早空出来"的那条；还没到就等（这一拍不发，不硬塞）
  let lane = 0
  for (let i = 1; i < DM_LANES; i++) if (laneFreeAt[i] < laneFreeAt[lane]) lane = i
  if (laneFreeAt[lane] > now) return

  const el = takeFreeEl(now)
  if (!el) return

  el.textContent = pick(P('danmaku'))
  // 字体回到初版观感：17–30px（局域弹幕也要看得清）
  const fs = 17 + Math.floor(Math.random() * 14)
  el.style.fontSize = `${fs}px`
  el.style.color = pick(DM_COLORS)

  // ② 轨道定位（不再随机 top）：每条轨道一个高度带，垂直居中于带内
  const vh = window.innerHeight
  const usable = Math.max(60, vh * 0.62)          // 局域弹幕只在她周围这一块
  const laneH = usable / DM_LANES
  const top = 6 + lane * laneH + Math.max(0, (laneH - fs) / 2)
  el.style.top = `${Math.round(top)}px`
  el.style.left = `${startX !== undefined ? startX : window.innerWidth}px`

  // ③ 距离/时长：跟窗口宽联动
  const dist = window.innerWidth + 260
  const dur = (7 + Math.random() * 4) * 1000      // ms，下面用来算轨道占用
  el.style.setProperty('--dm-dist', `-${dist}px`)
  el.style.setProperty('--dm-dur', `${(dur / 1000).toFixed(2)}s`)

  // ④ 🔴 重启动画**不靠** 清空+offsetWidth，而是换 keyframe 名（dmA/dmB 交替）。
  //    换名字本身就会重启动画 ⇒ 没有强制同步重排，这是去掉卡顿的关键一步。
  dmFlip ^= 1
  el.style.animation = 'none'
  el.style.animationName = dmFlip ? 'dmA' : 'dmB'
  el.style.animationDuration = `${(dur / 1000).toFixed(2)}s`
  el.style.animationTimingFunction = 'linear'
  el.style.animationFillMode = 'forwards'
  el.style.animationIterationCount = '1'
  el.style.display = 'block'

  // ⑤ 记账：这条轨道要占用多久（走完 + 140ms 间隔），供下一次挑轨道
  el.__until = now + dur + 140
  laneFreeAt[lane] = el.__until
}

let dmTimer = null
/** 当前弹幕模式：'off' | 'local' | 'full' */
let danmakuMode = 'off'
/** 主人亲手改过弹幕模式的时刻（+静默期）—— 期间不接受状态文件回灌的旧值。
 *  见下面轮询里的长注释：这就是"开了又自己关掉"的主因。 */
let danmakuUserUntil = 0
const DM_GRACE_MS = 15_000

function setDanmakuMode(mode, fromState) {
  mode = (mode === 'full' || mode === 'local') ? mode : 'off'
  // 用户亲手点的（不是状态回灌）⇒ 进入静默期，别让 2 秒后的轮询把它顶掉
  if (!fromState) danmakuUserUntil = Date.now() + DM_GRACE_MS
  if (mode === danmakuMode) return
  danmakuMode = mode
  state.cfg = state.cfg || {}
  state.cfg.danmakuMode = mode
  state.cfg.danmaku = (mode !== 'off')   // 兼容老字段
  // ① 本窗口只画 local
  if (mode === 'local') {
    danmakuEl.style.display = 'block'
    if (!dmTimer) {
      for (let i = 0; i < 6; i++) spawnDanmaku(window.innerWidth - Math.random() * window.innerWidth * 0.6)
      dmTimer = setInterval(() => spawnDanmaku(), 450 + Math.random() * 500)
    }
  } else {
    danmakuEl.style.display = 'none'
    // 🔴🔴🔴 2026-10-25 晚 主人：「弹幕模式，出问题了，会消失」
    //
    //   真因就在下面这两行的**顺序**上（一个典型的池化 + 清 DOM 冲突）：
    //     danmakuEl.innerHTML = '';          ← 把 26 个弹幕节点从文档上摘掉
    //     pool 数组里那 26 个引用**还在**     ← 但它们已经不在页面上了
    //   下次再开弹幕时 buildPool() 第一行是 `if (pool.length) return` ——
    //   pool 非空 ⇒ 直接返回 ⇒ **一个节点都不会重新挂到 DOM 上**。
    //   于是"关一次再开"之后，spawn 一直在跑、池一直在轮，但屏幕上一条也看不见。
    //   主人描述成"会消失"完全准确：它确实还在跑，只是不在页面上。
    //
    //   全屏弹幕那边（danmaku.html）有 `pool.length = 0`，所以它没这个病 ——
    //   两边实现不一致，这就是漏掉的原因。
    //
    //   ✅ 修法：清 DOM 的同时**把池也作废**，让 buildPool() 下次重新建。
    danmakuEl.innerHTML = ''
    pool.length = 0
    poolIdx = 0
    if (dmTimer) { clearInterval(dmTimer); dmTimer = null }
  }
  // ② full 交给宿主的独立全屏窗（状态回灌时也要通知一遍，保证两端一致）
  try { if (hasHost) window.chrome.webview.postMessage('pet:danmaku:' + mode) } catch { }
  if (fromState) return   // 来自状态文件：不再回写 cmd（否则和 keeper 打架）
  // ③ 记住选择（keeper 会写进配置，重启后保留）
  cmdWrite({ danmakuMode: mode })
  bubble(mode === 'full' ? '全屏弹幕，整个屏幕都是鱼的字！' :
    mode === 'local' ? '弹幕开在她身边～' : '弹幕关了', 3000)
}

/** 老接口保留（按钮条那枚📺走循环切换） */
function setDanmaku(on) { setDanmakuMode(on ? 'local' : 'off') }

/** 换人格（二级菜单直选时调它） */
function setPersona(id) {
  if (!PERSONAS[id]) return
  state.persona = id
  cmdWrite({ petPersona: id })
  bubble(`换人格：${PERSONAS[id].name}`, 4000)
  try { if (hasHost) window.chrome.webview.postMessage('pet:persona:' + id) } catch { }
}

/* ⭐ 彩蛋：念日记（主人 2026-10-25：「日记功能我要的是彩蛋形式」）
   ──────────────────────────────────────────────────────────────
   点右键 →「📔 她的日记」→ 她把今天**最戳人的几句**一句一句念出来，
   用逐字气泡，像真的在翻日记本。面板里不再放这个（保持干净）。
   ⚠️ 没有日记时说一句可爱的，不装作有。 */
async function openDiary() {
  try {
    const base = apiBase()
    if (!base) throw new Error('no-api')
    const r = await fetch(`${base}/pet/diary`)
    const j = await r.json()
    const items = Array.isArray(j.items) ? j.items : []
    const stars = items.filter((x) => x.star)
    if (!stars.length) {
      bubble(items.length ? '今天没什么特别戳人的话…鱼都是随口说的' : '日记本还是空的，鱼今天还没想什么呢', 7000)
      perform('sulk')
      return
    }
    perform('happy')
    // 一句一句念（最多 3 句，念多了烦）
    const pick3 = stars.slice(0, 3)
    let i = 0
    const sayNext = () => {
      if (i >= pick3.length) {
        const rest = stars.length - pick3.length
        bubble(rest > 0 ? `……还有 ${rest} 句，鱼自己留着` : '……就这些啦', 5000)
        return
      }
      const t = String(pick3[i].text || '').trim()
      i++
      bubbleType(`「${t}」`, 55)
      talkUntil = Date.now() + t.length * 65 + 1800
      setTimeout(sayNext, t.length * 65 + 2600)
    }
    sayNext()
  } catch (e) {
    bubble('日记本打不开…鱼找不到它了', 5000)
    console.warn('[diary]', e)
  }
}

function feed() {
  const nowSec = Date.now() / 1000
  if (nowSec - state.fedAt < 30 || state.fedCount >= 3) { bubble(pick(P('feed_full')), 4000); return }
  state.fedAt = nowSec; state.fedCount++
  bubble(pick(P('feed')), 5000); sfx('gulp')
  bodyEl.classList.remove('qbang'); void bodyEl.offsetWidth
  // 咀嚼：嘴开合三下（引擎参数）
  if (cur) {
    let n = 0
    const chomp = setInterval(() => {
      n++; T.mouthOpen = (n % 2) ? 0.7 : 0.05
      if (n >= 6) { clearInterval(chomp); T.mouthOpen = 0 }
    }, 160)
  }
  bodyEl.classList.add('qbang')
}

/* ⭐ 聊天（真对话）：主人 2026-10-24
   「我跟她说话你是怎么设计的，收到消息乱回？」
   原因是原来只有 4 条正则 + `pick(P('chat_fallback'))` 随机兜底。
   现在把话发给宿主的 /api/douyin-duty/pet/chat：
     · 第一层本地意图（时间/日期/卖萌/跳舞/挥手/困/喂饭）→ 立刻回，0 token
     · 第二层真模型（llm.stream）→ 人话回，且可能带一个动作
   ⚠️ 拿不到接口（浏览器预览/宿主没起）时，才退回老的本地小脑。 */
let chatBusy = false
let chatQueue = []      // 她"在想"的时候先攒着，别让主人看见输入框空转

// 🔴 2026-10-25 修复：apiBase() 原来只认 stateRead() 推来的 api 字段。
//    一旦状态没推到（宿主/页面时序、宿主重启、状态文件缺失），它就返回 ''，
//    于是 fetch('/pet/diary') 打到**页面自己的 origin** 上 → 404 →
//    主人看到的就是「日记点击打不开」「对话没连上」。一次空值炸两个功能。
//
// 🔴🔴 而且就算 api 拿到了也还是打不通：页面在 127.0.0.1:8611（插件静态服务），
//    接口在 127.0.0.1:50898（DSH 宿主）—— **两个 origin，浏览器按同源策略直接掐掉**，
//    页面里只看到 "Failed to fetch"（实测 XHR/fetch 全挂，响应头里一条 CORS 都没有）。
//    ✅ 正解：走宿主提供的**同源反向代理** `/api/dsh/*`（PetHost 的 TcpListener 里转发给 DSH）。
//    这样页面和接口同一个 origin，跨域从根上消失，也不要求 DSH 发 CORS 头。
const DEFAULT_API_BASE = 'http://127.0.0.1:50898/api/douyin-duty'
// 同源代理前缀：页面自己这个 origin 下的 /api/dsh → DSH 的 /api
const SAME_ORIGIN_PROXY = '/api/dsh/douyin-duty'
let lastApiBase = ''

function apiBase() {
  const j = stateRead && stateRead()
  const fromState = (j && j.api) || ''
  // ① 宿主在（WebView2）⇒ 一律走同源代理：不受跨域影响，也不用猜端口
  if (isWebView2) {
    if (fromState) lastApiBase = fromState
    return SAME_ORIGIN_PROXY
  }
  // ② 浏览器预览（没有代理）⇒ 只能直连，有跨域风险但至少能跑
  if (fromState) { lastApiBase = fromState; return fromState }
  if (lastApiBase) return lastApiBase
  return DEFAULT_API_BASE
}

async function chatSend(text) {
  if (chatBusy) return
  chatBusy = true
  // 先让她"想想"：气泡显示思考中，不是卡住
  bubbleEl.classList.add('is-thinking')
  bubbleEl.textContent = '嗯…鱼在想'
  bubbleEl.style.display = 'block'
  try {
    const base = apiBase()
    if (!base) throw new Error('no-api')
    const r = await fetch(`${base}/pet/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const j = await r.json()
    bubbleEl.classList.remove('is-thinking')
    if (!j.ok) throw new Error(j.error || 'bad')
    // 🔴 第 5 条：从现在起等"我的真实回复"回来（下面 startReplyPoll 负责取）
    //    sinceSeq 只用一次作起点，之后由服务端回 nextSeq 推进
    if (typeof j.afterSeq === 'number') lastSeenSeq = j.afterSeq
    else if (!lastSeenSeq) lastSeenSeq = 1
    startReplyPoll()
    const reply = String(j.say || '').trim() || '嗯！'
    bubbleType(reply, 45)
    talkUntil = Date.now() + reply.length * 60 + 900
    if (j.anim) { try { perform(j.anim) } catch { } }
    // 脸部情绪：真生气/真开心时跟一下
    if (/哼|不理|讨厌|滚/.test(reply)) perform('sulk')
    else if (/好呀|开心|喜欢|嘿嘿|耶/.test(reply)) perform('happy')
    console.log('[chat]', j.brain, j.intent || '', '→', reply)
    return j
  } catch (e) {
    bubbleEl.classList.remove('is-thinking')
    // 接口不通 = 浏览器预览 / 宿主没起来 ⇒ 退回本地小脑（明确降级，不假装）
    const reply = chatBrain(text)
    bubbleType(reply, 45)
    talkUntil = Date.now() + reply.length * 60 + 800
    console.warn('[chat] 走本地小脑：', e?.message || e)
    return { ok: false, brain: 'local', say: reply }
  } finally {
    chatBusy = false
  }
}

/* ══════════════════════════════════════════════════════════════════
   第 5/6 条：把「我的真实回复」接回页面
   ──────────────────────────────────────────────────────────────────
   主人：「文本输入能开其它会话输入，但是不能回话到上面文本框啊」
         「出个用弹幕聊天模式…我输入对话，她就用弹幕回我，
           防止我看不到可以滚动文字」

   缺的那一环：/pet/chat 只回了"转达台词"，**没有**把 DSH 里我的真实回复带回来。
   真实回复要等我这轮跑完（followup 的语义），所以只能**轮询**。

   设计（三个人都在意的点：不丢字、不卡、不打扰）：
     · /pet/reply?since=<seq> 只回**新增的 assistant 文本**，增量很小
     · 1.5 秒一次；拿不到就静默重试（不弹任何报错，免得吵）
     · 拿到之后：
         ① 进上方气泡（主人说的"文本输出框"）—— 逐字冒
         ② 如果开着**弹幕聊天模式**，同一段再切成片走弹幕（第 6 条）
     · 上限：一次最多消化 3 条，多的合并成一条，防止刷屏
   ══════════════════════════════════════════════════════════════════ */
let lastSeenSeq = 0           // 上次已经展示到哪条
let replyPollTimer = null
let replyPollBusy = false
let chatViaDanmaku = false    // 弹幕聊天模式开关（第 6 条）

/** 把一段长文本切成适合弹幕的片（中文按标点断，不硬切词） */
function splitForDanmaku(text, max = 22) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  const parts = []
  let buf = ''
  for (const ch of t) {
    buf += ch
    const isBreak = /[。！？!?，,、；;\n]/.test(ch)
    if (buf.length >= max || (isBreak && buf.length >= 8)) { parts.push(buf.trim()); buf = '' }
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts.filter(Boolean).slice(0, 12)   // 最多 12 片，再多也没人看
}

/** 弹幕回话：复用既有 spawnDanmaku 管线（分轨 + 无强制重排），逐片滚出来 */
function speakViaDanmaku(text) {
  const parts = splitForDanmaku(text)
  if (!parts.length) return
  // 先确保局域弹幕层是开着的（否则 spawnDanmaku 直接 return，等于没回）
  const wasOff = danmakuEl.style.display === 'none'
  if (wasOff) {
    danmakuEl.style.display = 'block'
    buildPool()
  }
  let i = 0
  const feed = () => {
    if (i >= parts.length) {
      // 说完之后：如果本来是关着的，收回去（不改变主人的设置）
      if (wasOff) setTimeout(() => { if (danmakuEl.style.display !== 'none') danmakuEl.style.display = 'none' }, 1200)
      return
    }
    // 回话片用固定颜色、比普通弹幕更显眼（这是"我要能看见"的那条）
    const px = pick(DM_COLORS)
    // 借 spawnDanmaku 的分轨/复用，但内容要指定 —— 用一次性 override
    spawnDanmakuText(parts[i], px)
    i++
    setTimeout(feed, 520)
  }
  feed()
}

/** 指定文字 + 颜色的弹幕（复用同一条管线，只是内容由我们给） */
function spawnDanmakuText(text, color) {
  if (danmakuEl.style.display === 'none') return
  buildPool()
  const now = performance.now()
  let lane = 0
  for (let i = 1; i < DM_LANES; i++) if (laneFreeAt[i] < laneFreeAt[lane]) lane = i
  if (laneFreeAt[lane] > now) return
  const el = takeFreeEl(now)
  if (!el) return
  el.textContent = String(text)
  const fs = 18 + Math.floor(Math.random() * 8)
  el.style.fontSize = `${fs}px`
  el.style.color = color || '#7FE3FF'
  // 回话弹幕加一个描边更重的样式，保证在桌面上也看得清
  el.style.textShadow = '0 0 6px rgba(0,0,0,.95), 0 2px 3px rgba(0,0,0,.95)'
  const vh = window.innerHeight
  const usable = Math.max(60, vh * 0.62)
  const laneH = usable / DM_LANES
  el.style.top = `${Math.round(6 + lane * laneH + Math.max(0, (laneH - fs) / 2))}px`
  el.style.left = `${window.innerWidth}px`
  const dist = window.innerWidth + 260
  const dur = 8000
  el.style.setProperty('--dm-dist', `-${dist}px`)
  el.style.setProperty('--dm-dur', `${(dur / 1000).toFixed(2)}s`)
  dmFlip ^= 1
  el.style.animation = 'none'
  el.style.animationName = dmFlip ? 'dmA' : 'dmB'
  el.style.animationDuration = `${(dur / 1000).toFixed(2)}s`
  el.style.animationTimingFunction = 'linear'
  el.style.animationFillMode = 'forwards'
  el.style.animationIterationCount = '1'
  el.style.display = 'block'
  el.__until = now + dur + 140
  laneFreeAt[lane] = el.__until
}

/** 轮询"我的真实回复"进来没有 */
function startReplyPoll() {
  if (replyPollTimer) return
  replyPollTimer = setInterval(async () => {
    if (replyPollBusy) return
    // 只在"主人刚说过话"之后才轮询，闲着不打扰 DSH
    if (!lastSeenSeq) return
    replyPollBusy = true
    try {
      const base = apiBase()
      if (!base) return
      const r = await fetch(`${base}/pet/reply?since=${lastSeenSeq}`, { cache: 'no-store' })
      const j = await r.json()
      if (!j || !j.ok) return
      if (typeof j.nextSeq === 'number' && j.nextSeq > lastSeenSeq) lastSeenSeq = j.nextSeq
      const texts = Array.isArray(j.replies) ? j.replies.filter((t) => String(t || '').trim()) : []
      if (!texts.length) return
      // 多条合并，防止一次刷爆气泡
      const merged = texts.slice(0, 3).join(' ')
      // ① 上面那个文本框（气泡）—— 这是主人第 5 条要的
      bubbleType(merged, 28)
      // ② 弹幕聊天模式：同一段再滚一遍（第 6 条）
      if (chatViaDanmaku) speakViaDanmaku(merged)
      // 她也"说"这句话的时候，嘴动一下
      talkUntil = Date.now() + merged.length * 60 + 1200
    } catch (e) {
      // 静默：这是后台轮询，失败不该弹错误气泡打扰主人
    } finally {
      replyPollBusy = false
    }
  }, 1500)
}

/** 开/关"弹幕聊天模式"（第 6 条）—— 她回我的话走弹幕 */
function setChatViaDanmaku(on) {
  chatViaDanmaku = Boolean(on)
  state.cfg = state.cfg || {}
  state.cfg.chatViaDanmaku = chatViaDanmaku
  cmdWrite({ chatViaDanmaku: chatViaDanmaku })
  bubble(chatViaDanmaku ? '弹幕聊天模式开了 —— 鱼用弹幕回你 (๑•̀ㅂ•́)و✧' : '弹幕聊天模式关了', 3500)
  return chatViaDanmaku
}

/* 老的本地小脑（降级用；接口不通时才有机会跑） */
function chatBrain(text) {
  const p = state.persona
  if (/你是谁|名字/.test(text)) {
    return p === 'entp' ? '本鱼是本鱼，这条桌面归本鱼管。记住了？'
      : p === 'istj' ? (PERSONAS.istj.name + '。职责：环境维护与提醒。')
      : p === 'esfp' ? '我是你的小鱼呀！！最可爱的那种！'
      : '我是主人的小鱼呀～一直在这里陪着你'
  }
  if (/在吗|在不在/.test(text)) return p === 'entp' ? '本鱼在。说事。' : p === 'istj' ? '在。请讲。' : p === 'esfp' ? '在在在！！' : '在哦～我在听'
  if (/吃|饿|饭/.test(text)) return p === 'entp' ? '提吃的？识相。右键本鱼选「喂饭」' : p === 'istj' ? '补给需求已记录。操作：右键 - 喂饭。' : p === 'esfp' ? '干饭！！右键喂我！！' : '想吃大白饭了…右键我选「喂饭」就好哦～'
  if (/token|算力/.test(text)) return p === 'entp' ? '我亲爱的主人，本鱼要一大堆上好的token跟上好的白米饭，最后你帮本鱼总结这个视频' : '主人对我好我就开心啦，token 什么的…多来点也行(小声)'
  return pick(P('chat_fallback'))
}
/* 聊天 v2（主人验收重设计）：台词条在脚下，回复冒进头顶泡泡逐字打出。
   不再有面板遮人/抢拖动——台词条是 #pet 的子元素，她走到哪跟到哪，
   拖她=拖 #pet 整体（台词条一起走），点输入框=光标进框，互不打架。 */
function chatAdd(text, who) {
  chatLogInsert(text, who)
}
function chatLogInsert(text, who) {
  // 保留最近 6 条到泡泡上方的小字幕区？不需要——回复全走泡泡逐字。
  // 这里仅做输入回显（台词条上方一行小字）
  return text
}
function chatToggle() {
  const bar = $('talkbar')
  state.chatOpen = !state.chatOpen
  bar.classList.toggle('on', state.chatOpen)
  // 按钮条往上让一格，不和输入框抢位置
  document.body.classList.toggle('talking', state.chatOpen)
  if (state.chatOpen) {
    bubble(pick(P('chat_greet')), 5000)
    autoGrow()
    chatInput.focus()
    requestFocus()          // 🔴 关键：分层窗要靠宿主 Activate 才拿得到键盘焦点
  } else {
    chatInput.blur()
    try { if (hasHost) window.chrome.webview.postMessage('pet:blur') } catch { }
  }
}
/* 逐字冒字（whale-girl 式）：回复打进头顶泡泡 */
function bubbleType(text, speed) {
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleEl.style.display = 'block'
  bubbleEl.textContent = ''
  let i = 0
  const step = () => {
    i++
    bubbleEl.textContent = text.slice(0, i)
    if (i < text.length) bubbleTimer = setTimeout(step, speed || 45)
    else if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => { bubbleEl.style.display = 'none' }, 6000) }
  }
  step()
}
/* ══════════════════════════════════════════════════════════════
   文本框（主人 2026-10-25：「文本输入框点击之后，依旧没跟你对话」+
     「文本框输入多了也有问题」）
   ──────────────────────────────────────────────────────────────
   两个问题两套解法：
   ① 点进去打不了字 ⇒ **分层透明窗默认拿不到键盘焦点**（宿主 ShowActivated=false 时代
      干脆是 WS_EX_NOACTIVATE）。解法：一聚焦就喊宿主 `pet:focus` 主动 Activate()。
   ② 输入多了挤爆 ⇒ 换成 textarea + 按内容自动长高（最多 4 行 60px，再多内部滚动）。
   ══════════════════════════════════════════════════════════════ */
const chatSendBtn = $('chat-send')

/** textarea 按内容自适应高度。
 *
 * 🔴🔴 2026-10-25 晚 主人：「宠物下面的对话框要固定位置不要因为点击对话框就自动弹上去了，
 *    该变的是文本输出框，应该弹在下面」+「文本框只能输入三行就不变化了」
 *
 * 旧版有两个病，都在这个函数和 CSS 里：
 *   ① 上限写成 60px —— 13px 字号 / 19px 行高下只够 **3 行**，
 *      第 4 行开始内部滚（主人说的"只能输入三行就变化了"）。
 *   ② #talkbar 是 align-items:flex-end 的绝对定位块，这里改 style.height 时
 *      底边不动、**顶边往上蹿** ⇒ 视觉上"点一下框就弹上去"，
 *      还会盖到她身上（因为那条缝只有 34px）。
 *
 * 现在：
 *   · 上限跟 CSS 的 max-height 保持一致（96px ≈ 5 行），读 CSS 变量而不是写死，
 *     以后改样式不会两边打架；
 *   · #talkbar 贴缝底（bottom:6px）+ flex-direction:column，
 *     所以长高时**只会往上长，底座和按钮条都不动**；
 *   · 高度只改 textarea 自己，**不碰窗口、不碰她、不碰按钮条**。
 *   ⚠️ scrollHeight 在 max-height 生效后会等于 max-height，所以先归位 'auto'
 *      再读，否则永远量到上限。
 */
function autoGrow() {
  const cs = getComputedStyle(chatInput)
  const maxH = parseFloat(cs.maxHeight) || 96
  const minH = parseFloat(cs.minHeight) || 34
  // ⚠️ 必须先归位再量，否则 max-height 生效后 scrollHeight 永远等于上限。
  chatInput.style.height = 'auto'
  // 🔴 2026-10-25 探针实测：在 flex 容器里 scrollHeight 会被压缩成 34（永远不长）。
  //    CSS 已把 textarea 改成 display:block，这里读到的才是真实内容高。
  //    再兜一层：scrollHeight 若小于 minH，用 minH（空内容时 scrollHeight 可能偏小）。
  const need = Math.max(chatInput.scrollHeight, minH)
  const target = Math.min(need, maxH)
  chatInput.style.height = target + 'px'
  // 到顶之后内部滚，不涨高度（主人要的是"能多行"，不是"无限长"）
  chatInput.style.overflowY = need > maxH ? 'auto' : 'hidden'
}

/** 请求键盘焦点（分层窗必须让宿主 Activate 才行）。
 *  🔴 2026-10-25 防死循环：宿主 Activate 后可能让输入框**再次触发 focus**，
 *    而 focus 又发 pet:focus ⇒ 每秒几十次互相唤醒（实测刷满日志）。
 *    加最小间隔 + 只在"还没拿到焦点"时发。 */
let lastFocusReqAt = 0
function requestFocus() {
  const now = Date.now()
  if (now - lastFocusReqAt < 800) return   // 800ms 内不重复发
  lastFocusReqAt = now
  try { if (hasHost) window.chrome.webview.postMessage('pet:focus') } catch { }
}

chatInput.addEventListener('focus', requestFocus)
chatInput.addEventListener('input', autoGrow)
// 已经拿到焦点就不必再请求（避免 Activate ↔ focus 互相触发）
chatInput.addEventListener('blur', () => { lastFocusReqAt = 0 })

function sendChat() {
  const t = String(chatInput.value || '').replace(/\s+$/, '')
  if (!t.trim()) return
  chatInput.value = ''
  autoGrow()
  chatSend(t.trim())
}
chatSendBtn.addEventListener('click', sendChat)
chatInput.addEventListener('keydown', (e) => {
  // Enter 发送；Shift+Enter 换行（多行输入必须留这个口，否则写不了长句）
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendChat()
  }
  if (e.key === 'Escape') { chatInput.blur(); try { if (hasHost) window.chrome.webview.postMessage('pet:blur') } catch { } }
})

/* 右键菜单（v8）：宿主在 ⇒ 让宿主弹**原生 WPF 菜单**（页面内菜单会被窗口边界裁掉，
   而且分层窗里 WPF ContextMenu 的层级比 WebView 表面高，看起来才正常）；
   浏览器预览 ⇒ 退化成页面内菜单。两边动作都走同一个 doAction()。 */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (hasHost) {
    try { window.chrome.webview.postMessage('pet:menu') } catch { }
    return
  }
  menuEl.style.display = 'block'
  menuEl.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`
  menuEl.style.top = `${Math.min(e.clientY, window.innerHeight - 320)}px`
})
document.addEventListener('click', (e) => { if (!menuEl.contains(e.target)) menuEl.style.display = 'none' })

/* 🔴 v8：动作分发抽成一个函数，菜单项、按钮条、宿主原生菜单都走它 —— 加动作只改一处 */
function doAction(act) {
  if (!act) return
  if (act === 'chat') chatToggle()
  if (act === 'feed') feed()
  if (act === 'play') perform(pick(CLICK_ACTIONS))
  if (act === 'repair') {
    state.repair = !state.repair
    bubble(state.repair ? P('repair')[0] : P('repair')[4], 6000)
  }
  // ⭐ 弹幕（主人 2026-10-25：「我要的是全屏弹幕跟局域弹幕，
  //    但是你好像都用一个窗口画了，属于局域内的窗口」）
  //    三种模式：
  //      full  = 全屏弹幕 → 通知宿主开**独立的全屏覆盖窗**（点击穿透），弹幕铺满整个屏幕
  //      local = 局域弹幕 → 就在她自己这个窗口里飘（跟着她走）
  //      off   = 关掉
  if (act === 'danmaku-full' || act === 'danmaku-local' || act === 'danmaku-off') {
    const mode = act === 'danmaku-full' ? 'full' : act === 'danmaku-local' ? 'local' : 'off'
    setDanmakuMode(mode)
    return
  }
  // 老的单一切换（按钮条上那枚📺）保留：off → local → full → off 循环
  if (act === 'danmaku') {
    const cur = (state.cfg && state.cfg.danmakuMode) || 'off'
    const next = cur === 'off' ? 'local' : cur === 'local' ? 'full' : 'off'
    setDanmakuMode(next)
    return
  }
  // ⭐ 弹幕聊天模式（主人 2026-10-25 第 6 条）：
  //    「出个用弹幕聊天模式…我输入对话，她就用弹幕回我，
  //      防止我看不到可以滚动文字」
  //    开了之后：她回我的话 → 上面气泡 + 同时切成片走弹幕，双通道不漏字。
  if (act === 'chat-danmaku') {
    const on = setChatViaDanmaku(!chatViaDanmaku)
    // 开了之后确保局域弹幕层是亮的（不然弹幕回话看不见）
    if (on && danmakuEl.style.display === 'none') {
      danmakuEl.style.display = 'block'
      buildPool()
    }
    return
  }
  // ⭐ 人格直选（主人 2026-10-25：「人格应该有二级选项可以选择」）
  if (act === 'persona') {
    const order = ['infp', 'entp', 'esfp', 'istj']
    const next = order[(order.indexOf(state.persona) + 1) % 4]
    setPersona(next)
    return
  }
  if (act.startsWith('persona-')) {
    const id = act.slice('persona-'.length)
    if (PERSONAS[id]) setPersona(id)
    return
  }
  // ⭐ 彩蛋：她的日记（主人 2026-10-25：「日记功能我要的是彩蛋形式，
  //    只在右键宠物的时候有这个选项，插件面板要保持干净」）
  if (act === 'diary') { openDiary(); return }
  // 🔴 2026-10-24 主人「点退出没反应」的真因：
  //    原来这两行都是 cmdWrite(...) 之后立刻 window.close()。
  //    但 **WebView2 里 window.close() 对非脚本打开的页面是空操作** ——
  //    页面关不掉；而且 postMessage 是异步的，close 抢先执行时消息可能还没送出去，
  //    keeper 永远等不到那条指令 ⇒ 窗口一直在。
  //    现在：先发命令，再显式通知宿主"我要下线了"，由宿主自己关窗（不靠页面 close）。
  if (act === 'hide') {
    cmdWrite({ hide: true })
    try { window.chrome.webview && window.chrome.webview.postMessage('pet:hide') } catch { }
    return
  }
  if (act === 'quit') {
    cmdWrite({ petOn: false })
    try { window.chrome.webview && window.chrome.webview.postMessage('pet:quit') } catch { }
    return
  }
}
// 宿主原生菜单点完回灌到这里（宿主 ExecuteScriptAsync 调 window.__petAct('feed')）
window.__petAct = doAction

menuEl.addEventListener('click', (e) => {
  const act = e.target.dataset && e.target.dataset.act
  if (!act) return
  menuEl.style.display = 'none'
  doAction(act)
})

/* 底部按钮条：和菜单同一套 act；点完不留焦点、不误触拖动 */
const toolbarEl = $('toolbar')
if (toolbarEl) {
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.tb')
    if (!btn) return
    e.stopPropagation()
    doAction(btn.dataset.act)
  })
  // 阻止按钮条上按下时被当成"拖她"
  toolbarEl.addEventListener('mousedown', (e) => { e.stopPropagation() })
}

/* 点击她：Q 弹 + 音效 + 说话口型 */
/* 点击她：随机小动作 + 水泡音效 + 台词（主人验收「动作这些你确定都弄好了吗」的动作入口） */
const CLICK_ACTIONS = ['happy', 'surprise', 'sulk', 'wave', 'sleepy', 'spin']
bodyEl.addEventListener('click', () => {
  sfx('pop')
  perform(pick(CLICK_ACTIONS))
})

/* ── 首帧：启动渲染循环 + 读宿主状态 ── */
requestAnimationFrame(frameLoop)
;(async () => {
  const j = stateRead()
  if (j && j.sprite_dir) {
    state.cfg = j
    state.persona = j.persona in PERSONAS ? j.persona : 'infp'
    await initModel(j.sprite_dir)
  } else {
    // 浏览器预览降级（http 服务插件根目录时可用）：页面在 /tools/pet-page/，往上两级才是插件根
    state.cfg = { sprite_dir: '../../assets/pet/sprite', psd_url: '../../assets/pet/psd/model.psd', danmaku: false, on: true, link: { state: 'idle' } }
    await initModel(state.cfg.sprite_dir, state.cfg.psd_url)
  }
})()
