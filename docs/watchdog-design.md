# 看门狗与优雅退出机制设计

## 背景

GitHub-hosted runner 的 job 执行硬上限为 **6 小时**（不可突破）。
当编译耗时接近或超过 6h 时，GitHub 强制终止 runner，`if: always()` 的 save 步骤
可能来不及执行，导致 worktree + ccache 未能存档。

## 目标

1. 自 bootstrap 起算 5h 主动优雅中断编译，保留 save 窗口
2. 存档已编译产物（ccache + worktree）
3. 自动触发 retry run 接续编译
4. retry 利用已保存的缓存增量编译，逐次推进

## 机制总览

**初始 run（retry_count=0）：**

1. A00 bootstrap **第一步**写入 `JOB_START_TIME`（UTC epoch ms）。
2. bootstrap 完成 fingerprint + cache restore 后，`08.build` 异步 `spawn` 编译，
   同时 `scripts/lib/watchdog.ts` 注册 **单次 deadline `setTimeout`**：
   `jobStartMs + 5h - Date.now()` 到期且子进程仍在运行 → 进入中止流程。
3. 中止流程：**先**写 `ABORT_TRIGGERED=true`、`COMPILE_COMPLETE=false` 到 `$GITHUB_ENV`，
   再 `child.kill("SIGINT")`；若子进程仍未退出，**每 1 分钟**重复发送，最多 **3 次**；
   3 次后 `taskkill /PID /T /F` 强杀子进程树，并写 `ABORT_FORCE_KILLED=true`。
   **SIGINT 内退出**：A04 照常 save；**需 taskkill**：跳过 save/delete cache，且不触发 retry。
   中止期间 Node 通过 `process.on('SIGINT')` + `swallowSigint` 拦截误传到自身的 SIGINT，以保持存活并完成 save。
4. 编译正常完成：写 `COMPILE_COMPLETE=true`，继续 wheel 打包。
5. A04 save（`use_cache=true` 时失败也 save）存档 worktree + ccache。
6. save 后 **`12.watchdog-retry`**（workflow 条件：`!cancelled() && ABORT_TRIGGERED && !COMPILE_COMPLETE && ABORT_FORCE_KILLED != 'true'`）：
   - `use_cache=false` → 报错退出
   - `retry_count >= 8` → 报错退出
   - 否则 `gh api workflow_dispatch` 触发 retry（**3 次重试，间隔 1min**），
     等待 **5 分钟** 由 concurrency `cancel-in-progress` 取消当前 run；
     5 分钟后仍未取消 → 报错退出。
7. wheel / verify / publish 步骤均 `if: success()`，看门狗中断后不执行。

**Retry run（retry_count=N）：**

1. 继承原 run 的 `ninja_workers`、`use_cache`、`publish_release`，仅 `retry_count` 递增。
2. restore worktree（若 `use_cache=true`）+ ccache，接续编译。
3. 重复上述看门狗 + retry 流程，直至 5h 内完成或 `retry_count >= 8`。

## 环境变量

| 变量 | 写入位置 | 含义 |
|------|----------|------|
| `JOB_START_TIME` | A00 第一步 | bootstrap 开始 UTC epoch ms |
| `ABORT_TRIGGERED` | `watchdog.ts`（`08.build` 调用） | `true` = 已触发优雅中止 |
| `ABORT_FORCE_KILLED` | `watchdog.ts` | `true` = 3× SIGINT 失败、已 taskkill；**不 save、不 retry** |
| `COMPILE_COMPLETE` | `08.build` | `true` = 编译成功；中止时写 `false` |
| `RETRY_COUNT` | workflow input → env | 当前 retry 计数，仅 save 后 `12.watchdog-retry` 判断 |
| `PUBLISH_RELEASE` | workflow input → env | retry dispatch 时继承 `publish_release` |

## 为什么用 SIGINT + 吞信号

| 手段 | 行为 |
|------|------|
| `child.kill("SIGINT")` | 向编译子进程发 SIGINT，ninja 通常 `Cleanup()` 后以非 0 退出 |
| `swallowSigint` | 中止期间父 Node 忽略误传的 SIGINT，避免 save/retry 步骤来不及执行 |
| `taskkill /PID /T /F` | 3 次 SIGINT 仍不退出时的兜底强杀 |

不再使用 PowerShell `GenerateConsoleCtrlEvent(CTRL_C_EVENT)` 内联脚本；实现集中在 `scripts/lib/watchdog.ts`。

## 实现细节

### A00: JOB_START_TIME

bootstrap composite 第一步（Setup Node 之前）写入 `$GITHUB_ENV`。

### exec.ts: spawnAsync

`spawnAsync` 返回 `{ child, completed }`，暴露 `child.pid` 供看门狗 `taskkill` 强杀。

### scripts/lib/watchdog.ts

- `createWatchdog(child, jobStartMs)`：单次 deadline `setTimeout`，到期调用 `onDeadline`
- 超时且子进程运行中 → 写 env → `abortChild()` 异步循环：最多 3× SIGINT（间隔 1min）→ 写 `ABORT_FORCE_KILLED` → `taskkill`
- `08.build` 在 `finally` 中 `await whenAbortSettled()`，确保 env 写入后再结束 step
- `stop()`：清除 deadline timer、移除 SIGINT listener、关闭 swallow
- `wasAborted()`：`aborted || forceKilled`

### 08.build.ts

- `spawn` 编译子进程后调用 `createWatchdog(buildHandle.child, jobStartMs)`
- 成功：`COMPILE_COMPLETE=true`；看门狗中止：throw 使 build step 失败以触发 save

### 12.watchdog-retry.ts

- workflow `if:` 条件触发后调用 `npx tsx scripts/cli.ts 12.watchdog-retry`
- 脚本入口校验 `ABORT_FORCE_KILLED=true` → 报错退出（与 workflow `if:` 双重门禁）
- `retry_count` 仅在 save 后判断（`< 8` 才 dispatch）
- `gh api workflow_dispatch`：3 次重试，间隔 60s，全失败则 throw
- 等 300s，未 cancel 则 throw（期望 concurrency 取消当前 run）

## 状态与通知

| 场景 | run A conclusion | run B |
|------|-----------------|-------|
| 5h 内完成 | success | 不触发 |
| 看门狗 + retry 成功 cancel | cancelled | 接续编译 |
| 看门狗 + taskkill（`ABORT_FORCE_KILLED`） | failure | 不 save、不 retry |
| retry_count ≥ 8 / use_cache=false / dispatch 失败 / 5min 未 cancel | failure | 视情况 |

## 已知限制（刻意不处理）

- bootstrap 单独超过 5h（不计入看门狗，但 JOB_START_TIME 从 bootstrap 起算已覆盖常规场景）
- 6h 硬上限内 save 未完成
- `use_cache=false` 时 compile 失败不 save

## 风险与降级

| 风险 | 缓解 |
|------|------|
| SIGINT 单次失败 | 每 1min 重复，最多 3 次 |
| 3 次后仍不退出 | `taskkill` + `ABORT_FORCE_KILLED=true`；A04 跳过 save/delete，workflow 跳过 retry |
| dispatch 失败 | 3 次重试 + 明确报错 |
| 并发取消延迟 | 等 300s 后报错，wheel 步骤 `success()` guard |
