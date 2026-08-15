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
   同时每 **30s** 轮询：`Date.now() - JOB_START_TIME >= 5h` 且子进程仍在运行 → 进入中止流程。
3. 中止流程：**先**写 `ABORT_TRIGGERED=true`、`COMPILE_COMPLETE=false` 到 `$GITHUB_ENV`，
   再经 PowerShell `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` 广播 Ctrl+C；
   若子进程仍未退出，**每 1 分钟**重复发送，最多 **30 次**；30 次后 `taskkill /PID /T /F` 强杀子进程树。
   Node 通过 `process.on('SIGINT')` 拦截自身信号以保持存活。
4. 编译正常完成：写 `COMPILE_COMPLETE=true`，继续 wheel 打包。
5. A04 save（`use_cache=true` 时失败也 save）存档 worktree + ccache。
6. save 后 **`12.watchdog-retry`**（workflow 条件：`!cancelled() && ABORT_TRIGGERED && !COMPILE_COMPLETE`）：
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
| `ABORT_TRIGGERED` | `08.build` 看门狗 | `true` = 已触发优雅中止 |
| `COMPILE_COMPLETE` | `08.build` | `true` = 编译成功；中止时写 `false` |
| `RETRY_COUNT` | workflow input → env | 当前 retry 计数，仅 save 后 `12.watchdog-retry` 判断 |
| `PUBLISH_RELEASE` | workflow input → env | retry dispatch 时继承 `publish_release` |

## 为什么用 CTRL_C_EVENT

| API | 行为 |
|-----|------|
| `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` | 广播 Ctrl+C，ninja `Cleanup()` + exit 130 |
| `taskkill /PID /T /F` | 30 次优雅中止失败后的兜底强杀 |

ninja 收到 Ctrl+C 后删除 mtime 变化的半截输出文件，再以 exit 130 退出。

## 实现细节

### A00: JOB_START_TIME

bootstrap composite 第一步（Setup Node 之前）写入 `$GITHUB_ENV`。

### exec.ts: spawnAsync

`spawnAsync` 返回 `{ child, completed }`，暴露 `child.pid` 供看门狗 `taskkill` 强杀。

### 08.build.ts: 看门狗

- 每 30s 检查 `Date.now() - JOB_START_TIME >= 5h
- 超时且子进程运行中 → 写 env → 立即首次 CTRL_C → 每 1min 最多 30 次 → 强杀
- 成功：`COMPILE_COMPLETE=true`；看门狗中止：throw 使 build step 失败以触发 save

### 12.watchdog-retry.ts

- workflow `if:` 条件触发后调用 `npx tsx scripts/cli.ts 12.watchdog-retry`
- `retry_count` 仅在 save 后判断（`< 8` 才 dispatch）
- `gh api workflow_dispatch`：3 次重试，间隔 60s，全失败则 throw
- 等 300s，未 cancel 则 throw（期望 concurrency 取消当前 run）

## 状态与通知

| 场景 | run A conclusion | run B |
|------|-----------------|-------|
| 5h 内完成 | success | 不触发 |
| 看门狗 + retry 成功 cancel | cancelled | 接续编译 |
| retry_count ≥ 8 / use_cache=false / dispatch 失败 / 5min 未 cancel | failure | 视情况 |

## 已知限制（刻意不处理）

- bootstrap 单独超过 5h（不计入看门狗，但 JOB_START_TIME 从 bootstrap 起算已覆盖常规场景）
- 6h 硬上限内 save 未完成
- `use_cache=false` 时 compile 失败不 save

## 风险与降级

| 风险 | 缓解 |
|------|------|
| CTRL_C 单次失败 | 每 1min 重复，最多 30 次 |
| 30 次后仍不退出 | `taskkill /PID /T /F` 强杀 |
| dispatch 失败 | 3 次重试 + 明确报错 |
| 并发取消延迟 | 等 300s 后报错，wheel 步骤 `success()` _guard |
