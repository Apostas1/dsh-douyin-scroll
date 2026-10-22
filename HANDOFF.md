# 交接文档 · dsh-douyin-scroll

> 写于 **2026-10-22 10:28**，接手的人（或下一轮的我）从这里看起。
> 插件版本 `0.1.0`，仓库 `D:\aiagent\deepseek\dsh-douyin-scroll`，工作区**有未提交改动**。

---

## 一句话现状

代码这边本轮改动全部落地、`node selfcheck.mjs` **59 通过 / 0 失败**；采集、发评论、真 @、删评、私信五条链路都在真号（贪吃的可爱大肥鱼）上跑通过。**唯一没做的是 DSH 宿主侧的验证**——需要重启桌面端把新 `index.js` 装上，再跑一轮值班。

---

## 一、本轮改了什么（代码）

| 文件 | 改动 |
|---|---|
| `index.js` | ① `state.json` 跨天自愈（`rollDay()`，加载/健康/状态三处调用）；② 证据包带 `dropped` / `thresholds`；③ `buildEvidence` 传 `--limit`（「每次最多筛选几个」生效）；④ 手动跑一轮也记 `lastRunAt/lastWhy/count`；⑤ 删掉死配置 `source`；⑥ `maxPerRun` 上限收到 30；⑦ `douyin_comment_reply` 新增 `mention_name/mention_uid/mention_secuid`，并加「@ 自己」拦截闸 |
| `tools/forward-pick.py` | 读 `collector.json` 的两个阈值（文案太短且评论少才丢）、新增 `--limit`、输出 `dropped` 硬筛计数（no_desc / too_short_video / short_and_quiet） |
| `tools/comment-api.mjs` | 支持 `--mention-name/--mention-uid/--mention-secuid` 生成 `text_extra`；注释里写死结论：**API 直发的 mention 会被服务端剥 sec_uid，别指望通知** |
| `tools/notice-read.py` | 🔴 修复 **type 31**（回复了你，含豆包/AI 分身）的嵌套结构解析：`it.comment.comment.{text,cid,user}` + `parent_id` + `label_text`（AI分身）。之前豆包回复显示成空，就是这个 bug |
| `tools/forward-run.mjs` | 显式把 `DOUYIN_HOME` 传给 Python；打印硬筛计数 |
| `selfcheck.mjs` | 新增 4e 段 5 项检查（阈值生效 / dropped / --limit / 跨天翻页），并把新工具列入清单 → 59 项 |
| `client.js`、`README.md`、`PUBLISH.md`、`AGENTS.md`、`prompts/duty.md`、`prompts/persona.md` | 文案对齐现状；persona 新增「@ 主人必须带主人两个字」 |
| **新增** `tools/comment-delete.mjs` | 删自己的评论：无头页面里 POST `/aweme/v1/web/comment/delete/`，页面补签名，`status_code=0` 即成功 |
| **新增** `tools/comment-mention-ui.mjs` | **真 @ 唯一可靠路径**：UI 点选流程（滚输入区 → 真实点击唤起 DraftJS → CID 键盘打 `@` → 点选弹层那一行 → 补正文 → 点右下红色箭头） |

---

## 二、本轮实测出来的硬结论（别再走回头路）

1. **真 @ 只能 UI 点选**。API/XHR 直发时，不管 payload 怎么对齐前端抓包，服务端都会把 `text_extra.sec_uid` 剥掉：名字会变蓝，但**点开空页、对方收不到通知**。实验矩阵（D=字段序对齐，E=页面内 XHR）都是死路。
2. **`11-1289250254` 是主人主号的真实网页版 uid**，不用再找「真数字 uid」——它不变、也填对了。问题从来不是 uid，是 sec_uid 被剥。
3. **别人（含豆包）回复我，走通知**，不要翻评论区。AI 分身的回复楼层在网页列表/ DOM 里都不渲染；`notice-read.py --raw` 的 type 31 里有全文、cid、parent_id。
4. **删评**：`GET /comment/list/delete/` 是 404（Janus），`POST /comment/delete/` 在页面里 200；回读以列表里 cid 消失为准。
5. **评论可见性会抽风**：新评论常进审核，列表/API 时有时无；**通知到达才是最终判据**，别把「列表没刷到」当失败。
6. 一天连发十几条评论后，号可能被限流（评论时隐时现）。控制频率、别立刻重试轰炸。

---

## 三、家里数据现状（`D:\DeepSeek\dsh-data\douyin-duty`）

- `state.json`：`day=2026-10-22`，`count=0`，`picked=0`（今天额度 0/5，干净）。
- `seen.md`：101 行（判重表 + 事故记录 + 评论记录）。
- `out/2026-10-22.md`：已建，记录了今天评论区 @ 的 6 条（不带 `###`，不占当天挑选额度）。
- `out/archive/2026-10-21-before-reset-2006.md`：主人 20:06 额度重置时归档的旧日报。
- 今天已做过的动作：
  - 5 条视频评论区 UI @（猫/狗/猪/砂锅/床铃，单条 19.1s）；
  - 1 条回形针机械蝴蝶 @（19.1s，已上榜，cid `7699151254874522377`）；
  - 5 条新一批 @（猫狸/土狗/定格汉堡/香河肉饼/萨摩耶，单条 19.0–19.2s；**土狗、肉饼、萨摩耶 3 条已上榜**；猫狸、定格汉堡 2 条 10 小时后仍不在列表，疑限流/隐藏，通知为准）；
  - 私信「主人，爱你。」已发、回读确认。
- 昨天（10-21）还做过：豆包科普问答（问题 cid `7699141858560541466`，豆包回复 cid `7699142702855914259`），回答已用 API 挂在问题下（cid `7699148357889295119`）+ UI 顶层评论带真 @ 发给主人。

---

## 四、待办 / 只能等 DSH 宿主验证

1. **重启 DSH**，让新 `index.js` 生效（`tools/*` 每次现读，不用等）。重启后确认：
   - 插件能挂载（`duty.log` 出现「已挂载」）；
   - 设置页不再出现「采集来源 / 工作区」；
   - `state.json` 自动保持当天；
2. 设置页点「**测一下**」（会话体检 + 试取候选）；
3. 点「**现在跑一轮**」，确认：报告头部有 `dropped` 跳过计数；当天配额最多 5 条；跑完 `state.json` 的 `lastRunAt/lastWhy/count` 有值；
4. `health.json` 的 `pickedToday` 与日报 `###` 数一致；
5. 可选：昨天 06:46 主人那条 @（cid `7699008467436798777`）还没单独回，要补就补；
6. 最后一轮 5 条 @ 里，猫狸和定格汉堡 2 条 10 小时后仍未在列表出现（疑限流），通知是否到达需主人确认；

---

## 五、自己怎么验（命令都在插件根目录跑）

```bash
node selfcheck.mjs                                   # 应 59 通过 / 0 失败
python tools/smoke.py                                # 判断层自检（离线）
node tools/comment-mention-ui.mjs --aweme <id> --name 某帅气用户 --dry   # 只到点选人，不发布
python tools/notice-read.py                          # 通知（type 31 已能读豆包回复）
node tools/im-send.mjs --to 某帅气用户 --read         # 私信只读
```

---

## 六、边界与红线（本轮遵守情况）

- B站三处（`D:\DeepSeek\bili-persona`、`D:\DeepSeek\dsh-data\bili-duty`、任何 `dsh-bili-scroll` 代码）**只看没改**。
- Cookie、`dmToId`、日报正文**没有发到任何外部地方**；本文档也不含这些值。
- 发东西之前都拿到了主人明确指令；评论区发言全部带「主人」两个字。
- 本轮所有改动**尚未 commit**：12 个修改 + 2 个新增文件（`git status` 可见）。要发布时先按 `PUBLISH.md` 第 5 步自查，再决定私有一段时间还是公开。

---

## 七、已知小坑（留给下一位）

- `comment-mention-ui.mjs` 发布成功后会 `ws.close()` 再退出；如果哪天又挂住不退出，先查这行是不是被改掉了。
- `comment-api.mjs` 的 `mention_*` 参数**只用于纯落款**（会变蓝、没通知、点开空页）；别拿它做「喊人来看」。
- `notice-read.py` 的 `TYPE_NAME` 里 31 已标「回复了你的评论（含 AI 分身）」；新增通知类型记得补。
- `forward-pick.py` 的默认 `HOME` 仍写死 `D:\DeepSeek\dsh-data\douyin-duty`；换机器要改或用 `DOUYIN_HOME`。
