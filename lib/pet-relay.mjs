/**
 * lib/pet-relay.mjs —— 桌宠说的话怎么**真正送进 DSH 会话**
 * ============================================================================
 * 主人 2026-10-25 原话：「对话等同于我现在在这个窗口跟你对话，
 *   你怎么处理我的话就怎么处理我在上面文本框输入的话」
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 为什么单独抽成模块（前两次都在 index.js 里手写，两次都把会话写坏）
 *
 * v1：直接 session.append('user/message', {role, content})
 *     —— 漏了 `source`
 *     ⇒ 校验器："format v4 message requires a producer-owned source kind"
 *
 * v2：补了 source，**还是漏了 `id`**
 *     ⇒ 41 条消息无 id ⇒ 再打开会话就 "session event at seq 40214 lacks an
 *        identified message"，4 万条的会话整个读不开（主人踩到的那个）
 *     ⇒ 而且直接 append 会插在 "assistant 已发 tool-call / tool-result 还没回来"
 *        的中间 ⇒ 送给模型的 transcript 变成 assistant(tool-call) → user → tool，
 *        WorkBuddy 要求 tool-call 后必须紧跟 tool-result ⇒ 每轮 400，会话报废
 *
 * v3（本模块）：**不自己往日志里塞，交给 agent 的收件箱**
 *     agent.followup(message) 是 DSH 公开的排队接口：消息排到下一轮，
 *     由 agent 循环在**正确的边界**（这一轮结束之后）自己落盘、自己排序。
 *     我们只负责造一条**合法**消息 + 叫醒它。
 *     ⇒ 结构上不可能再拆开 tool-call/tool-result（我们压根没碰日志）
 *
 * 为什么能单测：全部依赖都从参数进来（注入 agents / 造消息函数），
 * 不在模块顶层抓 ctx。所以 `node tools/pet-relay-test.mjs` 能真跑一遍，
 * 不用重启 DSH 就能看证据。
 * ============================================================================
 */

/** 造一条合法 user 消息的**最低要求**（少一个就会被会话校验器判死） */
export const REQUIRED_FIELDS = ['id', 'role', 'source', 'content']

/**
 * 不依赖 dsh-llm 也能用的等价实现。
 * ⚠️ id 一定要有 —— 这是 v2 把主人会话写死的直接原因。
 * @param {{content:Array, source:object, uuid?:()=>string}} input
 */
export function makeUserMessage(input) {
  const uuid = input.uuid || (() => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : ((r & 0x3) | 0x8)
      return v.toString(16)
    })
  })
  return {
    id: uuid(),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}

/** 自检一条消息够不够格进会话日志。返回 null = 合格，否则返回原因。 */
export function validateUserMessage(msg) {
  if (!msg || typeof msg !== 'object') return '消息不是对象'
  for (const f of REQUIRED_FIELDS) if (msg[f] === undefined || msg[f] === null || msg[f] === '') return `缺字段 ${f}`
  if (typeof msg.id !== 'string') return 'id 不是字符串'
  if (msg.role !== 'user') return 'role 不是 user'
  if (typeof msg.source !== 'object' || typeof msg.source.kind !== 'string' || !msg.source.kind) return 'source.kind 缺失'
  if (!Array.isArray(msg.content)) return 'content 不是数组'
  const text = msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
  if (!text.trim()) return 'content 里没有文字'
  return null
}

/**
 * 从一组 live agent 里挑"主人正在说话的那个"。
 * 顶层（没有父 agent）优先 —— 子代理的会话送进去没人读。
 * @param {Array} list   agents.list()
 * @param {Array} [roots] agents.roots()（给了就用它当"顶层"）
 */
export function pickTargetAgent(list, roots) {
  if (!Array.isArray(list) || !list.length) return null
  const rootList = Array.isArray(roots) ? roots.filter(Boolean) : []
  if (rootList.length) return rootList[rootList.length - 1]   // 最近注册的顶层
  // 没有 roots()：退而求其次，挑"没有父 agent"的
  const pool = list.filter((a) => a && !a.parentAgent && !a.options?.parentId)
  if (pool.length) return pool[pool.length - 1]
  // 实在判不出来：宁可不送（送进子代理会话等于丢进黑洞）
  return null
}

/**
 * ⭐ 把一句话送进 DSH 会话。
 *
 * @param {object} opts
 * @param {string} opts.text  主人（通过桌宠）说的话
 * @param {object} opts.agents  agents 服务（要有 list()/roots()）或直接给数组
 * @param {Function} [opts.createUserMessage]  宿主那份 createUserMessage（优先用，行为最一致）
 * @param {Function} [opts.uuid]  造 id 用（测试可注入固定值）
 * @returns {{ok:boolean, sessionId?:string, mode?:string, queued?:boolean,
 *            runningNow?:boolean, reason?:string}}
 */
export function deliverToSession({ text, agents, createUserMessage, uuid } = {}) {
  const say = String(text ?? '')
  if (!say.trim()) return { ok: false, reason: '空的' }

  // ① 找服务
  if (!agents) return { ok: false, reason: 'agents 服务不可用（这个窗口的会话没起来）' }

  // ② 找目标 agent
  let list = []
  let roots = []
  try {
    if (Array.isArray(agents)) list = agents
    else {
      if (typeof agents.list === 'function') list = agents.list() || []
      if (typeof agents.roots === 'function') roots = (agents.roots() || []).filter(Boolean)
    }
  } catch (e) {
    return { ok: false, reason: '读 agents 列表失败：' + String(e?.message ?? e) }
  }
  const target = pickTargetAgent(list, roots)
  if (!target) return { ok: false, reason: list.length ? '只有子代理会话，没有主会话' : '没有 live agent' }
  const sid = String(target.id || target.session?.id || '')
  if (!sid) return { ok: false, reason: 'agent 没有 id' }
  if (typeof target.followup !== 'function') return { ok: false, reason: 'agent 不支持 followup（宿主版本太旧）' }

  // ③ 造消息（三个字段一个都不能少）
  const rpcId = `pet-relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const content = [{ type: 'text', text: say }]
  const source = { kind: 'user', rpcId }
  let msg
  try {
    msg = createUserMessage ? createUserMessage({ content, source }) : makeUserMessage({ content, source, uuid })
  } catch (e) {
    return { ok: false, reason: '造消息失败：' + String(e?.message ?? e) }
  }
  const bad = validateUserMessage(msg)
  if (bad) {
    // 🔴 宁可不送，也不能再写一条把主人会话搞坏的消息
    return { ok: false, reason: `消息不合格（${bad}）—— 拒绝投递，上次就是这么把会话写死的` }
  }

  // ④ 交给 agent 排队（它自己在正确边界落盘）
  const runningNow = (() => { try { return target.status === 'running' } catch { return false } })()
  try {
    target.followup(msg)
  } catch (e) {
    return { ok: false, reason: 'followup 失败：' + String(e?.message ?? e) }
  }
  return { ok: true, sessionId: sid, mode: 'followup', queued: true, runningNow }
}

/** 她转达之后该说哪一句（🔴 不许骗主人说"他正在回你"） */
export function relayLine(runningNow, pick = (a) => a[0]) {
  return runningNow
    ? pick(['他这轮还在跑，鱼把话搁他桌上了', '排上队了，等他这一轮跑完就看得见'])
    : pick(['好，鱼这就去跟他说', '记下了，转达过去啦', '嗯嗯，鱼把话带过去'])
}
