/**
 * tools/pet-relay-test.mjs —— 桌宠对话投递的**离线实测**（不用重启 DSH）
 * ============================================================================
 * 为什么要这个：前两次投递的 bug 都是"写坏了会话"，而它们**只有在重新打开
 * 会话时才炸** —— 写完当场毫无反应。所以必须有一套不依赖 DSH 运行时的检查，
 * 能在改完代码的下一秒就告诉你"这条路安不安全"。
 *
 * 它做三件事：
 *   ① 用假的 agents 服务跑 deliverToSession，看它是否调用 followup（而不是
 *      自己往 session 里 append）
 *   ② 把投递出来的消息喂给 **DSH 自己的** adoptSessionEvent 校验
 *      ⇒ 证明"它造得出合法消息"（这是 v1/v2 两次翻车的点）
 *   ③ 断言失败路径：缺 id / 缺 source / 空文本 / 没有 live agent 时
 *      **必须拒绝投递**，不许"尽力而为"
 *
 * 退出码 0 = 全过。
 * ============================================================================
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { deliverToSession, makeUserMessage, validateUserMessage, pickTargetAgent, relayLine, pickClientTimeZone } from '../lib/pet-relay.mjs';

/**
 * 🔴 找 DSH 的 node_modules 根 —— **不写死任何人的本机路径**（公开仓库带路径 = 泄露机器信息）。
 * 顺序：环境变量 → DSH_HOME → 常见安装位置 → 找不到就跳过"用宿主校验器验证"那步。
 */
function findModulesRoot() {
  const cands = []
  if (process.env.DSH_MODULES_ROOT) cands.push(process.env.DSH_MODULES_ROOT)
  if (process.env.DSH_HOME) {
    cands.push(path.join(process.env.DSH_HOME, 'extracted-asar', 'dsh', 'node_modules'))
    cands.push(path.join(process.env.DSH_HOME, 'node_modules'))
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'DeepSeek', 'dsh-data', 'extracted-asar', 'dsh', 'node_modules'))
  }
  if (home) cands.push(path.join(home, '.dsh', 'node_modules'))
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, '@deepseek-ai', 'dsh-session'))) return c
  }
  return ''
}

const modulesRoot = findModulesRoot();
let adoptSessionEvent = null;
if (modulesRoot) {
  try {
    const sess = await import(pathToFileURL(path.join(modulesRoot, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href);
    adoptSessionEvent = sess.adoptSessionEvent;
  } catch (e) {
    console.log(`⚠️  拿不到 DSH 的 dsh-session（${e.message}）—— 跳过"用宿主校验器验证"那步`);
  }
} else {
  console.log('⚠️  没找到 DSH 的 node_modules —— 跳过"用宿主校验器验证"那步');
  console.log('    （想验就设 DSH_MODULES_ROOT 或 DSH_HOME 环境变量）');
}

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) };
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) };

/** 假的 agent */
function fakeAgent({ id = 'session-test', status = 'idle', hasFollowup = true, parentAgent = undefined } = {}) {
  const rec = { called: 0, lastMsg: null };
  const a = {
    id,
    status,
    session: { id },
    parentAgent,
    followup(msg) { rec.called++; rec.lastMsg = msg },
  };
  if (!hasFollowup) delete a.followup;
  return { agent: a, rec };
}

console.log('1. 投递路径：必须走 followup，不许自己往日志里塞');
{
  const { agent, rec } = fakeAgent()
  const r = deliverToSession({ text: '主人让小鱼转一句话', agents: [agent] })
  if (r.ok) ok('投递成功'); else bad('投递失败：' + r.reason)
  if (r.mode === 'followup') ok('走的是 followup（不是 session.append）'); else bad('mode 不是 followup：' + r.mode)
  if (rec.called === 1) ok('agent.followup 被调用了一次'); else bad(`followup 调用 ${rec.called} 次`)
  if (rec.lastMsg && rec.lastMsg.role === 'user') ok('排进去的是 user 消息'); else bad('排进去的不是 user 消息')
  const txt = (rec.lastMsg?.content ?? []).map((b) => b.text).join('')
  if (txt === '主人让小鱼转一句话') ok('正文一字不差（中文没有变形）'); else bad('正文不对：' + JSON.stringify(txt))
}

console.log('\n2. 这条消息过不过得了 DSH 自己的校验（v1/v2 就是死在这）');
{
  const { agent, rec } = fakeAgent()
  deliverToSession({ text: '校验一下这条消息', agents: [agent] })
  const msg = rec.lastMsg
  if (!msg) { bad('没造出消息'); }
  else {
    if (typeof msg.id === 'string' && msg.id.length > 0) ok('有 id：' + msg.id.slice(0, 8) + '…')
    else bad('没有 id —— 这就是 seq 40214 那条把会话写死的错')
    if (msg.source && msg.source.kind === 'user') ok(`source.kind = ${msg.source.kind}`)
    else bad('source 缺失或 kind 不对')
    if (msg.source && String(msg.source.rpcId || '').startsWith('pet-relay')) ok('带 rpcId（会被当成真人指令）')
    else bad('没有 rpcId')
    if (adoptSessionEvent) {
      try {
        adoptSessionEvent({ type: 'user/message', seq: 0, time: Date.now(), data: structuredClone(msg), surfaceOp: 'append' })
        ok('DSH 的 adoptSessionEvent 认这条消息（这才是权威判据）')
      } catch (e) { bad('DSH 校验器拒了：' + e.message) }
    }
  }
}

console.log('\n3. 失败路径：宁可拒绝，也不许"尽力而为"写坏别人会话');
{
  const cases = [
    ['没有 agent', { text: 'x', agents: [] }, /没有 live agent|只有子代理/],
    ['agents 服务缺失', { text: 'x', agents: null }, /agents 服务不可用/],
    ['空文本', { text: '   ', agents: [fakeAgent().agent] }, /空/],
    ['agent 没有 followup（老宿主）', { text: 'x', agents: [fakeAgent({ hasFollowup: false }).agent] }, /followup/],
  ]
  for (const [label, input, re] of cases) {
    const r = deliverToSession(input)
    if (r.ok) bad(`${label} 竟然"成功"了 —— 应该拒绝`)
    else if (re.test(r.reason)) ok(`${label} → 如实拒绝（${r.reason}）`)
    else bad(`${label} 拒绝了但理由不对：${r.reason}`)
  }
  // 造消息函数吐了个没 id 的东西 ⇒ 必须拦
  const r = deliverToSession({ text: 'x', agents: [fakeAgent().agent], createUserMessage: () => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }) })
  if (!r.ok && /缺字段 id/.test(r.reason)) ok('造消息函数漏了 id → 拦住了（不写进会话）')
  else bad('漏 id 的消息被放行了：' + JSON.stringify(r))
}

console.log('\n4. 只送主会话，不送子代理');
{
  const root = fakeAgent({ id: 'session-root' })
  const child = fakeAgent({ id: 'session-child', parentAgent: root.agent })
  const r = deliverToSession({ text: 'raiz', agents: { list: () => [root.agent, child.agent], roots: () => [root.agent] } })
  if (r.ok && r.sessionId === 'session-root') ok('送到了主会话 ' + r.sessionId)
  else bad('送错地方了：' + JSON.stringify(r))
  if (root.rec.called === 1 && child.rec.called === 0) ok('子代理没被打扰')
  else bad(`主 ${root.rec.called} 次 / 子 ${child.rec.called} 次`)

  // 只有子代理时
  const only = deliverToSession({ text: 'x', agents: { list: () => [child.agent], roots: () => [] } })
  if (!only.ok) ok('只有子代理时拒绝：' + only.reason)
  else bad('往子代理会话送了')
}

console.log('\n5. 措辞：不许骗主人说"他正在回你"');
{
  const busy = relayLine(true, (a) => a[0])
  const idle = relayLine(false, (a) => a[0])
  if (!/回你|马上|立刻/.test(busy) && /跑|搁|排/.test(busy)) ok('他正忙时如实说：' + busy)
  else bad('忙的时候措辞骗人：' + busy)
  if (!/回你|马上|立刻/.test(idle)) ok('他空闲时也没乱许愿：' + idle)
  else bad('空闲措辞骗人：' + idle)
}

console.log('\n6. 自造消息（拿不到 dsh-llm 时的兜底）也要合法');
{
  const m = makeUserMessage({ content: [{ type: 'text', text: '兜底路径' }], source: { kind: 'user', rpcId: 'pet-relay-x' }, uuid: () => 'fixed-uuid' })
  if (validateUserMessage(m) === null) ok('兜底消息自检通过')
  else bad('兜底消息不合格：' + validateUserMessage(m))
  if (m.id === 'fixed-uuid') ok('id 可注入（测试确定性）'); else bad('uuid 没被用上')
  const noId = makeUserMessage({ content: [], source: { kind: 'user' }, uuid: () => '' })
  if (validateUserMessage(noId) !== null) ok('坏消息能被 validateUserMessage 抓出来')
  else bad('validateUserMessage 放过了坏消息')
}

console.log('\n7. clientTimeZone 必须带（否则那一轮模型看到"时区不可用"）');
{
  // 🔴 2026-10-25 实测踩到：转达消息没带 clientTimeZone ⇒
  //    dsh-time-context 的 deriveBrowserTimeZoneContext({kind:'missing'}) ⇒
  //    模型被告知 "Browser time zone for this request: unavailable"。
  //    真人打字时 DSH 会带，我们不带就是自己造偏差。
  const { agent, rec } = fakeAgent()
  deliverToSession({ text: '时区检查', agents: [agent] })
  const src = rec.lastMsg?.source
  if (src && typeof src.clientTimeZone === 'string' && src.clientTimeZone) {
    ok('转达消息带上了 clientTimeZone = ' + src.clientTimeZone)
  } else bad('转达消息没带 clientTimeZone —— 那一轮模型会被告知时区不可用')

  // 值必须是 dsh-time-context 认的那种：'UTC' 或规范 IANA Area/Location
  const IANA = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/
  const z = src?.clientTimeZone
  if (z === 'UTC' || IANA.test(z || '')) ok('clientTimeZone 形状合法（UTC 或 Area/Location）')
  else bad('clientTimeZone 形状不合法，dsh-time-context 会 throw：' + JSON.stringify(z))

  // 而且必须是 Intl 认的规范名（非规范名 DSH 也会 throw）
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone
    if (canonical === z) ok('clientTimeZone 是 Intl 认同的规范名')
    else bad(`clientTimeZone 非规范：给的是 ${z}，规范名是 ${canonical}（DSH 会 throw）`)
  } catch (e) { bad('clientTimeZone 连 Intl 都不认：' + e.message) }

  // pickClientTimeZone 自身也要稳
  const tz = pickClientTimeZone()
  if (tz === 'UTC' || IANA.test(tz)) ok('pickClientTimeZone() 返回合法值：' + tz)
  else bad('pickClientTimeZone() 返回值不合法：' + JSON.stringify(tz))
}

console.log(fail ? `\n结果：${pass} 通过 / ${fail} 失败` : `\n结果：${pass} 通过 / 0 失败 ✓ 投递链路安全`)
process.exit(fail ? 1 : 0);
