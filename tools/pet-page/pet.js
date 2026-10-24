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
const chatEl = $('chat')
const chatLog = $('chat-log')
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

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const P = (k) => (PERSONAS[state.persona] || PERSONAS.infp)[k] || []

/* ── preload 桥（缺了=浏览器预览降级） ── */
const bridge = window.dshpetBridge || null
function cmdWrite(obj) { if (bridge && bridge.cmdWrite) bridge.cmdWrite(obj); else console.log('[cmd]', obj) }
function stateRead() { return bridge && bridge.stateRead ? bridge.stateRead() : null }
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
  // 平滑到当前值
  const kSmooth = 1 - Math.exp(-dt * 14)
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

/* ── 状态轮询（2s）+ 弹幕开关 ── */
setInterval(() => {
  const j = stateRead()
  if (!j) return
  if (j.on === false) { window.close && window.close(); return }
  if (!state.loaded && j.sprite_dir) { initModel(j.sprite_dir) }
  if (!state.repair) {
    const link = (j.link && j.link.state) || 'idle'
    const nowSec = Date.now() / 1000
    if ((link === 'run' || link === 'watch' || link === 'error') && nowSec - state.lastAutoAt > 30) {
      bubble(pick(P(link)), 5000); state.lastAutoAt = nowSec
    }
  }
  const wantDm = j.danmaku === true
  $('danmaku').style.display = wantDm ? 'block' : 'none'
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

/* ── 泡泡 / 弹幕 / 菜单 / 聊天 / 喂饭（交互层与 v5 相同）── */
let bubbleTimer = null
function bubble(text, ms) {
  if (!text) { bubbleEl.style.display = 'none'; return }
  bubbleEl.textContent = text; bubbleEl.style.display = 'block'
  if (bubbleTimer) clearTimeout(bubbleTimer)
  if (ms) bubbleTimer = setTimeout(() => { bubbleEl.style.display = 'none' }, ms)
}

const danmakuEl = $('danmaku')
function spawnDanmaku(startX) {
  if (danmakuEl.style.display === 'none') return
  const el = document.createElement('div')
  el.className = 'dm'; el.textContent = pick(P('danmaku'))
  el.style.fontSize = `${15 + Math.floor(Math.random() * 12)}px`
  el.style.top = `${20 + Math.random() * (window.innerHeight - 90)}px`
  el.style.left = `${startX !== undefined ? startX : window.innerWidth}px`
  const colors = ['#FFE066', '#FF8FA3', '#7FE3FF', '#B7FF7F', '#FFB86C', '#FFFFFF']
  el.style.color = pick(colors)
  danmakuEl.appendChild(el)
  const dur = 6 + Math.random() * 7
  const anim = el.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${window.innerWidth + 200}px)` }], { duration: dur * 1000, easing: 'linear' })
  anim.onfinish = () => el.remove()
}
let dmTimer = null
function setDanmaku(on) {
  danmakuEl.style.display = on ? 'block' : 'none'
  if (on && !dmTimer) {
    for (let i = 0; i < 12; i++) spawnDanmaku(window.innerWidth - Math.random() * window.innerWidth * 0.7)
    dmTimer = setInterval(() => spawnDanmaku(), 350 + Math.random() * 450)
  } else if (!on && dmTimer) { clearInterval(dmTimer); dmTimer = null; danmakuEl.innerHTML = '' }
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

/* 聊天（本地人格小脑） */
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
function chatAdd(text, who) {
  const d = document.createElement('div')
  d.className = who; d.textContent = text
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight
}
function chatToggle() {
  state.chatOpen = !state.chatOpen
  chatEl.style.display = state.chatOpen ? 'block' : 'none'
  if (state.chatOpen) {
    $('chat-title').textContent = PERSONAS[state.persona].name
    chatLog.innerHTML = ''; chatAdd(pick(P('chat_greet')), 'them'); chatInput.focus()
  }
}
$('chat-send').addEventListener('click', () => {
  const t = chatInput.value.trim(); if (!t) return
  chatInput.value = ''
  chatAdd(`你：${t}`, 'me')
  const reply = chatBrain(t)
  chatAdd(`${PERSONAS[state.persona].name.split(' ')[0]}：${reply}`, 'them')
  bubble(reply, 6000)
  talkUntil = Date.now() + 1600   // 她张嘴「说」这句话
})
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('chat-send').click() })

/* 右键菜单 */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  menuEl.style.display = 'block'
  menuEl.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`
  menuEl.style.top = `${Math.min(e.clientY, window.innerHeight - 320)}px`
})
document.addEventListener('click', (e) => { if (!menuEl.contains(e.target)) menuEl.style.display = 'none' })
menuEl.addEventListener('click', (e) => {
  const act = e.target.dataset && e.target.dataset.act
  if (!act) return
  menuEl.style.display = 'none'
  if (act === 'chat') chatToggle()
  if (act === 'feed') feed()
  if (act === 'repair') {
    state.repair = !state.repair
    bubble(state.repair ? P('repair')[0] : P('repair')[4], 6000)
  }
  if (act === 'danmaku') {
    const nv = !(state.cfg && state.cfg.danmaku)
    cmdWrite({ danmaku: nv })
    state.cfg = state.cfg || {}; state.cfg.danmaku = nv
    setDanmaku(nv)
  }
  if (act === 'walk') { const nv = !(state.cfg && state.cfg.walk); cmdWrite({ walk: nv }); state.cfg.walk = nv }
  if (act === 'persona') {
    const order = ['infp', 'entp', 'esfp', 'istj']
    const next = order[(order.indexOf(state.persona) + 1) % 4]
    cmdWrite({ petPersona: next })
    state.persona = next
    bubble(`换人格：${PERSONAS[next].name}`, 4000)
  }
  if (act === 'hide') { cmdWrite({ hide: true }); window.close && window.close() }
  if (act === 'quit') { cmdWrite({ petOn: false }); window.close && window.close() }
})

/* 点击她：Q 弹 + 音效 + 说话口型 */
bodyEl.addEventListener('click', () => {
  sfx('pop')
  bodyEl.classList.remove('qbang'); void bodyEl.offsetWidth; bodyEl.classList.add('qbang')
  bubble(pick(P('click')), 4000)
  talkUntil = Date.now() + 800
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
    state.cfg = { sprite_dir: '../../assets/pet/sprite', psd_url: '../../assets/pet/psd/model.psd', walk: true, danmaku: false, on: true, link: { state: 'idle' } }
    await initModel(state.cfg.sprite_dir, state.cfg.psd_url)
  }
})()
