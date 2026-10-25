// lib/pet-observe.mjs —— 她「看见主人在干什么」的眼睛
// ============================================================================
// 主人 2026-10-24 的原话（这就是这个文件的全部理由）：
//   「设计的初衷是为了看见这个宠物，就是你，在干嘛，光看你思考干活，
//     但是不知道在干嘛，所以才让她有个文本框用拟人的口吻在显示你在干嘛」
//   「我的意思是要像人一样」
//
// 所以光给她随机台词是不够的 —— 她得**真的知道你此刻在做什么**。
// DSH 有 sessionQuery 服务，可以读当前会话的最新事件（用户在说什么、
// 模型在调哪个工具、跑完没有）。这里把那些事件翻译成鱼的话。
//
// 🔴 三条原则：
//   ① 只读，绝不改会话（sessionQuery 全是读方法）
//   ② 重度失败就退回"看不见"，不编：宁可显示"鱼看不见主人在干嘛"，
//      也不许假装知道（主人最恨的就说谎）
//   ③ 翻译在**本地**做（模板 + 规则），不调模型 —— 每 10 秒调一次模型太贵
// ============================================================================

/** 把 DSH 会话事件翻译成一句"她在看主人干什么"。纯函数，可单测。 */
export function translateEvents(events = []) {
  if (!Array.isArray(events) || events.length === 0) return null
  // 从最新往回找，找到第一个能翻译的
  for (let i = events.length - 1; i >= 0 && i > events.length - 40; i--) {
    const ev = events[i]
    if (!ev || !ev.type) continue
    const d = ev.data || {}
    switch (ev.type) {
      case 'user/message': {
        const txt = textOf(d.message || d)
        if (!txt) continue
        // 主人刚发的这句，是她最该看见的
        return { kind: 'user-said', text: txt.slice(0, 60), say: pickLine('user-said', txt) }
      }
      case 'tool/call': {
        const name = String(d.name || '')
        if (!name) continue
        return { kind: 'tool', text: name, say: toolLine(name, d.arguments) }
      }
      case 'tool/result': {
        const isErr = d.error || (d.message && d.message.isError)
        return { kind: 'tool-result', text: isErr ? 'err' : 'ok', say: isErr ? '这一步没成…鱼跟着紧张了一下' : null }
      }
      case 'assistant/message': {
        const txt = textOf(d.message || d)
        if (!txt || txt.length < 4) continue
        return { kind: 'assistant', text: txt.slice(0, 60), say: null }
      }
      case 'turn/start':
        return { kind: 'turn-start', text: '', say: '主人交代事情了，鱼跟着看' }
      case 'turn/end':
        return { kind: 'turn-end', text: String(d.reason?.kind || ''), say: d.reason?.kind === 'completed' ? '这一轮干完了～' : null }
      case 'step/start':
        return { kind: 'step', text: '', say: '在一步步做事呢' }
      default:
        continue
    }
  }
  return null
}

function textOf(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim()
  }
  if (typeof m.text === 'string') return m.text
  return ''
}

const TOOL_CN = {
  read: '看文件', write: '写文件', edit: '改文件',
  glob: '找文件', grep: '搜代码', bash: '敲命令', pwsh: '敲命令',
  web_fetch: '上网查', web_search: '上网搜',
  task: '派活给子代理', subagent: '派活给子代理',
  ask_user_question: '在问主人问题',
  todo_write: '列计划', workflow: '跑工作流',
}

function toolLine(name, argsRaw) {
  const cn = TOOL_CN[name] || '在做一件事'
  let target = ''
  try {
    const a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    if (a) {
      const f = a.file_path || a.path || a.command || a.query || a.pattern || a.url
      if (typeof f === 'string') target = f.split(/[\\/]/).pop().slice(0, 24)
    }
  } catch { /* 参数不是 JSON 就算了，不影响说话 */ }
  const lines = {
    read: target ? `主人在看 ${target}` : '主人在翻文件',
    write: target ? `主人在写 ${target}` : '主人在写东西',
    edit: target ? `主人在改 ${target}` : '主人在改代码',
    grep: '主人在代码里翻找',
    glob: '主人在找文件',
    bash: '主人在跑命令',
    pwsh: '主人在跑命令',
    web_fetch: '主人上网查东西去了',
    web_search: '主人上网搜东西去了',
    ask_user_question: '主人在问事情，鱼等他说完',
    todo_write: '主人在列计划',
  }
  return lines[name] || (target ? `主人在弄 ${target}` : cn + '，鱼在旁边看')
}

const LINES = {
  'user-said': [
    (t) => `主人刚才说「${t}」，鱼听着呢`,
    (t) => `「${t}」——主人交代的，鱼记下了`,
    (t) => `主人说「${t}」，鱼跟着一起想`,
  ],
}

function pickLine(key, arg) {
  const arr = LINES[key]
  if (!arr || !arr.length) return null
  const f = arr[Math.floor(Math.random() * arr.length)]
  try { return f(String(arg || '').slice(0, 40)) } catch { return null }
}
