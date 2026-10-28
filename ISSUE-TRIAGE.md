# Issue 检查与本 fork 的处理

检查日期：2026-10-28。基线：上游 `7c6e2a2`（package.json 为 0.5.4）。
已阅读全部 7 个现存 issue、已有回复、#4 附件，以及现有 PR #5 的改动。
本表描述源码核对和本 fork 的修改；没有向上游提交 PR、回复或关闭 issue。

| Issue | 核对结果 | 本 fork 处理 |
|---|---|---|
| [#1 私信选择器被「主」污染](https://github.com/NEWJO123/dsh-douyin-scroll/issues/1) | 上游回复说明 0.5.1 已修；0.5.4 中选择器已恢复 | 保留现有选择器回归检查，不重复改动 |
| [#2 签名器与异常输出](https://github.com/NEWJO123/dsh-douyin-scroll/issues/2) | 上游已有安装器与浏览器兜底，缺少部分失败分支 | Node 不存在、签名子进程失败、无效/空 JSON、HTTP 错误或签名未接受时走只读浏览器兜底；两条路都失败明确报错 |
| [#3 关键词不影响推荐](https://github.com/NEWJO123/dsh-douyin-scroll/issues/3) | 维护者确认当前只读推荐流，关键词是报告标注 | 面板直接注明「不参与推荐流检索或过滤」；未实现关键词搜索或偏好过滤 |
| [#4 签名器 SDK 缺失](https://github.com/NEWJO123/dsh-douyin-scroll/issues/4) | 上游 0.5.3 已加入 signer-setup；附件还有 Node 路径问题 | 共用 #2 的失败处理，取消硬编码 Node；未声称 SDK 已在真实账号上验证 |
| [#6 Windows 桌面版后台启动失败](https://github.com/NEWJO123/dsh-douyin-scroll/issues/6) | ASAR 入口错误使用独立 Node，版本探针有假阳性；webServer 被强依赖 | ASAR 使用 Electron + ELECTRON_RUN_AS_NODE + --expose-internals；探针必须成功退出；webServer 可选；增加缺 profile 的提示和创建命令，兼容 DSH 自动初始化 |
| [#7 Node 路径、UTF-8、收件人 ID](https://github.com/NEWJO123/dsh-douyin-scroll/issues/7) | 固定 Windows 路径仍存在，Python 输出和 ID 文档有差异 | DOUYIN_NODE/PATH 探测、按平台选择 venv、UTF-8 标准输出；分享拒绝数字 uid；旧 api-reply 改走现有浏览器写入器，--confirm 前只给草稿 |
| [#8 Edge 遗留进程锁 profile、错误被吞](https://github.com/NEWJO123/dsh-douyin-scroll/issues/8) | 启动后不观察进程退出，MCP 会丢失底层错误 | 浏览器启动监听 error/exit；复用、读 Cookie 和关闭均验证完整 profile；MCP 保留 error/hint/detail/退出信息；不广泛杀进程、不换空白 profile 掩盖锁问题 |

另外修复审查中发现的风险：

- 新安装自动发送默认关闭；后台 MCP 逐次检查开关、联系人稳定 ID 和评论权限。
- 昵称与 ID 成对解析，不再把显式昵称和默认 ID 混用。
- uv 下载固定官方版本 0.13.6 和六个平台/架构的 SHA-256。拒绝无校验缓存或校验失败的下载；移除第三方代理兜底。
- 设置变更日志只记录字段名；URL 脱敏覆盖用户名、密码、查询参数和片段。
- MCP 补齐私信/评论记忆、douyin_remember、回复类通知和楼根；文档与实际 MCP 参数对齐。
- 分享卡片点击后没有成功提示时返回 pending，停止继续发送理由；需要人工核实后再决定重试。
- 公开克隆不再因缺维护者私有人设或本机 hook 配置而被自检判失败。

## PR #5 的核对

[PR #5](https://github.com/NEWJO123/dsh-douyin-scroll/pull/5) 提议对 webhook 做 SSRF 限制。
未直接采纳：其 DNS 检查与随后 fetch 的连接解析分离，仍需处理 DNS 重绑定及重定向，
同时会影响用户明确配置的本机/内网 webhook。本 fork 未声称解决 webhook SSRF 或宿主 HTTP 鉴权；
这些边界需要结合 DSH 的请求鉴权、网络部署及内网 webhook 兼容要求单独设计。

## 验证与限制

本机使用 Node 24.14.0、Python 3.14.3，全部为离线验证：

- `node selfcheck.mjs`：358 通过，0 失败（包含面板渲染、现有记忆和消息投递检查）。
- `npm test`：26 个 Node 行为回归，通过。覆盖 MCP 子进程协议、收件人、确认闸、后台权限、错误透传、记忆/通知、CDP profile、启动退出、ASAR 和下载校验。
- `python3 -m unittest discover -s tests -p 'test_*.py'`：9 个回归，通过。HTTP 和浏览器子进程均被替身替换。
- `git diff --check`：通过。

没有真实登录抖音、发送私信/卡片/评论、安装签名 SDK、运行 DSH 桌面版或发布 npm 包。
Windows/Electron 启动已按 issue 证据与运行时分派测试修复，但尚需目标环境实测。
CDP 校验需要插件以 `--enable-automation` 启动浏览器；旧插件浏览器需手动关闭后重新启动。
仅粘贴 Cookie 不等于浏览器 profile 已登录；写入功能仍需该 profile 完成扫码登录。

依据：

- [Electron ASAR 文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [DSH CLI 与 profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [uv 0.13.6 官方 release](https://github.com/astral-sh/uv/releases/tag/0.13.6)
