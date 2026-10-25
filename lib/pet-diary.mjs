// lib/pet-diary.mjs —— 她的日记：她今天看见/说了什么，值得记下来的
// ============================================================================
// 主人 2026-10-24：
//   「我还要个查看日记的功能，可以查看她今天写了什么感人的言论」
//
// 设计：
//   ① 她说的每句话（activity）本来就写进 pet-window-state.json 了 —— 但那个只留最新一条，
//      翻不到历史。所以这里按天追加到 pet-diary/YYYY-MM-DD.jsonl。
//   ② 「感人的言论」不是每句都算。只有**带情绪/带心意**的才标 star：
//      提到主人、说谢谢、撒娇、自嘲吃饭、说想你…
//      不靠模型判断（每句都调太贵），用关键词 + 长度规则，可解释、可单测。
//   ③ 面板「日记」页读它，按天翻。
//
// 🔴 隐私：日记只存在 $DSH_HOME/douyin-duty/pet-diary/，不进插件包、不上传。
// ============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 值得记一笔的信号（命中任一条就算"有感"）。全是鱼自己的话，不是别人的。 */
const TOUCH = [
  /主人/,                    // 提到主人 —— 她所有心事都围着主人
  /想你|等你|陪你/,          // 依赖
  /谢谢|喜欢你|爱你/,        // 心意
  /对不起|抱歉|是鱼的错/,    // 认错
  /白饭|饿|吃/,              // 她的梗
  /累|困|歇|撑不住/,         // 卖惨（适度要记）
  /开心|高兴|嘿嘿|耶/,        // 高兴
  /委屈|难过|失落|哼/,       // 委屈
  /加油|一起|陪/,            // 打气
]

/** 这句值不值得标星（"感人"）。纯规则，可单测。 */
export function isTouching(text) {
  const t = String(text || '').trim()
  if (t.length < 6) return false        // 太短的基本是"嗯""好哦"，不算
  if (t.length > 200) return false      // 异常长的不当感言
  return TOUCH.some((re) => re.test(t))
}

/** 日记目录 */
export function diaryDir(stateDir) {
  const d = join(stateDir, 'pet-diary')
  try { if (!existsSync(d)) mkdirSync(d, { recursive: true }) } catch { /* 建不了就写不进去，上层兜 */ }
  return d
}

function dayFile(stateDir, day) {
  return join(diaryDir(stateDir), `${day}.jsonl`)
}

/** 当天 key（本地时区，跟主人作息一致 —— 不用 UTC，否则凌晨算前一天） */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 记一条。**去重**：同一句话在同一天只记一次（她会重复说同样的话，日记里不该刷屏）。
 * @returns {{ok:boolean, star?:boolean, dup?:boolean, error?:string}}
 */
export function diaryAdd(stateDir, text, meta = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'empty' }
  const day = todayKey()
  const f = dayFile(stateDir, day)
  try {
    // 去重：读当天已有的文本（一天最多几百行，读得起）
    const seen = new Set()
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { const o = JSON.parse(line); if (o && o.text) seen.add(o.text) } catch { /* 坏行跳过 */ }
      }
    }
    if (seen.has(t)) return { ok: true, dup: true, star: isTouching(t) }
    const rec = {
      at: new Date().toISOString(),
      text: t,
      star: isTouching(t),
      kind: String(meta.kind || 'activity'),
    }
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8')
    return { ok: true, star: rec.star }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 读某天的日记（新的在前）。 */
export function diaryRead(stateDir, day) {
  const d = String(day || todayKey())
  const f = dayFile(stateDir, d)
  if (!existsSync(f)) return { day: d, items: [], stars: 0 }
  const items = []
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o && o.text) items.push(o)
      } catch { /* 坏行跳过，不因为一行坏掉整篇日记 */ }
    }
  } catch { /* 读不到就当空 */ }
  items.reverse()   // 新的在前
  return { day: d, items, stars: items.filter((x) => x.star).length }
}

/** 有日记的日子列表（新的在前），给面板做"往前翻"。 */
export function diaryDays(stateDir, limit = 60) {
  try {
    const d = diaryDir(stateDir)
    return readdirSync(d)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.replace(/\.jsonl$/, ''))
      .sort()
      .reverse()
      .slice(0, limit)
  } catch { return [] }
}
