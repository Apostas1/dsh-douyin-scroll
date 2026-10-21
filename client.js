/**
 * dsh-douyin-scroll —— 浏览器半端（**设置在「设置」里的一页**，中文名「刷抖音」）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（抄 dsh-bili-scroll/client.js 的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进「设置」**（抄 dsh-meme / dsh-bili-scroll 的写法）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
 *       () => h(Panel),
 *     ))
 *
 *   ⇒ **别自己糊一个标题栏按钮 + 全屏 overlay** ✗（bili-scroll 第一版就是这么干的，
 *     使用者一眼看出"跟别的插件不一样"）。
 *
 * 与 bili-scroll 的差别（这一页特有的形状）：
 *   · 采集来源三选一：cookie（纯 HTTP，抖音有 a_bogus 验签，可能拿不到数据）
 *     / browser（Playwright 真浏览器，最稳，要单独装）/ manual（手动喂候选）
 *   · 登录方式不是扫码 —— 是**粘贴 Cookie**（凭证只落在本机插件家目录）
 *   · **自动评论默认关**，并且必须有一段红色警示：抖音「@自己」未经验证、
 *     评论以你的账号名义发出、可能触发风控/限流。
 *   · CSS 选择器前缀用 `data-dy-*`（bili-scroll 用 `data-bd-*`），避免两个插件互相踩。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/douyin-duty'
    /* ⚠️ jget/jpost 必须看 res.ok：直接 .json() 的话，HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（抄 bili-scroll 2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:660px;}
[data-dy-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dy-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-label]{font-size:13px;}
[data-dy-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-danger]{font-size:11px;line-height:17px;padding:9px 10px;border-radius:8px;color:#f87171;
  border:1px solid rgba(248,113,113,.35);background:rgba(248,113,113,.08);}
[data-dy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dy-sw][data-on]{background:#3b82f6;}
[data-dy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dy-sw][data-on] i{left:19px;}
[data-dy-sw][disabled]{opacity:.45;cursor:default;}
[data-dy-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy-input]:focus{outline:none;border-color:#3b82f6;}
[data-dy-num]{width:88px;text-align:center;flex:none;}
[data-dy-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-msg][data-warn]{color:#f59e0b;}
[data-dy-msg][data-good]{color:#22c55e;}
[data-dy-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:190px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-dy-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-badge][data-on]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-dy-badge][data-off]{background:rgba(245,158,11,.16);color:#f59e0b;}
`

    // ⚠️ 与宿主 lib/state 的时段保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午谷时', start: '12:00', end: '14:00' },
      night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dy-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-dy-row': '' },
        h('div', { 'data-dy-grow': '' },
          h('div', { 'data-dy-label': '' }, label),
          note ? h('div', { 'data-dy-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    // 数字行：失焦时先夹到 [min,max] 再发（0 常常是合法值，别让 || 把它吃掉）
    function NumRow({ label, note, value, min, max, onEdit, onCommit }) {
      const commit = () => {
        const n = Number(value)
        const v = Number.isFinite(n) ? Math.max(min, Math.min(Math.round(n), max)) : min
        onEdit(String(v))
        onCommit(v)
      }
      return h('div', { 'data-dy-row': '' },
        h('div', { 'data-dy-grow': '' },
          h('div', { 'data-dy-label': '' }, label),
          note ? h('div', { 'data-dy-note': '' }, note) : null),
        h('input', {
          'data-dy-input': '', 'data-dy-num': '', type: 'number', min, max,
          value: value ?? '',
          onChange: (e) => onEdit(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') commit() },
        }))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    // 文本域 ⇄ 数组：一行一个，去空行、去首尾空格
    const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)

    /* ────────────── 设置页正文 ────────────── */

    function Panel() {
      // 装东西 / 跑一轮的时候要盯进度 ⇒ 这时候 3 秒一问；平时 8 秒够了
      const [st, setSt] = useStatus(8000)
      const fast = Boolean(st?.installing || st?.busy)
      const [st2, setSt2] = useStatus(fast ? 3000 : 60000)
      React.useEffect(() => { if (st2) setSt(st2) }, [st2])   // 快轮询那份覆盖慢轮询那份

      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')

      /* ⚠️ 输入框必须绑"本地草稿"：页面会轮询 /status，服务端那份会把 config 盖掉
       *    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（bili-scroll 2026-10-14 抓到过） */
      const [kws, setKws] = React.useState(null)          // keywords
      const [chs, setChs] = React.useState(null)          // channels
      const [auths, setAuths] = React.useState(null)      // authors
      const [perDay, setPerDay] = React.useState(null)
      const [maxPerRun, setMaxPerRun] = React.useState(null)
      const [rl, setRl] = React.useState(null)            // reportLevel
      const [minDesc, setMinDesc] = React.useState(null)
      const [minCmt, setMinCmt] = React.useState(null)
      const [cookie, setCookie] = React.useState('')
      const [loginSt, setLoginSt] = React.useState(null)  // GET /login/status 的结果
      const [exr, setExr] = React.useState(null)          // commentExecutor
      const [cPerRun, setCPerRun] = React.useState(null)
      const [cPerDay, setCPerDay] = React.useState(null)
      const [mention, setMention] = React.useState(null)
      const [httpUrl, setHttpUrl] = React.useState(null)
      const [nMode, setNMode] = React.useState(null)      // notifyMode
      const [nPreset, setNPreset] = React.useState(null)  // webhookPreset
      const [nUrl, setNUrl] = React.useState(null)        // webhookUrl
      const [py, setPy] = React.useState(null)            // pythonPath
      const [bin, setBin] = React.useState(null)          // dshBin
      const [prof, setProf] = React.useState(null)        // headlessProfile
    const [dmTo, setDmTo] = React.useState(null)        // dmTo —— 私信发给谁（昵称，只显示用）
    const [dmToId, setDmToId] = React.useState(null)    // dmToId —— 私信发给谁（稳定 id，真正决定发给谁）
      const [report, setReport] = React.useState(null)    // 非 null = 报告已展开
      const [topNote, setTopNote] = React.useState(null)  // 顶部那行反馈（提示掉到页面最底下就看不见了）

      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const cfg = st?.config
      React.useEffect(() => {
        if (!cfg) return
        if (kws === null) setKws((cfg.keywords || []).join('\n'))
        if (chs === null) setChs((cfg.channels || []).join('\n'))
        if (auths === null) setAuths((cfg.authors || []).join('\n'))
        if (perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (maxPerRun === null) setMaxPerRun(String(cfg.maxPerRun ?? 20))
        if (rl === null) setRl(cfg.reportLevel || 'full')
        if (minDesc === null) setMinDesc(String(cfg.minDescLen ?? 12))
        if (minCmt === null) setMinCmt(String(cfg.minComments ?? 3))
        if (exr === null) setExr(cfg.commentExecutor || 'off')
        if (cPerRun === null) setCPerRun(String(cfg.commentPerRun ?? 1))
        if (cPerDay === null) setCPerDay(String(cfg.commentPerDay ?? 3))
        if (mention === null) setMention(cfg.mentionName || '')
        if (httpUrl === null) setHttpUrl(cfg.httpCommentUrl || '')
        if (nMode === null) setNMode(cfg.notifyMode || 'file')
        if (nPreset === null) setNPreset(cfg.webhookPreset || 'custom')
        if (nUrl === null) setNUrl(cfg.webhookUrl || '')
    if (dmTo === null) setDmTo(cfg.dmTo || '')
    if (dmToId === null) setDmToId(cfg.dmToId || '')
        if (py === null) setPy(cfg.pythonPath || '')
        if (bin === null) setBin(cfg.dshBin || '')
        if (prof === null) setProf(cfg.headlessProfile || '')
      }, [cfg])

      // 凭证状态单独问一次（Cookie 存没存、存了哪些键）
      const loadLogin = React.useCallback(async () => {
        try {
          const r = await jget('/login/status')
          if (alive.current) setLoginSt(r || null)
        } catch { /* 忽略 */ }
      }, [])
      React.useEffect(() => { loadLogin() }, [loadLogin])

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setTopNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部
      }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config }))
          // ⭐ 宿主那份（DSH 原生设置页）写失败要说出来，别假装"已保存"
          if (r?.host && r.host.ok === false) say(`${what || '设置'}：插件自己那份存了，但 DSH 设置页那份没写进去（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          if (r?.quotaFull) say('今天额度用完了（' + (r.error || '已到每天上限') + '）', 'warn')
          else if (r?.busy) say('上一轮还没跑完，等一下', 'warn')
          else say(r?.started ? '已经在后台跑一轮了，报告会写在 out/ 里' : ('没起来：' + (r?.error || '看 duty.log')), r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        try {
          const r = await jpost('/install', {})
          say(r?.started ? '开始装主依赖 —— 进度看下面的日志（建 venv，几分钟）' : (r?.busy ? '正在装，别重复点' : (r?.error || '没起来')),
            r?.started || r?.busy ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (!r || !r.ok) { say('还不能用：' + (r?.error || '没拿到结果'), 'warn'); return }
          const steps = (r.steps || []).join('、')
          const who = r.who ? '（账号：' + r.who + '）' : ''
          const sample = r.sample ? ' —— 样例：' + r.sample : ''
          say('能用！' + steps + who + sample, 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onSaveCookie = async () => {
        setBusy('cookie')
        try {
          const r = await jpost('/login/save', { cookie: String(cookie || '').trim() })
          if (r?.ok) {
            setCookie('')
            await loadLogin()
            setSt((old) => ({ ...old, loggedIn: true }))
            say('Cookie 已存到本机插件家目录' + (r.who ? '（' + r.who + '）' : ''), 'good')
          } else say('没存上：' + (r?.error || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onNotifyTest = async () => {
        setBusy('notify')
        try {
          const r = await jpost('/notify/test', {})
          if (r?.ok) {
            const via = [r?.toast?.sent ? 'Windows 通知' : '', r?.webhook?.ok ? 'webhook' : ''].filter(Boolean).join(' + ')
            say('测试消息已发出（' + (via || r.mode) + '）—— 去屏幕右下角看看', 'good')
          } else {
            say('没发出去：' + (r?.error || '未知原因'), 'warn')
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告是空的）') : '今天还没有报告 —— 跑一轮之后就有了')
        } catch (e) { setReport('读不到报告：' + String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      const onOpen = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r?.opened) say('已请系统打开：' + r.opened, 'good')
          else say('打不开（' + (r?.error || '未知原因') + '）—— 手动开这个路径：' + (st?.home || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onSaveText = async () => {
        await patch({
          keywords: lines(kws),
          channels: lines(chs),
          authors: lines(auths),
        }, '刷什么')
      }

      const onSaveAdvanced = async () => {
        await patch({
          pythonPath: String(py || '').trim(),
          dshBin: String(bin || '').trim(),
          headlessProfile: String(prof || '').trim(),
        }, '环境路径')
      }

      if (!cfg) {
        return h('div', { 'data-dy-page': '' }, h('div', { 'data-dy-note': '' }, '读设置中…'))
      }

      const sw = (k) => Boolean(cfg[k])
      const ex = exr || 'off'
      const nm = nMode || 'file'

      return h('div', { 'data-dy-page': '' },

        /* ── 1. 头部 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-label': '' }, '刷抖音'),
              h('div', { 'data-dy-note': '' },
                '峰谷时段自动刷抖音、挑出值得占用你一次注意力的几条，写成一份当天报告；不催你、不刷屏。')),
            h('span', { 'data-dy-badge': '' }, 'v' + (st.version || '?'))),
          h('div', { 'data-dy-row': '' },
            h('span', { 'data-dy-badge': '', 'data-on': st.loggedIn ? '' : undefined, 'data-off': st.loggedIn ? undefined : '' },
              st.loggedIn ? '抖音已登录' : '抖音未登录'),
            h('span', { 'data-dy-badge': '', 'data-on': st.venvReady ? '' : undefined, 'data-off': st.venvReady ? undefined : '' },
              st.installing ? '环境正在装' : (st.venvReady ? '环境已就绪' : '环境未装')),
            h('span', { 'data-dy-badge': '' }, `今天已挑 ${st.pickedToday ?? st.ranToday ?? 0} / ${cfg.perDay} 条`),
            h('div', { 'data-dy-grow': '' }),
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'run', onClick: onRun }, '现在跑一轮')),
          topNote ? h('div', { 'data-dy-msg': '', 'data-good': topNote.tone === 'good' ? '' : undefined,
            'data-warn': topNote.tone === 'warn' ? '' : undefined }, topNote.t) : null,
          st.lastRunAt ? h('div', { 'data-dy-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}` +
            (st.lastWhy ? `（${st.lastWhy}）` : '')) : null),

        /* ── 2. 刷什么 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '刷什么'),
          h('div', { 'data-dy-label': '' }, '关注关键词'),
          h('textarea', {
            'data-dy-input': '', rows: 5,
            placeholder: '一行一个关键词；留空 = 用内置那几组默认关键词',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-dy-label': '' }, '推荐流分类'),
          h('textarea', {
            'data-dy-input': '', rows: 3,
            placeholder: '一行一个，比如：游戏 / 美食 / 搞笑（留空 = 不挑分类，全站推荐流）',
            value: chs ?? '', onChange: (e) => setChs(e.target.value),
          }),
          h('div', { 'data-dy-label': '' }, '指定作者'),
          h('textarea', {
            'data-dy-input': '', rows: 3,
            placeholder: '一行一个：sec_uid 或 抖音主页链接（留空 = 不指定，只看推荐流）',
            value: auths ?? '', onChange: (e) => setAuths(e.target.value),
          }),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveText }, '保存'),
            msg ? h('div', { 'data-dy-msg': '', 'data-good': msgTone === 'good' ? '' : undefined,
              'data-warn': msgTone === 'warn' ? '' : undefined }, msg) : null)),

        /* ── 3. 怎么刷 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '怎么刷'),
          h(NumRow, {
            label: '每天最多挑几条', min: 0, max: 300, value: perDay,
            note: '填 0 = 不自动刷（还是能手动跑）；挑满就停，不硬凑',
            onEdit: setPerDay, onCommit: (v) => patch({ perDay: v }, '每天挑几条'),
          }),
          h(NumRow, {
            label: '每次最多筛选几个候选', min: 1, max: 100, value: maxPerRun,
            note: '一轮抓多少个候选来筛（多了烧时间，少了容易漏）',
            onEdit: setMaxPerRun, onCommit: (v) => patch({ maxPerRun: v }, '每轮候选数'),
          }),
          h('div', { 'data-dy-label': '' }, '报告写多细'),
          h('select', {
            'data-dy-input': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '报告形态') },
          },
            h('option', { value: 'full' }, '完整 —— 每条：标题 / 作者 / 为什么值得（默认）'),
            h('option', { value: 'brief' }, '薄 —— 每条一两行，只留值不值得 + 链接'),
            h('option', { value: 'off' }, '不写 —— 只跑不生成报告文件')),
          h(NumRow, {
            label: '文案少于多少字算太短', min: 0, max: 200, value: minDesc,
            note: '与下面那项**同时**满足才跳过：文案太短（< N 字）**且**评论很少',
            onEdit: setMinDesc, onCommit: (v) => patch({ minDescLen: v }, '最短文案'),
          }),
          h(NumRow, {
            label: '评论少于多少条算太少', min: 0, max: 1000, value: minCmt,
            note: '文案太短且评论很少的候选直接跳过，避免硬猜 —— 抖音很多视频没有字幕，只能靠文案+评论判断',
            onEdit: setMinCmt, onCommit: (v) => patch({ minComments: v }, '最少评论数'),
          })),

        /* ── 4. 定时（总开关 → 级联展开子开关）── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '峰谷时段自动刷',
            note: '只在谷时跑 —— 工作日 12:00–14:00 与 18:00 之后（整个周末也算谷时）；关了就只能手动跑',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '峰谷时段自动刷'),
          }),
          sw('peakValley') ? h('div', { 'data-dy-sub': '' },
            ...['noon', 'night'].map((k) => h(ToggleRow, {
              key: k,
              label: win[k].label,
              note: `${win[k].start} – ${win[k].end}`,
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null),

        /* ── 5. 怎么拿数据 + 登录 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '怎么拿数据'),
          h('div', { 'data-dy-note': '' },
            '⭐ 只有一条路，不用选：**只读接口**取推荐流候选（不签名、不碰写接口）→ 打分 → 出清单。',
            h('br'),
            '读评论 / 读通知走**签名只读**；发私信 / 发卡片 / 发评论走**无头 Chrome**（屏幕上不出现窗口）。',
            h('br'),
            '⚠️ 抖音 web 没有可用的关键词搜索接口 ⇒ 「关注关键词」只能当报告里的标注，别指望它按词搜。'),

          /* ── 6. 抖音 Cookie / 登录 ── */
          h('div', { 'data-dy-h': '' }, '抖音 Cookie / 登录'),
          h('div', { 'data-dy-note': '' },
            '两条路都行：① 命令行跑 ', h('b', null, 'node tools/qr-login.mjs start'),
            ' 扫码（会开一个**可见**浏览器，只为了扫码；扫完 commit 就行）；',
            h('br'),
            '② 在浏览器里登录 douyin.com，开发者工具 → Application → Cookies，把整条 Cookie 请求头复制出来粘下面。'),
          h('textarea', {
            'data-dy-input': '', rows: 4,
            placeholder: '把 Cookie 请求头整条粘进来（name=value; name2=value2; …）',
            value: cookie, onChange: (e) => setCookie(e.target.value),
          }),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'cookie' || !String(cookie).trim(), onClick: onSaveCookie }, '保存 Cookie'),
            h('div', { 'data-dy-note': '' },
              loginSt ? (loginSt.hasCredential
                ? `本机已存凭证（${(loginSt.keys || []).join('、') || '字段未知'}${loginSt.who ? '；账号：' + loginSt.who : ''}）`
                : '本机还没有凭证 —— 扫码，或粘一条 Cookie 上来')
              : '凭证状态读中…')),
          h('div', { 'data-dy-danger': '' },
            '🔒 凭证只落在本机插件家目录 ', h('b', null, 'douyin_cookie.txt'), '，**不上传、不进报告、不进日志**；',
            '换机器 / 退出登录后要重新弄一次。')),

        /* ── 7. 自动评论（🔴 危险，默认关闭）── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '🔴 自动评论（危险，默认关闭）'),
          h(ToggleRow, {
            label: '评论区自动评论并 @ 我',
            note: '默认关；开了之后它会在挑中的视频下面留评论，并 @ 你填的那个人',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          h('div', { 'data-dy-danger': '' },
            '⚠️ 开之前先看完这四行：',
            h('br'),
            '1. 抖音「@ 自己」到底行不行**未经验证** —— 可能发出去了但不推提醒，也可能直接失败；',
            h('br'),
            '2. 评论是**以你的账号名义**公开发出去的，别人看得见你的号；',
            h('br'),
            '3. 可能触发抖音**风控 / 限流**，重的话影响账号本身；',
            h('br'),
            '4. **默认关闭**，开启自负风险 —— 不确定就别开，只让它写报告就够了。'),
          sw('autoComment') ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-label': '' }, '评论执行器'),
            h('select', {
              'data-dy-input': '', value: ex,
              onChange: (e) => { setExr(e.target.value); patch({ commentExecutor: e.target.value }, '评论执行器') },
            },
              h('option', { value: 'off' }, 'off —— 只写报告，真不发评论（最安全）'),
              h('option', { value: 'builtin' }, 'builtin —— 用内置接口发（未验证，可能失败）'),
              h('option', { value: 'browser' }, 'browser —— Playwright 真浏览器点着发（最像人，需装浏览器）'),
              h('option', { value: 'http' }, 'http —— 交给外置评论执行器')),
            h('div', { 'data-dy-note': '' },
              '看到 autoComment 开着但执行器是 off：那就是「想发但发不出去」，只会写报告。'),
            ex === 'http' ? h('div', { 'data-dy-sub': '' },
              h('div', { 'data-dy-label': '' }, '外置评论执行器地址'),
              h('input', {
                'data-dy-input': '', value: httpUrl ?? '', placeholder: 'http://127.0.0.1:xxxx/comment',
                onChange: (e) => setHttpUrl(e.target.value),
                onBlur: () => { const v = String(httpUrl || '').trim(); setHttpUrl(v); patch({ httpCommentUrl: v }, '评论执行器地址') },
              })) : null,
            h(NumRow, {
              label: '每轮最多评论几条', min: 0, max: 20, value: cPerRun,
              note: '填 0 = 这一轮不发评论（只写报告）',
              onEdit: setCPerRun, onCommit: (v) => patch({ commentPerRun: v }, '每轮评论数'),
            }),
            h(NumRow, {
              label: '每天最多评论几次', min: 0, max: 50, value: cPerDay,
              note: '到点就停 —— 这是防止风控的最后一道闸',
              onEdit: setCPerDay, onCommit: (v) => patch({ commentPerDay: v }, '每天评论数'),
            }),
            h('div', { 'data-dy-label': '' }, '要 @ 谁'),
            h('input', {
              'data-dy-input': '', value: mention ?? '',
              placeholder: '填你要 @ 的那个人的抖音昵称；留空 = 不发评论',
              onChange: (e) => setMention(e.target.value),
              onBlur: () => { const v = String(mention || '').trim(); setMention(v); patch({ mentionName: v }, '要 @ 谁') },
            }),
            h('div', { 'data-dy-note': '' }, '留空的话它就不发评论了 —— 因为评论存在的意义就是 @ 那一下')) : null),

        /* ── 8. 通知 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '通知'),
          h('div', { 'data-dy-label': '' }, '通知方式'),
          h('select', {
            'data-dy-input': '', value: nm,
            onChange: (e) => { setNMode(e.target.value); patch({ notifyMode: e.target.value }, '通知方式') },
          },
            h('option', { value: 'toast' }, 'Windows 通知 —— 直接弹到屏幕上（推荐，零配置）'),
            h('option', { value: 'file' }, '只写文件 —— 报告落在 out/ 里，不额外提醒'),
            h('option', { value: 'webhook' }, 'webhook —— 推到群 / 机器人'),
            h('option', { value: 'both' }, '两个都要 —— 弹通知 + 推 webhook')),
          h('div', { 'data-dy-note': '' },
            nm === 'toast' ? '不用申请任何机器人：刷完一轮就在屏幕右下角弹一条，点开就是报告。'
              : nm === 'file' ? '⚠️ 这样刷完不会有任何提醒，报告只是一直躺在 out/ 文件夹里。'
              : ''),
          nm === 'webhook' || nm === 'both' ? h('div', { 'data-dy-sub': '' },
            h('div', { 'data-dy-label': '' }, 'webhook 预设'),
            h('select', {
              'data-dy-input': '', value: nPreset ?? 'custom',
              onChange: (e) => { setNPreset(e.target.value); patch({ webhookPreset: e.target.value }, 'webhook 预设') },
            },
              h('option', { value: 'custom' }, 'custom —— 自己填，原样 POST JSON'),
              h('option', { value: 'wecom' }, '企业微信机器人'),
              h('option', { value: 'feishu' }, '飞书机器人'),
              h('option', { value: 'dingtalk' }, '钉钉机器人')),
            h('div', { 'data-dy-label': '' }, 'webhook 地址'),
            h('input', {
              'data-dy-input': '', value: nUrl ?? '', placeholder: 'https://…',
              onChange: (e) => setNUrl(e.target.value),
              onBlur: () => { const v = String(nUrl || '').trim(); setNUrl(v); patch({ webhookUrl: v }, 'webhook 地址') },
            })) : null,
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'notify' || nm === 'file', onClick: onNotifyTest }, '发一条测试消息'),
            h('div', { 'data-dy-note': '' },
              nm === 'file' ? '换成别的通知方式才能测试' : '点一下就知道通不通 —— 通了会当场弹到你屏幕上'))),

        /* ── 8.5 私信与转发 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '私信与转发'),
          h('div', { 'data-dy-label': '' }, '昵称（给人看的）'),
          h('input', {
            'data-dy-input': '', value: dmTo ?? '',
            placeholder: '抖音昵称，例：某帅气用户',
            onChange: (e) => setDmTo(e.target.value),
            onBlur: () => { const v = String(dmTo || '').trim(); setDmTo(v); patch({ dmTo: v }, '私信发给谁') },
          }),
          h('div', { 'data-dy-label': '' }, '⭐ 稳定 ID（真正决定发给谁）'),
          h('input', {
            'data-dy-input': '', value: dmToId ?? '',
            placeholder: 'sec_uid 或 uid，例：MS4wLjABAAAA…',
            onChange: (e) => setDmToId(e.target.value),
            onBlur: () => { const v = String(dmToId || '').trim(); setDmToId(v); patch({ dmToId: v }, '私信发给谁（ID）') },
          }),
          h('div', { 'data-dy-note': '' },
            '⚠️ 抖音重名很常见，所以**认的是这个 ID，不是昵称**。',
            h('br'),
            'ID 从哪来：`douyin_notices` 返回的 `uid`/`sec_uid`；或者留空 —— 但那样只有在会话列表里昵称**唯一**时才肯发，重名会直接拒绝并列出候选。'),
          h('div', { 'data-dy-note': '' },
            '私信和分享卡片都发给他。⚠️ 抖音的分享面板只列「最近分享过的人」—— 从没聊过的人发不了卡片。'),
          h('div', { 'data-dy-note': '' },
            '🔴 不会自动发：发私信 / 发卡片 / 发评论前都会把草稿摆出来等你说一声（工具里有 confirm 闸，不点头只回草稿）。')),

        /* ── 9. 环境与账号 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '环境与账号'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'install', onClick: onInstall },
              st.venvReady ? '重装主依赖' : '装主依赖（建 venv）'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'check', onClick: onCheck }, '测一下'),
            h('div', { 'data-dy-note': '' },
              !st.venvReady ? (st.installing ? '正在装主依赖 —— 看下面的日志' : '还没装 → 先点「装主依赖」')
                : (st.loggedIn ? '都好了 → 点「测一下」验一遍' : '环境好了 → 在上面扫码或粘一条 Cookie'))),
          h('div', { 'data-dy-h': '' }, '环境路径（一般不用改）'),
          h('input', {
            'data-dy-input': '', value: py ?? '', placeholder: 'pythonPath（留空 = 用插件自己那个 venv）',
            onChange: (e) => setPy(e.target.value),
          }),
          h('input', {
            'data-dy-input': '', value: bin ?? '', placeholder: 'dshBin（dsh 可执行文件路径，留空 = 自己找）',
            onChange: (e) => setBin(e.target.value),
          }),
          h('input', {
            'data-dy-input': '', value: prof ?? '', placeholder: 'headlessProfile（真浏览器用的用户数据目录，留空 = 临时）',
            onChange: (e) => setProf(e.target.value),
          }),
          // ⚠️ 2026-10-21 删掉了「workspace（放 AGENTS.md 的那个目录）」这个输入框：
          //    人设现在只读插件自带的 prompts/persona.md，不再从外面任何目录读设定，
          //    少一个能指到别人插件去的口子。
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: Boolean(busy), onClick: onSaveAdvanced }, '保存环境路径')),
          h('div', { 'data-dy-kv': '' },
            '家目录：', String(st.home || ''), h('br'),
            '今天的报告：', String(st.report || ''))),

        /* ── 10. 操作 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '操作'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', 'data-primary': '', disabled: busy === 'run', onClick: onRun }, '现在跑一轮'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'report', onClick: onShowReport },
              report !== null ? '收起报告' : '看今天的报告'),
            h('button', { 'data-dy-btn': '', onClick: () => onOpen('out') }, '打开报告文件夹'),
            h('button', { 'data-dy-btn': '', onClick: () => onOpen('home') }, '打开家目录')),
          report !== null ? h('pre', { 'data-dy-pre': '' }, report) : null),

        /* ── 11. 日志区 ── */
        h('div', { 'data-dy-sec': '' },
          h('div', { 'data-dy-h': '' }, '日志'),
          (st.installTail || st.installLog) ? h('div', null,
            h('div', { 'data-dy-note': '' }, st.installing ? '正在装主依赖（进度）：' : '主依赖的日志（末尾）：'),
            h('pre', { 'data-dy-pre': '' }, st.installTail || st.installLog)) : null,
          st.installing ? h('div', { 'data-dy-note': '' }, '装的时候这页会自动刷新进度，不用手动点。') : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-scroll: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme / dsh-bili-scroll 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
          () => h(Panel),
        ))
      },
    }
  },
})
