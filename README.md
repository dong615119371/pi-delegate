# pi-delegate

> 中文说明 · [English](README.en.md)

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="models" src="https://img.shields.io/badge/models-free--tier%20only-brightgreen">
</p>

把活外包给 [OpenCode](https://opencode.ai) CLI。

## 为什么做这个

由于 OpenCode 官方收紧了对 Zen 免费模型的外部调用，所以导致我们广大开发者陷入了没有免费模型可以白嫖的境地。于是我们带来了 **pi-delegate**：

这是一款**完全合规**的替代方案。它不直接将 OpenCode 免费模型接出，而是使用其他 Agent——这里使用 Pi Agent——通过**官方 CLI** 来实现任务的分配调度！

配合我们的异步工具调动插件 [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs)，可以实现非常夸张的效率提升！

> **合规在哪里**：Zen 免费模型已经不提供 API key，也不能被反向代理、伪造请求头带出 OpenCode 官方客户端。想用，就只能在 OpenCode 自己的客户端和 CLI 里用。
>
> 所以这里不做这些事。Pi 调用的就是 OpenCode 自己的命令行程序，走它正常的会话与认证。官方 CLI 能做的，这里就能做；官方 CLI 不能做的，这里也不做。

## 两个工具

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
# 只同步
pi install git:github.com/dong615119371/pi-delegate@v0.1.0

# 同步 + 异步
pi install git:github.com/dong615119371/pi-async-jobs@v0.2.0
pi install git:github.com/dong615119371/pi-delegate@v0.1.0
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

**不要走代理。** OpenCode 对免费模型按 IP 风控，报错原文：

```
OpenCode's free models aren't available from your current network
because we've detected abusive traffic from this IP address.
This isn't related to your account.
```

注意是 **this IP address**，不是你的用量。代理节点共享，同一个出口 IP 上别人的流量也算在它头上。切直连立马恢复。

表现：作业 `state: killed`、`exitCode: 1`、输出里有 `provider.auth`。

**只用免费模型。** 名单实时从 CLI 读，收费 id 在 spawn 之前就被拒。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 同步 `opencode` 工具；决定何时激活异步 |
| `delegate.ts` | 异步 `delegate_async` 工具 |
| `channel.ts` | 异步渲染器：JSONL 事件流 → 人读文本 |
| `consumer.ts` | 接 async-jobs 宿主的模板 |
| `cli.ts` | opencode-cli 封装 |
| `models.ts` | 免费模型列表缓存 |
| `skills/delegate-work/` | 用法手册：该不该外包、选模型、多轮审查 |

## License

MIT。见 `LICENSE`。
