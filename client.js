/**
 * dsh-douyin-scroll —— 浏览器半端（设置在「设置」里的一页，中文名「刷抖音」）
 * ============================================================================
 * 2026-10-22 从零重写的最小可用版：先确保**面板一定能显示**，再谈功能。
 * 之前那版 700+ 行、7 个折叠区，一旦某处报错整页就没了。
 * 这一版只有 4 块：状态 / 三步装机 / 刷什么 / 什么时候跑。
 *
 * ⭐ 关键设计：整个面板包在 Boundary（error boundary）里 ——
 *    任何子组件抛错只显示"这页出错了 + 重试"，不会再整块消失。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/douyin-duty'

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
[data-dy-page]{display:flex;flex-direction:column;gap:16px;padding:4px 2px 10px;max-width:660px;font-size:13px;}
[data-dy-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-dy-title]{font-size:13px;font-weight:600;}
[data-dy-sub]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dy-grow]{flex:1;min-width:0;}
[data-dy-btn]{padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy-btn][disabled]{opacity:.5;cursor:default;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy-input]:focus{outline:none;border-color:#3b82f6;}
[data-dy-badge]{font-size:11px;padding:3px 8px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-badge][data-on]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-dy-badge][data-off]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-dy-msg]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-msg][data-good]{color:#22c55e;}
[data-dy-msg][data-warn]{color:#f59e0b;}
[data-dy-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dy-sw][data-on]{background:#3b82f6;}
[data-dy-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s;display:block;}
[data-dy-sw][data-on] i{left:19px;}
[data-dy-pre]{margin:0;padding:9px 10px;border-radius:8px;max-height:180px;overflow:auto;
  font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dy-time]{flex:none;width:78px;box-sizing:border-box;padding:6px 8px;border-radius:7px;
  font-size:12px;font-family:inherit;text-align:center;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-dy-time]:focus{outline:none;border-color:#3b82f6;}
[data-dy-mini]{padding:5px 10px;border-radius:7px;font-size:11px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy-mini]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy-mini][disabled]{opacity:.5;cursor:default;}
[data-dy-mini][data-danger]{color:#f87171;}
[data-dy-wrow]{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;}
[data-dy-sep]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dy-sw': '', 'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    /**
     * ⭐ 关键：绝不能让组件抛错把整页搞没。
     *    用 error boundary 包住 —— 任何子组件炸了只显示一句提示 + 重试，
     *    而不是像之前那样整块空白（一个 TDZ 错误就能让面板彻底消失）。
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err: String((err && err.message) || err) }
      }
      render() {
        if (this.state.err) {
          return h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-title': '' }, '⚠️ 这个面板出错了'),
            h('div', { 'data-dy-sub': '' }, this.state.err),
            h('div', { 'data-dy-row': '' },
              h('button', {
                'data-dy-btn': '',
                onClick: () => this.setState({ err: null }),
              }, '重试')))
        }
        return this.props.children
      }
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      const [doctor, setDoctor] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [wins, setWins] = React.useState(null)
      const [upd, setUpd] = React.useState(null)
      const [ai, setAi] = React.useState(null)
      const [copied, setCopied] = React.useState('')

      const say = (t, tone) => { setMsg(t); setMsgTone(tone || '') }

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const [s, c] = await Promise.all([jget('/status'), jget('/config')])
            if (!alive) return
            setSt(s)
            if (c && c.config) setCfg(c.config)
          } catch (e) {
            if (alive) say('读设置失败：' + String((e && e.message) || e), 'warn')
          }
        })()
        return () => { alive = false }
      }, [])

      const patch = async (p, label) => {
        setBusy('patch')
        try {
          const r = await jpost('/config', p)
          if (r && r.config) setCfg(r.config)
          say(label || '已保存', 'good')
        } catch (e) { say('保存失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onDoctor = async () => {
        setBusy('doctor')
        try {
          const r = await jpost('/doctor', {})
          setDoctor(r)
          const bad = (r.must_fix || []).length
          say(bad ? ('检查完：' + bad + ' 项要修') : '检查完：环境没问题', bad ? 'warn' : 'good')
        } catch (e) { say('检查失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        try { await jpost('/install', {}); say('开始装依赖，进度看日志', 'good') }
        catch (e) { say('装依赖失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try { await jpost('/run', {}); say('已经开跑了，跑完看报告', 'good') }
        catch (e) { say('跑失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const onShowReport = async () => {
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.text ? r.text : '(今天还没有报告)')
        } catch (e) { say('读报告失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const saveKws = async () => {
        const lines = String(kws || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        await patch({ keywords: lines }, '关键词已保存')
      }

      /** 当前编辑中的自定义时段（`null` = 还没动过，跟随 cfg） */
      const winList = wins !== null ? wins : (Array.isArray(cfg && cfg.windows) ? cfg.windows : [])
      const setWinAt = (i, k, v) => {
        const next = winList.map((w, j) => (j === i ? { ...w, [k]: v } : w))
        setWins(next)
      }
      const addWin = () => { setWins([...winList, { start: '09:00', end: '11:00', label: '' }]) }
      const delWin = (i) => { setWins(winList.filter((_, j) => j !== i)) }
      const saveWins = async () => {
        // ⚠️ 只挑合法的时间，别把半截输入存进去（存了也不会跑，只会让人以为配好了）
        const clean = winList
          .map((w) => ({
            start: String((w && w.start) || '').trim(),
            end: String((w && w.end) || '').trim(),
            label: String((w && w.label) || '').trim(),
          }))
          .filter((w) => /^\d{1,2}:\d{2}$/.test(w.start) && /^\d{1,2}:\d{2}$/.test(w.end))
        const dropped = winList.length - clean.length
        await patch({ windows: clean }, dropped
          ? `已保存 ${clean.length} 个时段（${dropped} 个时间格式不对，没存）`
          : (clean.length ? `已保存 ${clean.length} 个时段` : '已清空自定义时段'))
        setWins(null)
      }

      const onCheckUpdate = async (force) => {
        setBusy('update')
        try {
          const r = await jget('/update' + (force ? '?force=1' : ''))
          setUpd(r)
          if (!r.checked) say('查不到最新版本（没发布或没网）', 'warn')
          else if (r.hasUpdate) say(`有新版本 v${r.latest}（当前 v${r.current}）`, 'warn')
          else say('已经是最新版 v' + r.current, 'good')
        } catch (e) { say('检查更新失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const loadAi = async () => {
        setBusy('ai')
        try {
          const r = await jget('/ai-usage')
          setAi(r)
          if (!(r.mcp && r.mcp.exists)) say('MCP server 文件缺失，插件包可能不完整', 'warn')
        } catch (e) { say('读使用说明失败：' + String((e && e.message) || e), 'warn') }
        finally { setBusy('') }
      }

      const copy = async (text, what) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
          else {
            const ta = document.createElement('textarea')
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
          }
          setCopied(what)
          say('已复制' + what, 'good')
          setTimeout(() => setCopied(''), 2000)
        } catch (e) { say('复制失败，手动选中吧', 'warn') }
      }

      if (!st || !cfg) {
        return h('div', { 'data-dy-page': '' },
          h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-sub': '' }, '读设置中…')))
      }

      const kwText = kws !== null ? kws : (Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '')

      return h('div', { 'data-dy-page': '' },

        /* ── 状态 ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-title': '' }, '刷抖音'),
              h('div', { 'data-dy-sub': '' },
                '峰谷时段自动刷一轮，把值得看的挑出来写成日报。不催你、不刷屏。')),
            h('span', { 'data-dy-badge': '' }, 'v' + (st.version || '?'))),
          h('div', { 'data-dy-row': '' },
            h('span', {
              'data-dy-badge': '',
              'data-on': st.loggedIn ? '' : undefined,
              'data-off': st.loggedIn ? undefined : '',
            }, st.loggedIn ? '已登录' : '未登录'),
            h('span', {
              'data-dy-badge': '',
              'data-on': st.venvReady ? '' : undefined,
              'data-off': st.venvReady ? undefined : '',
            }, st.venvReady ? '环境就绪' : '环境未装'),
            h('span', { 'data-dy-badge': '' },
              '今天 ' + (st.pickedToday != null ? st.pickedToday : 0) + ' / ' + (cfg.perDay != null ? cfg.perDay : 0)),
            h('div', { 'data-dy-grow': '' }),
            h('button', {
              'data-dy-btn': '', 'data-primary': '',
              disabled: busy === 'run', onClick: onRun,
            }, busy === 'run' ? '跑着呢…' : '现在跑一轮')),
          msg ? h('div', {
            'data-dy-msg': '',
            'data-good': msgTone === 'good' ? '' : undefined,
            'data-warn': msgTone === 'warn' ? '' : undefined,
          }, msg) : null),

        /* ── 三步装机 ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-title': '' }, '开始使用'),
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-btn': '', disabled: busy === 'doctor', onClick: onDoctor }, '① 检查环境'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'install', onClick: onInstall }, '② 装依赖'),
            h('button', { 'data-dy-btn': '', disabled: busy === 'report', onClick: onShowReport }, '③ 看报告')),
          doctor
            ? h('div', { 'data-dy-kv': '' },
              (doctor.items || []).map((it, i) => h('div', { key: 'd' + i },
                (it.state === 'ok' ? '✅ ' : it.state === 'warn' ? '⚠️ ' : '❌ ')
                + it.item + '：' + it.detail)))
            : null,
          h('div', { 'data-dy-sub': '' },
            '登录：命令行跑 node tools/qr-login.mjs start 扫码。扫完若还要短信/滑块验证，在那个浏览器窗口里做完。')),

        /* ── 刷什么 ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-title': '' }, '刷什么'),
          h('div', { 'data-dy-sub': '' }, '关注关键词，一行一个（留空 = 用内置默认那几组）'),
          h('textarea', {
            'data-dy-input': '', rows: 5, value: kwText,
            placeholder: '搞笑\n美食\n猫',
            onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', 'data-primary': '',
              disabled: Boolean(busy), onClick: saveKws,
            }, '保存'))),

        /* ── 什么时候跑 ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-title': '' }, '什么时候自己跑'),
              h('div', { 'data-dy-sub': '' }, '只在谷时跑（便宜）。全关 = 只在你点「现在跑一轮」时跑。'))),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-sub': '' }, '中午谷时 12:00–14:00')),
            h(Switch, {
              on: Boolean(cfg.noon),
              onChange: (v) => patch({ noon: v }, v ? '中午自动跑：开' : '中午自动跑：关'),
            })),
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' }, h('div', { 'data-dy-sub': '' }, '晚上谷时 18:00–次日 09:00')),
            h(Switch, {
              on: Boolean(cfg.night),
              onChange: (v) => patch({ night: v }, v ? '晚上自动跑：开' : '晚上自动跑：关'),
            })),

          /* ⭐ 自定义时段：和上面两个开关**叠加**（任意一个命中就跑），每个时段每天只跑一次 */
          h('div', { 'data-dy-sub': '', style: { marginTop: '4px' } }, '自定义时段（可选，跟上面两个叠加）'),
          winList.length
            ? winList.map((w, i) => h('div', { 'data-dy-wrow': '', key: 'w' + i },
              h('input', {
                'data-dy-time': '', type: 'time', value: String(w.start || ''),
                onChange: (e) => setWinAt(i, 'start', e.target.value),
              }),
              h('span', { 'data-dy-sep': '' }, '→'),
              h('input', {
                'data-dy-time': '', type: 'time', value: String(w.end || ''),
                onChange: (e) => setWinAt(i, 'end', e.target.value),
              }),
              h('input', {
                'data-dy-input': '', style: { flex: '1', minWidth: '60px' },
                placeholder: '备注（可空）', value: String(w.label || ''),
                onChange: (e) => setWinAt(i, 'label', e.target.value),
              }),
              h('button', { 'data-dy-mini': '', 'data-danger': '', onClick: () => delWin(i) }, '删')))
            : null,
          h('div', { 'data-dy-row': '' },
            h('button', { 'data-dy-mini': '', onClick: addWin }, '+ 加一个时段'),
            winList.length
              ? h('button', {
                'data-dy-mini': '', 'data-primary': '',
                disabled: Boolean(busy), onClick: saveWins,
              }, '保存时段')
              : null,
            h('div', { 'data-dy-grow': '' }),
            winList.length
              ? h('span', { 'data-dy-sub': '' }, '跨零点也行（23:00 → 02:00）')
              : null),

          h('div', { 'data-dy-sub': '' }, '两个都关 = 只在点「现在跑一轮」时跑。')),

        /* ── 给别的 AI 用（MCP） ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-title': '' }, '给别的 AI 用'),
              h('div', { 'data-dy-sub': '' },
                '想让 Claude Code / Cursor / 别的 agent 也能刷抖音？这插件自带一个 MCP server，配一段 JSON 就能接。'))),
          h('div', { 'data-dy-row': '' },
            h('button', {
              'data-dy-btn': '', disabled: busy === 'ai', onClick: loadAi,
            }, busy === 'ai' ? '读说明中…' : '看接入方式')),
          ai
            ? h('div', { 'data-dy-card': '', style: { background: 'transparent', border: 'none', padding: 0, gap: '8px' } },
              h('div', { 'data-dy-kv': '' }, 'MCP server：' + ((ai.mcp && ai.mcp.server) || '(缺失)')),
              ai.mcp && ai.mcp.exists
                ? null
                : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '⚠️ 找不到 tools/mcp-server.mjs —— 插件包不完整，重新安装'),
              h('div', { 'data-dy-sub': '' }, '把下面这段填进那个工具的 MCP 配置（路径已经按这台机器算好了）：'),
              h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.configText) || ''),
              h('div', { 'data-dy-row': '' },
                h('button', {
                  'data-dy-mini': '',
                  onClick: () => copy((ai.mcp && ai.mcp.configText) || '', 'MCP 配置'),
                }, copied === 'MCP 配置' ? '✓ 已复制' : '复制 MCP 配置'),
                h('button', {
                  'data-dy-mini': '',
                  onClick: () => copy((ai.mcp && ai.mcp.selfTest) || '', '自测命令'),
                }, copied === '自测命令' ? '✓ 已复制' : '复制自测命令')),
              h('div', { 'data-dy-sub': '' }, '自测（不接任何客户端，先看它自己通不通）：'),
              h('pre', { 'data-dy-pre': '' }, (ai.mcp && ai.mcp.selfTest) || ''),
              ai.doc
                ? h('div', { 'data-dy-row': '' },
                  h('button', {
                    'data-dy-mini': '',
                    onClick: () => copy(ai.doc, '使用说明'),
                  }, copied === '使用说明' ? '✓ 已复制' : '复制完整使用说明（贴给那个 AI 看）'))
                : h('div', { 'data-dy-msg': '', 'data-warn': '' }, '读不到 AI-USAGE.md：' + (ai.doc_error || '未知原因')))
            : h('div', { 'data-dy-sub': '' }, '点「看接入方式」会显示：MCP 配置、自测命令、给 AI 看的使用说明。')),

        /* ── 关于 / 检查更新 ── */
        h('div', { 'data-dy-card': '' },
          h('div', { 'data-dy-row': '' },
            h('div', { 'data-dy-grow': '' },
              h('div', { 'data-dy-title': '' }, '关于'),
              h('div', { 'data-dy-sub': '' }, '当前版本 v' + (st.version || '?') + ' · 报告在 ' + (st.report || 'out/'))),
            h('button', {
              'data-dy-btn': '', disabled: busy === 'update', onClick: () => onCheckUpdate(true),
            }, busy === 'update' ? '查着呢…' : '检查更新')),
          upd
            ? h('div', { 'data-dy-kv': '' },
              upd.checked
                ? (upd.hasUpdate
                  ? `有新版本 v${upd.latest}（当前 v${upd.current}）`
                  : `已是最新版（v${upd.current}）`) + (upd.source ? `　来源：${upd.source}` : '')
                : (upd.note || '查不到最新版本'),
              upd.hasUpdate && upd.how ? h('div', { style: { marginTop: '4px' } }, '升级：' + upd.how) : null)
            : null,
          upd && upd.tried && !upd.checked
            ? h('div', { 'data-dy-sub': '' }, '试过：' + upd.tried.map((t) => t.source + (t.ok ? ' ✓' : ' ✗')).join('、'))
            : null),

        /* ── 报告 ── */
        report !== null
          ? h('div', { 'data-dy-card': '' },
            h('div', { 'data-dy-title': '' }, '报告'),
            h('pre', { 'data-dy-pre': '' }, report))
          : null,
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

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-scroll', order: 31, label: '刷抖音' },
          () => h(Boundary, null, h(Panel)),
        ))
      },
    }
  },
})
