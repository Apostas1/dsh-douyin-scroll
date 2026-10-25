// _verify-pool-rebuild.mjs —— 纯逻辑验证：off 之后池子还能不能重建
// 这是把 pet.js 里 DanmakuPool 那段逻辑**原样搬出来**跑，不需要浏览器。
// 目的：证明 pool.length = 0 这一行确实修好了"关再开就空"的 bug。

/* ==== 与 pet.js 保持一致的实现（照抄关键部分）==== */
let danmakuElChildren = []      // 模拟 DOM 子节点
const DM_POOL_SIZE = 40
const DM_LANES = 7
const pool = []
const laneFreeAt = new Array(DM_LANES).fill(0)
let poolIdx = 0
let dmFlip = 0

function buildPool() {
  if (pool.length) return
  for (let i = 0; i < DM_POOL_SIZE; i++) {
    const el = { style: { display: 'none' }, __until: 0 }
    danmakuElChildren.push(el)      // 相当于 danmakuEl.appendChild(el)
    pool.push(el)
  }
}

function takeFreeEl(now) {
  for (let i = 0; i < DM_POOL_SIZE; i++) {
    const el = pool[(poolIdx + i) % DM_POOL_SIZE]
    if (el.style.display === 'none' || Number(el.__until || 0) < now) {
      poolIdx = (poolIdx + i + 1) % DM_POOL_SIZE
      return el
    }
  }
  return null
}

function spawnDanmakuText(text, now) {
  buildPool()
  let lane = 0
  for (let i = 1; i < DM_LANES; i++) if (laneFreeAt[i] < laneFreeAt[lane]) lane = i
  if (laneFreeAt[lane] > now) return false
  const el = takeFreeEl(now)
  if (!el) return false
  el.textContent = text
  el.style.display = 'block'
  el.__until = now + 8000 + 140
  laneFreeAt[lane] = el.__until
  dmFlip ^= 1
  return true
}

/** 模拟 setDanmakuMode('off') 的正确做法 */
function turnOffCorrect() {
  // 藏起来
  for (const el of danmakuElChildren) el.style.display = 'none'
  // 清 DOM + 作废池（这两行必须一起）
  danmakuElChildren = []
  pool.length = 0
  poolIdx = 0
}

/** 模拟旧 bug 的做法：只清 DOM，不作废池 */
function turnOffBuggy() {
  for (const el of danmakuElChildren) el.style.display = 'none'
  danmakuElChildren = []          // innerHTML = ''
  // ⚠️ 故意**不**清 pool —— 这就是旧版
}

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  OK   ' + m) }
const bad = (m) => { fail++; console.log('  FAIL ' + m) }

console.log('1) 旧写法（只清 DOM 不清池）应当复现 bug');
{
  pool.length = 0; poolIdx = 0; danmakuElChildren = []
  laneFreeAt.fill(0)
  spawnDanmakuText('hello', 1000)
  const before = danmakuElChildren.length
  turnOffBuggy()
  const afterOff = danmakuElChildren.length
  // 再开：buildPool 会因为 pool 非空直接 return
  buildPool()
  const afterOn = danmakuElChildren.length
  console.log(`     spawn后DOM=${before}  off后DOM=${afterOff}  再开后DOM=${afterOn}`)
  if (before > 0 && afterOff === 0 && afterOn === 0) ok('复现成功：旧写法关一次再开 → DOM 永远是 0（这就是主人看到的"消失"）')
  else bad(`没能复现（before=${before} afterOff=${afterOff} afterOn=${afterOn}）`)
}

console.log('2) 新写法（pool.length = 0）应当修好');
{
  pool.length = 0; poolIdx = 0; danmakuElChildren = []
  laneFreeAt.fill(0)
  spawnDanmakuText('hello', 2000)
  const before = danmakuElChildren.length
  turnOffCorrect()
  const afterOff = danmakuElChildren.length
  buildPool()                      // 相当于再次打开时 spawn 里调的
  const afterOn = danmakuElChildren.length
  console.log(`     spawn后DOM=${before}  off后DOM=${afterOff}  再开后DOM=${afterOn}`)
  if (before > 0 && afterOff === 0 && afterOn > 0) ok(`修好了：再开之后 DOM 重建 ${afterOn} 个节点`)
  else bad(`仍然不对（before=${before} afterOff=${afterOff} afterOn=${afterOn}）`)
}

console.log('3) 重开之后真的能画出可见弹幕');
{
  const visible = danmakuElChildren.filter((el) => el.style.display !== 'none').length
  // 再 spawn 几条新的
  let spawned = 0
  for (let t = 0; t < 6; t++) if (spawnDanmakuText('msg' + t, 3000 + t * 100)) spawned++
  const visibleAfter = danmakuElChildren.filter((el) => el.style.display !== 'none').length
  if (spawned > 0 && visibleAfter > 0) ok(`重开后能继续出弹幕（新发 ${spawned} 条，当前可见 ${visibleAfter}）`)
  else bad(`重开后出不来（spawned=${spawned} visible=${visibleAfter}）`)
}

console.log('4) 分轨：同一时刻不会重叠同一条轨道');
{
  pool.length = 0; poolIdx = 0; danmakuElChildren = []
  laneFreeAt.fill(0)
  const now = 10000
  const accepted = []
  // 同一时刻连发 20 条，最多只能有 DM_LANES 条被接受（其余等轨道空）
  for (let i = 0; i < 20; i++) if (spawnDanmakuText('x' + i, now)) accepted.push(i)
  if (accepted.length <= DM_LANES) ok(`同一时刻最多 ${DM_LANES} 条（实测接受 ${accepted.length} 条，其余自动等轨道）`)
  else bad(`接受了 ${accepted.length} 条 > 轨道数 ${DM_LANES} —— 会重叠`)
}

console.log('5) 池够大：40 个节点 ≥ 轨道 7，不会出现"池耗尽"');
{
  if (DM_POOL_SIZE >= DM_LANES) ok(`池 ${DM_POOL_SIZE} ≥ 轨道 ${DM_LANES}`)
  else bad(`池 ${DM_POOL_SIZE} < 轨道 ${DM_LANES}`)
}

console.log(fail ? `\n结果：${pass} 通过 / ${fail} 失败` : `\n结果：${pass} 通过 / 0 失败 ✓ 弹幕重开/分轨逻辑正确`)
process.exit(fail ? 1 : 0)
