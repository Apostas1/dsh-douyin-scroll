/** Each tool owns one fresh page; no operation may navigate another tool's page. */
export async function createTaskPage(browser, { url, connect, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const { targetId } = await browser.send('Target.createTarget', { url, background: true })
  if (!targetId) throw new Error('浏览器没有返回新页面 ID')
  let page, closing
  const close = () => closing ||= (async () => {
    page?.close()
    try {
      const result = await browser.send('Target.closeTarget', { targetId })
      if (result?.success === false) throw new Error('Target.closeTarget returned false')
      return { ok: true }
    }
    catch { return { ok: false, targetId, error: '任务页面未能关闭' } }
    finally { browser.close() }
  })()
  try {
    page = await connect(targetId)
    await page.send('Page.bringToFront')
    // The document URL can be set while its execution context is still being replaced.
    let ready = false
    for (let i = 0; i < 40; i++) {
      try { ready = Boolean(await page.ev(`document.readyState !== "loading" && !!document.body && (${JSON.stringify(url)} === 'about:blank' || location.href !== 'about:blank')`)) } catch { /* Navigation in progress. */ }
      if (ready) break
      await wait(250)
    }
    if (!ready) throw new Error('新页面加载超时，请检查网络或登录状态')
    return { ...page, targetId, fresh: true, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
