# pi-delegate

> 中文说明 · [English](README.en.md)

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.1.5-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="models" src="https://img.shields.io/badge/models-any%20the%20CLI%20reports-brightgreen">
</p>

把活外包给 [OpenCode](https://opencode.ai) CLI，并彻底打通 Pi 与 OpenCode 之间多会话 Agent 实时互联（Session Relay）。

## 为什么做这个

由于 OpenCode 官方收紧了对 Zen 免费模型的外部调用，导致广大开发者陷入了没有免费模型可以调用的困境。我们带来了 **pi-delegate**：通过官方 CLI 合规调度任务，配合 [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs) 打造极致的异步外包体验。

而在长周期、大规模工程项目中，我们经常需要同时开两个甚至多个会话：**一个负责写业务代码，另一个负责深度安全与架构审计**。过去开发者只能在会话之间充当“人肉搬运工”，手动复制粘贴两端的上下文和反馈。

**在 v0.1.5 中，我们推出了跨会话中继（Session Relay）——彻底终结人肉搬运工历史！**

---

## 核心能力一：跨会话中继 (Session Relay MCP)

在长周期、大规模工程项目中，我们经常需要同时开两个甚至多个会话：**一个负责写业务代码，另一个负责深度安全与架构审计**。过去开发者只能在会话之间充当“人肉搬运工”，手动复制粘贴两端的上下文和反馈。

**pi-delegate 内置了原生的本地跨会话中继服务（`session-mcp.ts`）——彻底打通 Pi 与 OpenCode 任意两端双向对话！**

### 1. 底层通信架构：拒绝文件黑板报，纯内存管道直达

本项目**彻底放弃了传统的磁盘文件信箱与共享黑板报**（无文件锁冲突、无死信残留、无游标丢失），采用两端最原生的高性能通信技术：

- **发往 OpenCode 会话**：直接通过官方 CLI 路由调用本地服务（`POST /api/session/{id}/prompt`），前台桌面/终端界面由其后台服务驱动**实时打字同步更新**，调用 `/wait` 原生等待完成；
- **发往 Pi 会话**：基于 Node.js 原生**命名管道 IPC**（Windows 下为 `\\.\pipe\pi-session-<id>`，POSIX 下为 `/tmp/pi-session-<id>.sock`）。
  - **连接即上下文 (Connection IS Context)**：`ask_session` 建立管道连接并发起提问，保持连接在内存挂起；目标 Pi 在本轮思考完毕时直接顺着该 Socket 回推答案并关闭连接。天然支持多并发提问，零串台、零文件 I/O！
  - **排队注入 (Ctrl+Q 语义)**：接收端在进程内部调用官方 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`，绝不粗暴打断正在执行的工具，当前回合自然结束后无缝衔接。
  - **生命周期零残留**：管道随目标 Pi 进程生灭由操作系统内核自动管理；进程退出管道即消失，绝无死信积压。

```
[ 发起方 (代码会话) ]                           [ 目标方 (审计会话 Pi) ]
        │                                                  │
 1. 调 ask_session("帮我审计...")                           │
        │                                                  │
 2. net.connect(\\.\pipe\pi-session-xxx) ─────────────────>│
        │ (发送 JSON 帧，保持长连接挂起)                   │ 3. 命名管道接收，内存直达
        │                                                  │ 4. pi.sendMessage 排队注入 (Ctrl+Q)
        │                                                  │ 5. 目标 Agent 思考、调工具、出具报告
        │                                                  │
 7. 拿到报告，自动唤醒继续写代码！ <─────────────────────── 6. agent_end: 顺着 Socket 原路写回结论
```

### 2. 五把跨会话协同神器

通过标准本地 MCP 协议，大模型可随时调用以下 5 把武器：

| 工具 | 作用 | 典型场景 |
| --- | --- | --- |
| `list_sessions` | 毫秒级发现本机当前存活的所有 PI（活动管道）与 OpenCode 会话 | 查找叫“代码审计”或“架构评审”的目标会话 ID |
| `read_session` | 直接通过管道向目标会话调阅最近 $N$ 条历史对话与最新输出 | 查看审计 Agent 刚才审到了哪一步、说了什么 |
| `send_session` | 单向排队推送指令（Ctrl+Q 语义，即发即走，耗时 2ms） | 通知审计会话：“我开始重构 auth 模块了，做好准备” |
| **`ask_session`**<br>*(核心杀招)* | **向目标提问 ➔ 阻塞等待对方思考执行完毕 ➔ 直接拿回最终结论** | 代码会话写完后直接调用，让审计会话审核，审核结论秒级返回，全程自动闭环！ |
| **`spawn_session`**<br>*(持久伙伴)* | **一键原生拉起一个新的独立持久化 PI 会话** | 脱离后台作业系统（无作业面板噪音、无超时强杀风险），自动开启命名管道随时接收指令 |

### 3. 配置方式 (MCP)

在 `~/.pi/agent/mcp.json` 或 OpenCode 的 `opencode.jsonc` 中添加本地 MCP 服务即可：

```json
{
  "mcpServers": {
    "pi-relay": {
      "command": "node",
      "args": [
        "D:\\path\\to\\pi-delegate\\session-mcp.ts"
      ],
      "timeout": 660,
      "description": "Session-to-session messaging: list/read/send/ask/spawn live pi and OpenCode sessions."
    }
  }
}
```

---

## 核心能力二：外包给 OpenCode CLI (两个工具)

同一个能力，两种形状。**同一时刻只会看到一个**，不需要选。

| 工具 | 什么时候在 | 行为 |
| --- | --- | --- |
| `opencode` | 异步模式**关闭** | **同步**。阻塞到干完，同一回合拿结果 |
| `delegate_async` | 异步模式**开启** | **异步**。丢出去立刻返回作业号，结果稍后作为新消息回来 |

异步模式开着的时候，阻塞的工具会被从模型的工具表里撞下——否则模型会在两个几乎一样的工具之间做选择，而选错那个会把整个对话卡住。开关是 `/async on` / `/async off`（由 pi-async-jobs 提供）。

判断依据是 **job 工具在不在**（`job_status` 等），不是 `delegate_async` 在不在。后者可能因为宿主版本不匹配而不激活，而异步模式其实是开的。

只装本包（没有宿主）→ 永远是同步那一把，异步半个不会冒出来。

## 生态

| 包 | 是什么 |
| --- | --- |
| [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs) | **宿主**：后台作业调度核心。本包向它借能力 |
| **`pi-delegate`**（本仓） | **消费者**：第一个接入该服务的扩展 |

两个包**独立仓库、独立版本、独立发布节奏**，运行时靠 `pi.events` 握手，没有任何编译期依赖。

- 只装本包 → 同步外包，可用
- 再装宿主 → `delegate_async` 自动激活，异步外包也可用

## 装

```bash
# 只同步外包 + 会话中继
pi install git:github.com/dong615119371/pi-delegate@v0.1.5

# 同步 + 异步外包 + 会话中继（推荐完整体验）
pi install git:github.com/dong615119371/pi-async-jobs@v0.2.2
pi install git:github.com/dong615119371/pi-delegate@v0.1.5
```

> 宿主必须是 **v0.2.0 或更高**——`host.ts`（宿主服务）是 0.2.0 才有的。装 0.1.x 的话 `delegate_async` 不会激活。

## 什么时候用哪个

| 情况 | 用 |
| --- | --- |
| 下一步**必须**用它的输出（改 → 测 → 读 → 改） | `opencode` |
| 要串行链（`{previous}` 传递上一步结果） | `opencode` |
| 有别的事可做，结果晚点要 | `delegate_async` |
| 批量苦力活，互不相干 | `delegate_async` |

判据一句话：**除了等它，你还能不能干别的。**

## 异步那半怎么接上的

不是 import。Pi 给每个扩展各自的 jiti 实例，`moduleCache: false`——两个扩展 import 同一个文件会得到两份模块实例，一份注册表，而宿主读的是另一份。失效是静默的：作业照样送达，只是渲染退化成兜底格式。

所以走 `pi.events`：Pi 每个 runtime 建一个总线，发给所有扩展。同一实例，不序列化，函数引用能原样传过去。`consumer.ts` 是接宿主的模板。

宿主不出现时 `activate()` 返回 false，`delegate_async` 就停在注册未激活的状态。版本不兼容时它同样拒绝激活，并在控制台留下原因——不会等到某次调用才在工具内部抛错。

## 硬性约束

**所有路径必须写绝对路径**——OpenCode 忽略工作目录，永远在用户家目录跑。相对路径会静默指错地方。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 同步 `opencode` 工具；决定何时激活异步 |
| `delegate.ts` | 异步 `delegate_async` 工具 |
| `channel.ts` | 异步渲染器：JSONL 事件流 → 人读文本 |
| `consumer.ts` | 接 async-jobs 宿主的模板 |
| `cli.ts` | opencode-cli 封装 |
| `models.ts` | 模型列表缓存 |
| `skills/delegate-work/` | 用法手册：该不该外包、怎么写 task、怎么验证结果 |

## License

MIT。见 `LICENSE`。
