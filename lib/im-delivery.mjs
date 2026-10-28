/** One submit at most. A missing readback is an unknown outcome, never permission to resend. */
export const normalizeText = text => String(text || '').replace(/[\u200b\r]/g, '').replace(/\s+/g, ' ').trim()
export const matchingMessages = (messages, text) => messages.filter(m => m.from === 'me' && normalizeText(m.text) === normalizeText(text)).length

const editorSelector = '[data-douyin-im-editor="active"]'
export const editorStateExpression = `(() => {
  const e = document.querySelector('${editorSelector}');
  return { exists: !!e, focused: !!e && (document.activeElement === e || e.contains(document.activeElement)),
    text: e ? String(e.value ?? e.innerText ?? '').replace(/[\\u200b\\r]/g, '') : '' };
})()`

export async function fillEditor(page, text, { wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const position = await page.ev(`(() => {
    const panel = document.querySelector('[class*="componentsRightPanel"]');
    if (!panel) return null;
    const editor = [...panel.querySelectorAll('[contenteditable="true"], textarea')].find(e => {
      const r = e.getBoundingClientRect();
      return r.width > 80 && r.height > 10 && !e.disabled && !e.readOnly && e.getAttribute('aria-disabled') !== 'true';
    });
    if (!editor) return null;
    editor.scrollIntoView({ block: 'center', inline: 'nearest' });
    editor.setAttribute('data-douyin-im-editor', 'active');
    const r = editor.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('找不到可用的会话输入框')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 })
  // Replace the entire draft instead of appending to text left by a failed previous attempt.
  const focused = await page.ev(`(() => {
    const e = document.querySelector('${editorSelector}');
    if (!e) return false;
    e.focus();
    if (e.tagName === 'TEXTAREA') e.select();
    else { const range = document.createRange(); range.selectNodeContents(e);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    return document.activeElement === e || e.contains(document.activeElement);
  })()`)
  if (!focused) throw new Error('输入框没有获得焦点，已中止发送')
  await page.send('Input.insertText', { text })
  for (let i = 0; i < 8; i++) {
    const state = await page.ev(editorStateExpression)
    if (state?.focused && normalizeText(state.text) === normalizeText(text)) return
    await wait(250)
  }
  throw new Error('输入框内容与待发正文不完全一致，已中止发送')
}

export async function deliverIm({ page, text, beforeMessages, readMessages, verifyTarget,
  wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeoutMs = 15000 }) {
  let submitted = false, stage = 'verify_target', afterMessages = beforeMessages, boxLeft = null
  const beforeCount = matchingMessages(beforeMessages, text)
  const started = now()
  const result = (ok, extra = {}) => ({
    ok, sent: ok, submitted, pending: submitted && !ok, retry_safe: !submitted,
    stage, readback: matchingMessages(afterMessages, text) > beforeCount,
    my_msg_before: beforeCount, my_msg_after: matchingMessages(afterMessages, text),
    msgs_in_view_before: beforeMessages.length, msgs_in_view_after: afterMessages.length,
    newest_from: afterMessages[0]?.from, box_left: boxLeft,
    elapsed_ms: now() - started, ...extra,
  })
  try {
    if (!await verifyTarget()) return result(false, { error: '发送前核对失败：会话身份不匹配或无法验证' })
    stage = 'fill_editor'
    await fillEditor(page, text, { wait })
    stage = 'verify_target'
    if (!await verifyTarget()) return result(false, { error: '发送前核对失败：输入后会话身份发生变化' })
    const typed = await page.ev(editorStateExpression)
    if (!typed?.focused || normalizeText(typed.text) !== normalizeText(text)) return result(false, { error: '提交前正文或焦点发生变化，已中止发送' })
    stage = 'submit'
    submitted = true // Even a CDP timeout here may mean Enter was received. Do not retry.
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    stage = 'readback'
    const deadline = now() + timeoutMs
    do {
      if (!await verifyTarget()) return result(false, { error: '提交后会话身份变化，无法确认发送结果', hint: '请先回读会话核对，勿自动重发' })
      afterMessages = await readMessages()
      const state = await page.ev(editorStateExpression)
      boxLeft = state?.exists ? normalizeText(state.text).length : null
      if (matchingMessages(afterMessages, text) > beforeCount && boxLeft === 0) return result(true, { stage: 'confirmed' })
      await wait(500)
    } while (now() < deadline)
    return result(false, { error: '已提交，但等待回读超时；发送结果待核实', hint: '先回读确认是否收到，勿自动重发；下一次操作使用全新页面' })
  } catch (error) {
    return result(false, { error: String(error?.message || error), hint: submitted
      ? '提交可能已经生效，先回读核对，勿自动重发' : '本次尚未提交发送；检查页面加载、登录或输入框状态后再尝试' })
  }
}

/** Privacy-preserving diagnostics: no recipient, message text, URL, or credentials. */
export const deliveryDiagnostic = result => Object.fromEntries([
  'ok', 'sent', 'submitted', 'pending', 'retry_safe', 'stage', 'readback', 'chrome', 'page_fresh',
  'my_msg_before', 'my_msg_after', 'msgs_in_view_before', 'msgs_in_view_after', 'box_left', 'elapsed_ms',
].filter(key => result?.[key] !== undefined).map(key => [key, result[key]]))
