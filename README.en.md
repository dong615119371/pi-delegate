# pi-delegate

> English · [中文](README.md)

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="models" src="https://img.shields.io/badge/models-free--tier%20only-brightgreen">
</p>

Outsource work to the [OpenCode](https://opencode.ai) CLI. One package, two tools, depending on what else is installed.

| Tool | Needs async-jobs? | Behaviour |
| --- | --- | --- |
| `opencode` | No | **Synchronous.** Blocks until done, result in the same turn |
| `delegate_async` | **Yes** | **Asynchronous.** Returns a job id at once, result arrives later as a message |

Installed alone it is a working synchronous delegation tool; the asynchronous half never appears.

## Why this exists

OpenCode has tightened external calls to its Zen free models, which left a lot of us with no free model to lean on. So here is **pi-delegate**:

A **fully compliant** alternative. It does not expose the OpenCode free models directly. It drives another agent — Pi, in this case — through the **official CLI** to hand out and schedule the work.

Pair it with [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs) and the throughput gains get frankly ridiculous.

> **Where the compliance comes from**: Zen free models no longer issue API keys, and they cannot be pulled out of the official OpenCode client by a reverse proxy or spoofed headers. If you want them, you use them inside OpenCode's own client and CLI.
>
> So this does none of that. Pi runs OpenCode's own command-line program, using its normal session and authentication. What the official CLI can do, this can do. What the official CLI cannot do, this does not either.

## The ecosystem

| Package | What it is |
| --- | --- |
| [`pi-async-jobs`](https://github.com/dong615119371/pi-async-jobs) | The **host**: the background-job scheduler. This package borrows from it |
| **`pi-delegate`** (this repo) | The **consumer**: the first extension to use that service |

The two packages have **separate repositories, separate versions, separate release cadence**, meeting over `pi.events` at runtime with no compile-time dependency at all.

- This package only → synchronous delegation, works
- Add the host → `delegate_async` activates itself, asynchronous delegation works too

## Install

```bash
# synchronous only
pi install git:github.com/dong615119371/pi-delegate@v0.1.0

# synchronous + asynchronous
pi install git:github.com/dong615119371/pi-async-jobs@v0.2.0
pi install git:github.com/dong615119371/pi-delegate@v0.1.0
```

> The host must be **v0.2.0 or later** — `host.ts` (the host service) first appears in 0.2.0. On 0.1.x, `delegate_async` will not activate.

## Which one to use

| Situation | Use |
| --- | --- |
| The next step **needs** its output (change → test → read → change) | `opencode` |
| A serial chain (`{previous}` carries the prior result) | `opencode` |
| You have other work meanwhile, the result can wait | `delegate_async` |
| Bulk grunt work, independent pieces | `delegate_async` |

The test is one question: **apart from waiting on this, can you do anything else?**

## How the async half connects

Not by importing. Pi gives each extension its own jiti instance with `moduleCache: false`, so two extensions importing the same file get two module instances and two registries — and the host reads the other one. The failure is silent: the job still delivers, just rendered by the fallback.

So it goes over `pi.events`: Pi creates one bus per runtime and hands it to every extension. Same instance, no serialisation, so a function reference survives the trip. `consumer.ts` is the template.

When no host is present `activate()` returns false and `delegate_async` stays registered but inactive. On a version mismatch it also refuses to activate, leaving the reason on the console — rather than failing later from inside a tool call.

## Hard constraints

**Every path must be absolute** — OpenCode ignores the working directory and always runs in the user's home. A relative path silently points at the wrong place.

**Do not go through a proxy.** OpenCode rate-limits free models by IP:

```
OpenCode's free models aren't available from your current network
because we've detected abusive traffic from this IP address.
This isn't related to your account.
```

Note **this IP address**, not your usage. Proxy nodes are shared, so everyone else's traffic on the same egress IP counts against it. Switching to a direct connection restores it immediately.

Symptom: the job ends `state: killed`, `exitCode: 1`, with `provider.auth` in the output.

**Free models only.** The list is read from the CLI at runtime; a paid id is rejected before anything spawns.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | The synchronous `opencode` tool; decides when to activate the async half |
| `delegate.ts` | The asynchronous `delegate_async` tool |
| `channel.ts` | Renderer for the async channel: JSONL event stream → readable text |
| `consumer.ts` | Template for connecting to the async-jobs host |
| `cli.ts` | opencode-cli wrapper |
| `models.ts` | Cached free-model list |
| `skills/delegate-work/` | Usage manual: when to outsource, model choice, multi-round review |

## License

MIT. See `LICENSE`.
