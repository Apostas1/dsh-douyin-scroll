/**
 * tools/panel-render-check.mjs —— 在 Node 里把 client.js 真**渲染**一遍（不装 DSH）
 * ============================================================================
 * 为什么要有它：
 *   面板整块的消失，过去全是"某个组件在渲染时抛错"引起的（TDZ / undefined / 拼错字段）。
 *   `node --check` 只能查语法，查不出这类运行时错误 —— 2026-10-22 那次「重启多少次都看不见面板」
 *   就是 import 阶段炸的，语法检查照样通过。
 *   这里用一套**极小的 React 替身**（createElement / useState / useEffect / class）
 *   把 Panel 真的执行一遍，然后走一遍元素树，确认每块卡片都在。
 *
 * 用法：node tools/panel-render-check.mjs      （selfcheck 4j 段会调它）
 * 退出码 0 = 渲染通过。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/* ── 极简 React 替身 ── */
let hooks = []
let hookIdx = 0
let rerender = null

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length ? (children.length === 1 ? children[0] : children) : undefined } }
  },
  useState(init) {
    const i = hookIdx++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(hooks[i]) : v
      if (JSON.stringify(next) !== JSON.stringify(hooks[i])) { hooks[i] = next; rerender?.() }
    }
    return [hooks[i], set]
  },
  useEffect(fn) {
    const i = hookIdx++
    if (!(i in hooks)) { hooks[i] = true; fn() }
  },
  useRef(init) {
    const i = hookIdx++
    if (!(i in hooks)) hooks[i] = { current: init }
    return hooks[i]
  },
  Component: class { constructor(props) { this.props = props; this.state = {} } setState(p) { Object.assign(this.state, p); rerender?.() } },
}

/* ── DOM 替身 ── */
const made = []
globalThis.document = {
  createElement: (tag) => { const el = { tag, style: {}, setAttribute() {}, appendChild() {}, remove() {} }; made.push(el); return el },
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
  execCommand: () => true,
}

/* ── fetch 替身：把三个接口的返回写死 ── */
const MOCK = {
  '/api/douyin-duty/status': {
    ok: true, version: '9.9.9', home: 'H:/dy', loggedIn: true, venvReady: true,
    pickedToday: 2, report: 'H:/dy/out/2026-10-22.md', installing: false,
  },
  '/api/douyin-duty/config': {
    ok: true,
    config: {
      perDay: 5, maxPerRun: 12, noon: true, night: true, keywords: ['猫', '搞笑'],
      windows: [{ start: '09:00', end: '11:00', label: '上午' }],
    },
  },
  '/api/douyin-duty/update': {
    ok: true, current: '9.9.9', latest: '9.9.9', checked: true, hasUpdate: false, source: 'npm registry', tried: [],
  },
  '/api/douyin-duty/ai-usage': {
    ok: true, doc: '# 使用说明',
    mcp: { server: 'H:/dy/tools/mcp-server.mjs', exists: true, selfTest: 'node ".../mcp-server.mjs" --selftest', configText: '{\n  "mcpServers": {}\n}' },
  },
  '/api/douyin-duty/report': { ok: true, text: '# 报告\n### 7401234567890123401' },
}
globalThis.fetch = async (url) => {
  const path = String(url).split('?')[0]
  const body = MOCK[path]
  if (!body) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => body }
}
const fakeNavigator = { clipboard: { writeText: async () => {} } }
globalThis.window = { __ModuleLoader__: {}, navigator: fakeNavigator }

/* ── 加载 client.js（它是给浏览器写的自注册脚本）── */
let mod = null
globalThis.window.__ModuleLoader__.load = (def) => {
  mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('未知依赖：' + name)
  })
}
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'navigator', 'fetch', src)(
  globalThis.window, globalThis.document, fakeNavigator, globalThis.fetch,
)
if (!mod) throw new Error('client.js 没有调用 __ModuleLoader__.load')

/* ── 把注册到 settings.section 的组件抓出来 ── */
let Registered = null
const ctx = {
  effect: (fn) => { try { fn() } catch { /* 清理函数 */ } },
  get: (k) => (k === 'slots' ? {
    inject: (slot, fn) => fn(),
    register: (_meta, comp) => { Registered = comp; return () => {} },
  } : undefined),
}
mod.apply(ctx)
if (!Registered) throw new Error('apply() 没有往 settings.section 注册组件')

/* ── 迷你渲染器 ── */
const isClass = (t) => typeof t === 'function' && t.prototype && typeof t.prototype.render === 'function'

function render(el) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(render)
  const { type, props } = el
  if (typeof type === 'function') {
    if (isClass(type)) {
      const inst = new type(props || {})
      const out = inst.render()
      return render(out)
    }
    return render(type(props || {}))
  }
  const kids = props?.children
  return { tag: String(type), props: props || {}, children: kids === undefined ? [] : [].concat(render(kids)).flat(Infinity).filter((x) => x !== null) }
}

/** 把元素树拍平成 [tag, text] 便于检查 */
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  if (typeof node === 'string') { out.push({ tag: '#text', text: node }); return out }
  out.push({ tag: node.tag, text: '', props: node.props })
  for (const c of node.children || []) walk(c, out)
  return out
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }

let tree = null
let renders = 0
rerender = () => { renders++ }
hooks = []

// 第一遍：会显示"读设置中…"
tree = render(React.createElement(Registered, {}))
await flush()
// 第二遍：状态已经填好，出完整面板
hookIdx = 0
tree = render(React.createElement(Registered, {}))
await flush()
hookIdx = 0
tree = render(React.createElement(Registered, {}))
await flush()

const flat = walk(tree)
const allText = flat.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
const allProps = flat.map((n) => n.props || {})

const must = [
  ['状态卡：刷抖音标题', /刷抖音/],
  ['现在跑一轮按钮', /现在跑一轮/],
  ['开始使用（三步装机）', /开始使用/],
  ['① 检查环境', /① 检查环境/],
  ['② 装依赖', /② 装依赖/],
  ['刷什么（关键词）', /刷什么/],
  ['什么时候自己跑', /什么时候自己跑/],
  ['中午谷时', /中午谷时/],
  ['晚上谷时', /晚上谷时/],
  ['自定义时段', /自定义时段/],
  ['自定义时段里的时间输入框', /09:00/],
  ['+ 加一个时段', /\+ 加一个时段/],
  ['保存时段', /保存时段/],
  ['给别的 AI 用', /给别的 AI 用/],
  ['MCP 配置说明', /MCP server/],
  ['关于 / 检查更新', /检查更新/],
  ['版本号', /v9\.9\.9/],
]

let fail = 0
console.log(`渲染了 ${renders} 次状态更新，元素树 ${flat.length} 个节点\n`)
for (const [label, re] of must) {
  if (re.test(allText)) console.log(`  ✅ ${label}`)
  else { console.log(`  ❌ ${label} —— 渲染结果里找不到 ${re}`); fail++ }
}

// 结构检查：卡片数量、时间输入框数量
const cards = flat.filter((n) => n.props && 'data-dy-card' in n.props)
const timeInputs = flat.filter((n) => n.tag === 'input' && n.props && n.props.type === 'time')
console.log(`\n卡片 ${cards.length} 个 / 时间输入框 ${timeInputs.length} 个`)
if (cards.length < 6) { console.log('  ❌ 卡片少于 6 块，可能有一块没渲染出来'); fail++ }
else console.log('  ✅ 卡片齐全')
if (timeInputs.length !== 2) { console.log(`  ❌ 时间输入框应为 2 个（一个时段），实际 ${timeInputs.length}`); fail++ }
else console.log('  ✅ 一个自定义时段 = 两个时间输入框')

// 事件处理器检查：所有 onClick 必须是函数（写错成 onClick: foo() 会立刻执行）
const badHandlers = flat.filter((n) => n.props && 'onClick' in n.props && typeof n.props.onClick !== 'function')
if (badHandlers.length) { console.log(`  ❌ ${badHandlers.length} 个 onClick 不是函数`); fail++ }
else console.log('  ✅ 所有 onClick 都是函数')

/* ── 点一遍按钮：光"能显示"不够，按钮真跑起来也得不出错 ──
 * 这一段把三个异步动作真的 await 一遍：
 *   ① 检查更新  ② 看接入方式（MCP）  ③ 看报告
 * 每个按钮的 onClick 直接调，不用模拟事件 —— 我们要验的是**数据回来之后能不能渲染**。
 */
const findBtn = (label) => flat.find((n) => n.tag === 'button' &&
  String(([].concat(n.props?.children ?? []).flat(Infinity).join(''))).includes(label))

const clickAndRender = async (label) => {
  const btn = findBtn(label)
  if (!btn) { console.log(`  ❌ 找不到按钮「${label}」`); fail++; return }
  try {
    await btn.props.onClick({ target: { value: '' } })
  } catch (e) {
    console.log(`  ❌ 点「${label}」抛错：${e?.message ?? e}`); fail++; return
  }
  await flush()
  hookIdx = 0
  const t = render(React.createElement(Registered, {}))
  await flush()
  const f = walk(t)
  const txt = f.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
  console.log(`  ✅ 点「${label}」没抛错，渲染 ${f.length} 节点`)
  return { tree: t, flat: f, text: txt }
}

console.log('\n点按钮实测：')
const rUpdate = await clickAndRender('检查更新')
if (rUpdate) {
  if (/已是最新版|有新版本|查不到最新版本/.test(rUpdate.text)) console.log('  ✅ 检查更新结果渲染出来了')
  else { console.log('  ❌ 检查更新后没有结果文案'); fail++ }
}
const rAi = await clickAndRender('看接入方式')
if (rAi) {
  if (/mcpServers/.test(rAi.text)) console.log('  ✅ MCP 配置渲染出来了')
  else { console.log('  ❌ 看接入方式后没有 MCP 配置'); fail++ }
  if (/复制 MCP 配置/.test(rAi.text)) console.log('  ✅ 有复制按钮')
  else { console.log('  ❌ 没有复制按钮'); fail++ }
}
const rRep = await clickAndRender('看报告')
if (rRep) {
  if (/7401234567890123401/.test(rRep.text)) console.log('  ✅ 报告内容渲染出来了')
  else { console.log('  ❌ 报告没渲染出来'); fail++ }
}

console.log(fail ? `\n渲染检查：${fail} 项失败` : '\n渲染检查：全部通过')
process.exitCode = fail ? 1 : 0
