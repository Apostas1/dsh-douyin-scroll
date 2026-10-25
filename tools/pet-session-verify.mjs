// tools/pet-session-verify.mjs —— 用 DSH 自己的校验器，真去"打开"一个会话文件
// ============================================================================
// 为什么不能只靠我自己写的校验：教训就是"我以为写对了，DSH 一读就炸"。
// 这里走 DSH 真正用的那条链路（adoptSessionEvent → foldSurface），
// 四项全绿才算"主人点开历史不会再报 corrupt"。
//
// 用法：node tools/pet-session-verify.mjs <会话文件>
// 退出码 0 = 读得开。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** 找宿主那棵树里的 @deepseek-ai/dsh-session（不写死路径：别人装的位置不一样） */
function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  if (process.env.APPDATA) {
    const npm = path.join(process.env.APPDATA, 'npm', 'node_modules')
    push(path.join(npm, '@deepseek-ai', 'dsh', 'node_modules'))
    push(path.join(npm, '@deepseek-ai', 'dsh-desktop', 'node_modules'))
    push(npm)
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules')
  try {
    const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
    for (const p of readdirSync(path.join(dshHome, 'profiles'))) {
      push(path.join(dshHome, 'profiles', p, 'node_modules'))
    }
    // 桌面版把 asar 解开放在 dsh-data/extracted-asar 的情况（本机就是）
    push(path.join(dshHome, 'extracted-asar', 'dsh', 'node_modules'))
    push(path.join(dshHome, 'extracted-asar', 'node_modules'))
  } catch { /* 没有就算了 */ }
  // 从"这个脚本自己所在的位置"往上找：插件装在 profile 里时，宿主包常在同级
  try {
    let d = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname)
    for (let i = 0; i < 8 && d; i++) {
      push(path.join(d, 'node_modules'))
      const up = path.dirname(d)
      if (up === d) break
      d = up
    }
  } catch { /* 无所谓 */ }
  return out
}

async function loadSess() {
  for (const root of candidateRoots()) {
    const f = path.join(root, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    if (!existsSync(f)) continue
    try {
      const m = await import(pathToFileURL(f).href)
      if (typeof m.adoptSessionEvent === 'function') { console.log('校验器来源：' + f); return m }
    } catch { /* 换下一个 */ }
  }
  return null
}

const sess = await loadSess()
if (!sess) {
  console.error('❌ 找不到 @deepseek-ai/dsh-session；可设 DSH_HOST_MODULES=<node_modules 目录> 再跑')
  process.exit(3)
}
const { adoptSessionEvent, foldSurface, deriveEventMessage } = sess;

const MAGIC = 0xfd2fb528;
function frameEnd(b, start) {
  let p = start + 4;
  const d = b[p++];
  const fcs = (d >> 6) & 3, ss = (d >> 5) & 1, cs = (d >> 2) & 1, df = d & 3;
  if (!ss) p += 1;
  p += [0, 1, 2, 4][df];
  p += fcs === 0 ? (ss ? 1 : 0) : [0, 2, 4, 8][fcs];
  for (;;) { const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3; const last = h & 1, bt = (h >> 1) & 3, bs = h >>> 3; p += bt === 1 ? 1 : bs; if (last) break; }
  if (cs) p += 4;
  return p;
}
function readLog(file) {
  const b = fs.readFileSync(file);
  const frames = []; let pos = 0;
  while (pos + 4 <= b.length) {
    if (b.readUInt32LE(pos) !== MAGIC) throw new Error('bad zstd magic at ' + pos);
    const end = frameEnd(b, pos);
    frames.push(zlib.zstdDecompressSync(b.subarray(pos, end)).toString('utf8'));
    pos = end;
  }
  if (pos !== b.length) throw new Error('trailing bytes');
  const events = [];
  for (let i = 1; i < frames.length; i++) for (const l of frames[i].split('\n')) if (l) events.push(JSON.parse(l));
  return { frames, events };
}

const file = process.argv[2];
if (!file) { console.error('usage: node _verify_session_repair.mjs <session.v4.jsonl.zstd>'); process.exit(2) }

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  OK   ' + m) };
const bad = (m) => { fail++; console.log('  FAIL ' + m) };

console.log('file: ' + file);
const { frames, events } = readLog(file);
console.log('frames: ' + frames.length + '   events: ' + events.length);

// ① 这就是 DSH 打开会话时执行的同一条校验
let corruption = 0;
for (const ev of events) {
  try { adoptSessionEvent(structuredClone(ev)) }
  catch (e) { corruption++; if (corruption <= 3) console.log('     seq ' + ev.seq + ' ' + ev.type + ': ' + e.message) }
}
if (corruption === 0) ok('adoptSessionEvent 全部通过（DSH 打开会话不会报 corrupt）');
else bad(corruption + ' 条事件仍不合法 —— DSH 还会报 corrupt');

// ② seq 必须连续（重编号一旦错位，surface 引用全乱）
let seqBad = 0;
for (let i = 0; i < events.length; i++) if (events[i].seq !== i) { seqBad++; break }
if (seqBad === 0) ok('seq 连续 0..' + (events.length - 1));
else bad('seq 不连续');

// ③ 折叠出的模型 transcript 里，tool-call 必须紧跟着它的 tool-result
const folded = foldSurface(events);
const msgs = [];
for (const seq of folded.nodes) {
  const ev = events[seq];
  const m = deriveEventMessage(ev, folded.projectedMessages);
  if (m !== null) msgs.push({ seq, m });
}
let viol = 0;
for (let i = 0; i < msgs.length; i++) {
  const { m } = msgs[i];
  if (m.role !== 'assistant') continue;
  const calls = (m.content ?? []).filter((b) => b.type === 'tool-call');
  for (let k = 0; k < calls.length; k++) {
    const next = msgs[i + 1 + k];
    if (!next || next.m.role !== 'tool' || next.m.toolCallId !== calls[k].id) viol++;
  }
}
if (viol === 0) ok('tool-call / tool-result 严格配对（' + msgs.length + ' 条模型消息）');
else bad(viol + ' 处配对错误 —— 送模型还会 400');

// ④ 那条曾经写死的消息现在有 id 了
const relay = events.filter((e) => e.type === 'user/message' && String(e.data?.source?.rpcId ?? '').startsWith('pet-relay'));
const noId = relay.filter((e) => typeof e.data?.id !== 'string' || !e.data.id);
if (relay.length && noId.length === 0) ok('41 条 pet-relay 消息全部有 id（' + relay.length + ' 条）');
else if (noId.length) bad(noId.length + ' 条 pet-relay 消息仍无 id');
else ok('这个会话里没有 pet-relay 消息（不是被污染的那个）');

// ⑤ 报告
console.log('\n' + (fail ? `FAILED: ${pass} ok / ${fail} bad` : `ALL PASS: ${pass} checks`));
process.exit(fail ? 1 : 0);
