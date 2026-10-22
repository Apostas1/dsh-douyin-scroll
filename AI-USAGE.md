# 给别的 AI 用：把「刷抖音」接进你自己的工具里

> 这份文档是给 **AI 助手** 读的（Claude Code / Codex / Cursor / Cline / 另一个 DSH …）。
> 人不用看也行 —— 人只需要知道「把下面那段配置复制过去」。

---

## 0. 一句话

`dsh-douyin-scroll` 除了是 DSH 插件，还带了一个**标准 MCP server**（stdio）。
任何支持 MCP 的工具，配上它就能用同一套抖音能力：
取候选、读评论、读通知、发私信、发分享卡片、发评论。

---

## 1. 接进来（复制粘贴）

先找到插件目录，两种常见位置：

| 怎么装的 | 目录长这样 |
|---|---|
| DSH 里装（桌面版） | `<DSH_HOME>\profiles\<profile>\node_modules\dsh-douyin-scroll` |
| 源码 / 本地目录 | 你自己 clone 的那个文件夹 |

**MCP 配置（JSON，Claude Desktop / Cursor / Cline 通用）**：

```json
{
  "mcpServers": {
    "douyin": {
      "command": "node",
      "args": ["<插件目录>/tools/mcp-server.mjs"],
      "env": {
        "DOUYIN_HOME": "<插件家目录>"
      }
    }
  }
}
```

**`DOUYIN_HOME` 填什么？**
默认是 `<DSH_HOME>/douyin-duty`（Windows 上通常是 `D:\DeepSeek\dsh-data\douyin-duty`）。
这个目录里存着你的登录 Cookie、配置、报告 —— **它跟 DSH 里的插件共用同一份**，
所以 DSH 里登录过了，这里不用再登。

**别的写法**：

```bash
# 命令行单次测试（手打 JSON-RPC 太麻烦，先看工具列表就够了）
node <插件目录>/tools/mcp-server.mjs --selftest

# 如果客户端只能给一条命令（比如某些 shell 配置）
node "<插件目录>/tools/mcp-server.mjs"
```

> ⚠️ **不要**用 `npx` 或 `npm install` —— 这个 MCP server **零依赖**，只用 Node 内置模块。
> Node 版本要求 ≥ 22（和插件本体一致）。

---

## 2. 工具清单（12 个）

### 只读（随便调，什么都不改）

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `douyin_guide` | 返回本文档全文 | **第一次接进来先调这个** |
| `douyin_status` | 今天跑了没跑、挑了几条、额度、报告路径 | 想知道"现在什么情况" |
| `douyin_doctor` | 环境体检（9 项） | 装完 / 换设备 / 报错时 |
| `douyin_whoami` | 登录还在不在、当前是哪个号 | 任何操作前不确定登录态 |
| `douyin_forward` | 拉推荐流候选 + 打分 + 官方分享链接 | **主入口**：要推荐视频就调它 |
| `douyin_comments` | 读一个视频的评论（含楼中楼） | 判断「这视频好不好玩」 |
| `douyin_notices` | 谁 @ 了你 / 谁评论点赞关注 | 回消息前先看 |
| `douyin_at_me` | ⭐ **谁在评论区 @ 了我**（带"回过没有"+ 我在这条视频下说过什么） | 回评论前调它 |
| `douyin_im_read` | 读私信会话（带 from: me/them） | 看对方最近说了什么 |

### 会发东西（**必须 `confirm: true`**）

| 工具 | 干什么 |
|---|---|
| `douyin_share_card` | 发**分享卡片**（不是文字链接）给好友，可带一句 reason |
| `douyin_dm` | 发一条私信 |
| `douyin_comment_reply` | 发评论 / 回复某条评论 |

---

## 2.5 ⭐ 记忆（持续聊天靠它）

`douyin_im_read` 返回里有一块 `context`，是**它记得的这个人**：

```json
"context": {
  "who": { "nick": "示例好友" },
  "rounds": 3,
  "facts": ["在杭州", "养了只橘猫"],
  "recent": [ { "from": "them", "text": "上次说的那个视频…", "kind": "text" } ],
  "total_remembered": 11
}
```

**回话之前先看 `context.recent` 和 `context.facts`**：

- `facts` 是长期事实（住哪、养什么、在意什么）—— 别再问一遍
- `recent` 是之前聊过的 —— 别把说过的话当没说过
- `context.note` = "这个人以前没聊过" ⇒ 那就当第一次见，别装熟

**哪些会自动进记忆**：

- 每次 `douyin_im_read` 读到的会话
- 每次 `douyin_dm` / `douyin_share_card` 发出去的内容
- 每次 `douyin_comment_reply` 发的评论（评论区记忆）

**长期事实要主动记**：发现对方说了值得记住的事（"我搬到成都了"/"我家猫叫豆豆"），
用 `douyin_remember { to_id, facts: ["搬到成都了", "猫叫豆豆"] }` 记下来。

**记忆边界**：

- 只存**本机** `$DOUYIN_HOME/memory/`，不上传
- 每人最多 80 条、每条 200 字
- 没有记录就是没有 —— **绝不用"我记得你说过…"编造**

---

## 3. 四条硬规矩（违反就是事故）

### ① 🔴 发东西前必须问使用者

这三个工具的 `confirm` 默认 **不传 = 不发送**，只返回草稿/预览。
流程永远是：

1. 先调一次（不带 confirm）拿到 `needsConfirm: true` + `draft`/`preview`
2. **把草稿原样给使用者看**，问他行不行
3. 他明确点头了，再用**同样的参数 + `confirm: true`** 调一次

⚠️ 别自作主张替使用者点这个头。抖音上发出去的东西是**他的号**在说话。

### ② 🔴 先卡片，后文字

要给使用者发视频，**只调 `douyin_share_card`**，把"为什么值得看"写进它的 `reason` 参数。
它内部会**先发卡片、等几秒、再发文字**。

❌ 不要先调 `douyin_dm` 发文字、再调 `douyin_share_card` 补卡片 —— 顺序会反，
对方先看到一句话、却不知道在说哪条视频。

### ③ 🔴 不读画面、不做 ASR/OCR

这个插件**看不到视频内容**。判断依据只有：
文案 / 标签 / 作者 / 时长 / 点赞·评论·收藏·转发 / 高赞评论文本。

所以：

- 不要问它"视频里讲了什么" —— 它不知道
- 不要说"我看了一下这个视频" —— 它没看
- 判断结论要写明是**基于哪些文本证据**
- 证据不够就写「判断不了」，**别硬猜**

### ④ 🔴 实话实说

- 没拿到就说没拿到，不许编
- 没核实就说"未核实"（比如评论发出去了但评论区还没刷出来）
- `ok: false` 就如实报告，别把失败包装成成功

---

## 4. 典型流程

### A. 「给我找几条好玩的视频」

```
1. douyin_forward { top: 10 }          → 拿到候选清单
2. 对前 2-3 条调 douyin_comments       → 看高赞评论
3. 按"值不值得花 15 秒点开"挑，写清单给使用者
```

### B. 「把第 2 条发给我」

```
1. douyin_share_card { aweme_id: "...", reason: "..." }        → 拿预览，给使用者看
2. 使用者点头
3. douyin_share_card { aweme_id: "...", reason: "...", confirm: true }   → 真发
```

### C. 「有人 @ 我，回他」

```
1. douyin_notices                      → 拿到 at_n 和具体条目（含 aweme_id / comment_id）
2. 想清楚回什么，写成草稿
3. douyin_comment_reply { aweme_id, comment_id, text }                     → 拿草稿
4. 使用者点头
5. douyin_comment_reply { ..., confirm: true }                              → 真发
```

> ⚠️ MCP 版**不支持真 @ 提及**（那需要 UI 点选，只有 DSH 里的 `douyin_comment_reply`
> 带 `mention_*` 参数时才会走 UI）。MCP 版发的 `@昵称` 只是普通文字，不会变蓝、对方收不到通知。

---

## 5. 常见问题

| 现象 | 原因 / 怎么办 |
|---|---|
| `还没装运行环境` | 去 DSH 设置页「刷抖音 → ② 装主依赖」点一下；或看 `douyin_doctor` 的 `must_fix` |
| `还没有登录` | DSH 设置页扫码；或 `node tools/qr-login.mjs start` 扫码；或把 Cookie 粘进设置页 |
| `取候选失败` | 推荐流可能这轮返回空，过会儿再试；也可能是 Cookie 过期（先 `douyin_whoami`） |
| 发卡片/私信超时 | 无头浏览器起得慢（第一次要 10-20 秒），或者 Chrome/Edge 没装 |
| 客户端连不上 | 检查 `DOUYIN_HOME` 是不是指对了；`node tools/mcp-server.mjs --selftest` 先自己跑一遍 |

---

## 6. 这个 MCP server 的边界（诚实版）

- **不做**「跑一轮 → 写日报」：那是 DSH 插件的值班链路（要 headless 会话），MCP 版不复制
- **不做**回读核实：卡片/私信发完，MCP 版只报"发出去了"，真落地没落地请使用者自己看一眼
- **不做**真 @ 提及（见上）
- **不读**画面/语音（见规矩 ③）
- **不联网上传**任何东西；Cookie 只在本机
