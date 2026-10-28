import { maskUrl } from './notify.mjs'

export function redactDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/g, url => maskUrl(url))
    .replace(/((?:sessionid(?:_ss)?|sid_tt|passport_csrf_token|msToken|authorization)\s*[=:]\s*)[^\s;,"'}]+/gi, '$1***')
}

/** Accept log lines before a JSON result, including multi-line JSON and multiple objects. */
export function lastJsonObject(value) {
  const text = String(value || '')
  let depth = 0, start = -1, quoted = false, escaped = false, last = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (depth === 0) {
      if (c === '{') { start = i; depth = 1; quoted = false }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { last = JSON.parse(text.slice(start, i + 1)) } catch { /* plain log fragment */ }
    }
  }
  return last
}

export function scriptResult(result, fallback = '子脚本没有返回有效结果') {
  const parsed = lastJsonObject(result.stdout)
  const diagnostic = redactDiagnostic(result.stderr || result.stdout).slice(-600)
  if (parsed) {
    if (result.status !== 0 && parsed.ok !== false) return { ...parsed, ok: false, error: parsed.error || fallback, exit_code: result.status, stderr_tail: diagnostic }
    return parsed
  }
  return { ok: false, error: fallback, exit_code: result.status, stderr_tail: diagnostic }
}
