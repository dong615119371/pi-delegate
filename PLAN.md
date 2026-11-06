# PLAN — 会话间互通（session relay）

> 覆盖两个包：本仓（pi-delegate）+ pi-async-jobs（宿主）。
> pi-crew 不动。pi-mobile 已弃用，不做适配（其 `pi --mode rpc` stdin JSONL 路线仅作知识储备）。

## 目标

让 PI 与 OpenCode 的 Agent 在**任意会话、任意两端**之间直接发消息、问答，
消灭"人肉搬运工"。四向覆盖：

| 方向 | 靠什么 |
| --- | --- |
| OpenCode → OpenCode | OpenCode server API（已实测通） |
| PI → OpenCode | 同一个 MCP 服务 |
| OpenCode → PI | MCP 写邮箱文件 → pi-async-jobs 桥注入 |
| PI → PI | 同上 |

## 范围

**做什么**

1. **本仓（pi-delegate）：本地 MCP 服务**，零外部依赖纯 Node，4 个工具：
   - `list_sessions` — 列活跃会话（OpenCode 走 `GET /api/session`，PI 走桥注册表），按标题关键词筛选
   - `read_session` — 读目标会话最近 N 条 / 最新输出
   - `send_session` — 单向推送，即发即走（排队消息语义，等价 Ctrl+Q follow_up）
   - `ask_session`（核心）— 提问 → 等对方干完 → 拿回最终结论
2. **pi-async-jobs：PI 侧收件桥**（宿主内新组件，宿主本来就加载于每个 PI 会话）：
   - 会话启动时注册：session id / 名字 / cwd / 心跳（写 `~/.pi/agent/mailbox/registry/<id>.json`）
   - `fs.watch` 监视自己的收件箱文件（`~/.pi/agent/mailbox/box/<id>.jsonl`），毫秒级事件驱动，不轮询
   - 收到即以**排队消息**注入（`pi.sendMessage`，`deliverAs:"followUp"` 即 Ctrl+Q 语义；信封逐条到达、量级低，不套宿主的批量投递/防风暴——那是为后台作业扇出设计的）
   - ask 的回执：对方 agent 回合结束时把应答的 ask id 记进 feeds 记录（`answering` 数组），发问方（MCP）fs.watch 等待

**明确不做什么**

- 不为 pi-mobile 做任何适配
- 不做跨机器、不做鉴权体系（本机 127.0.0.1 / 本地文件）
- 不改 pi-crew
- 不做消息撤回、已读回执这类 IM 功能

## 已定的关键设计 / 决策记录

- **信封**：JSONL，一行一消息 `{id, from, to, type: "msg"|"ask", body, ts}`（实现期定案：不设 `"reply"`/`replyTo`，回执改走 feeds 的 `answering` 关联，一个回执同时回答一轮里吸收的多个 ask）
- **邮箱布局**：`~/.pi/agent/mailbox/` 下三个子目录——`box/<id>.jsonl` 收件箱（投递后保留，离线补投）、`feeds/<id>.jsonl` 输出流（每回合一条最终输出，带 `answering`）、`registry/<id>.json` 存活注册（30s 心跳）
- **PI 侧注入语义**：文件邮箱 + `fs.watch` + 宿主 `pi.sendMessage` 投递
  （淘汰：pi-mobile rpc stdin——覆盖面只有网关会话；HTTP push hub——引入常驻进程不值）
- **OpenCode 调用**：`opencode api` CLI 路由（免手解 token）。实现注意两条实测坑：
  1. **必须 PowerShell 或直接 spawn**——bash 调 `.cmd` shim 会吞参数；
  2. **路径带 `/api` 前缀**（`GET /api/session`），打 `/session` 撞 SPA 首页
- **等待对方**：OpenCode 目标用 `POST /api/experimental/session/{id}/wait`（experimental，落 API 失败时降级轮询 message 接口）；PI 目标用 feeds 的 `answering` 关联 + fs.watch（250ms 轮询版已在审查后改为 fs.watch 事件驱动）
- **离线排队免费**：消息即文件，对方没起就躺着，注册心跳判存活

## 待确认

（无。剩余均为实现细节，按上面已定决策执行。）

## 审查待办（双轴 code-review 后未修项，记录备查）

- 跨仓协议重复：目录常量 / `Envelope` / `ensureDirs` 在两仓各写一份，靠注释同步——宜提取共享协议定义（需发布形态配合，暂记）
- `session-mcp.ts` 内部小重构：解包形状、`blockTexts()` 提取、`send_session`/`ask_session` 前缀去重、`ok`/`fail` 重命名、`resolveTarget` 的 ref 语义拆分
- `session-mcp.ts` 可拆为 API 客户端 / 邮箱客户端 / 工具定义 / JSON-RPC 传输四块
- 降级判据 `ts > sentAt` 依赖 OC 消息时间戳语义，尚未验证 `time.created` 含义
- 防风暴不复用是刻意取舍（见上），若将来信封量级变大（群发/广播）需重估

## 验证

一次能得出通过／失败结论的闭环，共 3 条，全过即完成：

1. **PI → OpenCode**：PI 会话里调 `ask_session` 问一个 OpenCode 会话，拿到对方最终结论
2. **OpenCode → PI**：OpenCode 会话里调 `ask_session` 问一个 PI 会话，PI 侧被排队消息唤醒并回复，结论回流
3. **PI → PI**：两个 PI 会话 `send_session` / `ask_session` 往返一轮

辅助判据：对方会话离线时消息排队不丢，重启后送达；不打断对方正在进行的回合（排队而非抢占）。

## 状态

已完成（三条闭环全过）：

- [x] pi-async-jobs `async-jobs/mailbox.ts` 收件桥（registry / box / feeds，followUp 投递，离线排队，agent_end 回执）
- [x] pi-delegate `session-mcp.ts` MCP 服务（4 工具，OpenCode 走 `opencode api` exe 直 spawn，pi 走邮箱）
- [x] 接线：pi `mcp.json` + OpenCode `opencode.jsonc` 各一条 `pi-relay`
- [x] 闭环一 PI→OpenCode ✅ / 闭环二 OpenCode→PI ✅ / 闭环三 PI→PI ✅
- [ ] code-review 复审 + 测试残留清理（用户自行 commit）

验证中发现并修复的坑（实现备忘）：

1. OC `POST .../prompt` 的 body 是 `{text}`（不是 `{parts:[...]}`）；
2. OC 消息列表**新在前**且顶部常有 `idle` 条目，取“最新回复”必须跳过非 assistant 条；
3. `POST /api/experimental/session/{id}/wait` 正常工作但返回**空响应体**（108ms / exit 0）——“请求成功”不能以“有 JSON 响应体”为准；
4. user 消息的文本可能在 `payload.text` 而非顶层 `text`；
5. Windows 下传 JSON 参数只有 `spawnSync` 参数数组可靠：bash 调 `.cmd` shim、PowerShell 调 exe 都会破坏内嵌引号。
