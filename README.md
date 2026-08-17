# pytorch-ck-rocm-gfx120x-build

[English](README.en-US.md)

使用 GitHub Actions 为 **Windows / gfx120x（RDNA4）/ Python 3.12** 从源码编译带 **ROCm CK Tile SDPA** 的 **PyTorch** wheel。

工具链版本以 **`VERSION.lock.json`** 为唯一来源，经 workflow 内 `npx tsx scripts/cli.ts 01.config -w $env:GITHUB_WORKSPACE --export-github-env` 注入 CI。编排脚本为 TypeScript（**Node.js 26** + `tsx`）。

## 目标环境

| 项 | 值 |
|----|-----|
| GPU 架构 | lock **`compile.gpu_archs`**（当前 `gfx1200;gfx1201`） |
| 系统 | Windows |
| Python | 3.12 |
| PyTorch 源码 | `VERSION.lock.json` **`pytorch.build_commit`**（当前 `v2.13.0`） |
| ROCm | `7.14.0`（`rocm[devel]` pip） |
| Node.js | >= 26（CI bootstrap；本地可用 `npm run pt -- <cmd>`） |
| Runner | `windows-2022`（GitHub 托管） |

### `VERSION.lock.json` 分组

| 分组 | 字段 | 作用 |
|------|------|------|
| `toolchain` | `python`、`rocm_index`、`rocm` | pip 工具链 pin（**不安装预编译 torch**） |
| `pytorch` | `repo`、`build_commit`、`build_commit_date` | 每次构建精确 clone 的 PyTorch 源码（`build_commit` 可为 40 位 SHA 或 tag，如 `v2.13.0`）；**升级 PyTorch 时改 `build_commit` 与 `build_commit_date`** |
| `compile` | `gpu_archs`、`ck_opt_dim` | `PYTORCH_ROCM_ARCH`（**唯一架构源**）、CK FMHA `opt_dim` 档位 |
| `wheel` | `wheel_local_version` | wheel 的 `+local` 标签（env `WHEEL_LOCAL_VERSION`） |
| `wheel` | `wheel_artifact_name` | GitHub Actions artifact 名称 |
| `release` | `release_tag_prefix` | Release tag 前缀（`{prefix}-serial-build{run_number}`） |
| `release` | `release_title_prefix` | Release 标题前缀（env `RELEASE_TITLE_PREFIX`；GitHub Release name = `{prefix} YYYY.MM.DD HH:mm:ss`，Asia/Shanghai） |

`EXPECTED_WHEEL_PATTERN`、`CK_TARGETS` 由 `version-lock.ts` / `gpu-archs.ts` 从 lock 推导，不在 lock 中存储（如 `gfx1200;gfx1201` → `CK_TARGETS=--targets gfx12`）。

规则：CI 始终 clone **`pytorch.build_commit`**（SHA 或 tag；`fetch origin <ref>` + `checkout FETCH_HEAD`），再经 `04.patch` 启用 Windows CK SDPA；patch 内 runtime arch 列表与 `compile.gpu_archs` 同源。

### 适用显卡（gfx120x / RDNA4）

| HIP 代号 | 芯片 | 代表型号 |
|----------|------|----------|
| **gfx1201** | Navi 48 | RX 9070 XT / RX 9070 / RX 9070 GRE；Radeon AI PRO R9700 系列 |
| **gfx1200** | Navi 44 | RX 9060 XT / RX 9060 / RX 9060 XT LP；RX 9050 系列 |

## 编译配置

- **全量 PyTorch 源码编译**（cache-miss：`setup.py build`；cache-hit：`ninja -C build install` → `bdist_wheel`）
- **USE_ROCM_CK_SDPA=ON**（Windows + gfx120x 补丁）
- **`PYTORCH_ROCM_ARCH`** = lock `compile.gpu_archs`（Windows 分号分隔）
- **`CK_TARGETS`** = 由 `compile.gpu_archs` 推导（当前 `gfx1200;gfx1201` → `--targets gfx12`）
- CK FMHA **`ck_opt_dim`** = lock `compile.ck_opt_dim`（当前 `32,64,128,256`）
- **完整编译 CK Tile FMHA**（forward + backward）；**fav_v3**（MI3xx AITER ASM bwd）仅 lock `gpu_archs` 含 **gfx942/gfx950** 时编入（当前 `gfx1200;gfx1201` 跳过）
- wheel local tag：`ck-rocm7.14.0-gfx120x`（见 `wheel.wheel_local_version`）

### 与 inference-only 的差异（full bwd）

当前 lock 默认 **完整 fwd + bwd**（已移除 `compile.ck_disable_bwd`）。相较此前 inference-only wheel（如 serial-build100，约 **302 MiB** / `316798971` bytes，仅 CK fwd）：

| 项 | inference-only（旧） | full bwd（当前） |
|----|---------------------|------------------|
| CK codegen | 仅 fwd / fwd_splitkv / fwd_appendkv | 额外 bwd list + emit + blob |
| wheel 体积 | 参考 ~302 MiB（build100 / build103，inference-only） | full-bwd 成功后以 Release manifest `size_bytes` 为准（尚无 full-bwd Release） |
| CI 全量编译 | 参考 build100 量级 | 预期显著增加（额外 bwd ninja targets + codegen 步骤；cold compile 可能触发 5h 看门狗 retry） |
| ComfyUI 扩散推理 | 仅需 fwd，旧 wheel 可用 | 默认 full wheel 可直接用；体积更大但支持 training / backward 场景 |

> **Release 状态：** 当前源码默认 full bwd，但最新 Release（如 serial-build103）仍由 full bwd 合入前的 CI 产出（manifest 可能含旧字段 `ck_disable_bwd: true`，体积与 build100 相近）。下一次成功 CI 才是文档所述的 full-bwd wheel。

> fav_v3（MI3xx AITER ASM）仍仅在 lock 含 gfx942/gfx950 时编入；当前 gfx120x lock 跳过 fav_v3。

## 触发方式

| Workflow | 用途 | 触发 |
|----------|------|------|
| **Build PyTorch CK SDPA serial (Windows gfx120x)** | 单 job 全量编译 + worktree cache + 打 wheel | **仅手动** |

> 推送到 `main` **不会**自动触发编译。

**手动输入：**

| 输入 | 默认 | 说明 |
|------|------|------|
| `ninja_workers` | `4` | Ninja 并行 worker 数（OOM 时可改为 `2`） |
| `use_cache` | `true` | 设为 `false` 时不 restore（仍 lookup 探测 `exists`；`used=false`；仅 compile 成功时 save） |
| `publish_release` | `true` | 设为 `false` 时跳过 GitHub Release 上传 |
| `retry_count` | `0` | 看门狗 auto-retry 内部递增；手动触发时保持默认，**勿改** |

### 看门狗与自动 retry

GitHub-hosted runner 的 job 硬上限为 **6 小时**。compile 自 A00 bootstrap 第一步起算 **5 小时**看门狗：到期后 3× SIGINT 优雅中断 → save worktree + ccache → 自动 dispatch retry（`retry_count` 内部递增，默认 `0`，**≥8 放弃**；手动触发时无需填写）。

| 条件 | 行为 |
|------|------|
| `use_cache=true`（默认） | 中断后 save cache 并 auto-retry |
| `use_cache=false` | compile 失败时不 save；**不** auto-retry |
| 3× SIGINT 后需 `taskkill` | 不 save、不 retry（`ABORT_FORCE_KILLED`） |

wheel / verify / publish 在 compile 未成功时不运行。`wheel.manifest.json` 的 `dispatch` 含 `retry_count` 等 workflow 快照（见下文 schema）。**serial** 在 compile job 内看门狗中止时 `09-retry`（普通 compile 失败不 retry）。详见 [docs/watchdog-design.md](docs/watchdog-design.md)。

### 串行（`build-pytorch-ck-gfx120x-serial.yml`）

| Job | 作用 | 超时 |
|-----|------|------|
| `compile-and-wheel` | bootstrap（toolchain + worktree restore + verify + mtime pin）、`08.build` + `09-retry`/`10.wheel`、CPU smoke test | 6 h（GitHub 上限；compile 受 5h 看门狗约束） |

**Worktree cache**（整棵 `C:\pt\pytorch`：patch 后源码 + hipify + `build/`）：

- Key：`worktree-v3-lock[{lockHash8}]-lockWheel[{lockWheelHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`
- `lockHash8`：lock `toolchain` + `pytorch` + `compile` → SHA256 前 8 位
- `lockWheelHash8`：lock `wheel` → SHA256 前 8 位
- `patchHash8`：`scripts/commands/04.patch.ts`、`scripts/commands/05.hipify.ts`、`scripts/lib/gpu-archs.ts`、`build/add-make-kernel-pt.py` → SHA256 前 8 位
- `msvcVersion`：vswhere 最新 MSVC 工具集目录名（完整版本，如 `14.42.34433`）
- `rocmClangVersion`：`clang --version` 解析完整版本 token（如 `19.0.0git`）
- `ninja` / `cmake`：`ninja --version` / `cmake --version` 的 major.minor
- **仅精确匹配**（无 `restore-keys`）
- **hit + verify 通过**：跳过 prep / patch / hipify
- **compile**：cache-hit 且 `build.ninja` 有效时 **`ninja -C build install`**（跳过 CMake reconfigure）；否则经 `build-pytorch-steps.py --step build` 调用 **`setup.py build`**
- **save**：`use_cache=true` 时 compile 非 skipped 即 save；`use_cache=false` 时仅成功 save
- **miss / verify 失败**：prep → patch → hipify → compile → save

另有独立 **pip toolchain cache**（`PIP_TOOLCHAIN_CACHE_KEY`：`pt-pip-toolchain-v2-py[{python}]-rocm[{rocm}]-idx[{indexHash8}]`，`indexHash8` = lock `toolchain.rocm_index` → SHA256 前 8 位）与 **ccache**（`CCACHE_CACHE_KEY`：`ccache-v3-lock[{lockHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`，无 `lockWheel`）分层。

### 构建阶段

串行 workflow 在 bootstrap（`01.config`–`07.pin-mtimes`，见 A00）之后，按 CLI 序号执行 `08`–`12`；`10.wheel` 经 `build/build-pytorch-steps.py --step wheel` 打 wheel：

| CLI | setuptools step | 作用 |
|-----|-----------------|------|
| `08.build` | `build` | cache-hit：`ninja -C build install`；cache-miss：`setup.py build`（经 `build-pytorch-steps.py --step build`） |
| `09-retry` | — | 看门狗中断后 dispatch retry workflow（A04 save 完成后；`if: always()` 条件触发；成功路径不执行） |
| `10.wheel` | `wheel` | `setup.py bdist_wheel`，复制唯一 `.whl` 到 `--dist-dir` |
| `11.verify` | — | CPU wheel 冒烟（结构/CK 符号/SHA256/manifest + pip 安装 + `is_ck_sdpa_available()`） |
| `12.publish` | — | 准备 GitHub Release 元数据（`publish_release=true` 时，经 A99） |

成功路径：`npx tsx scripts/cli.ts 08.build` → `10.wheel` → `11.verify` → `12.publish`。看门狗中断时于 `08.build` 之后插入 `09-retry`。亦可 `npm run pt -- 08.build`（CLI 程序名 `pt-build`）。

env 统一经 `scripts/lib/init-build-env.ts`（含 `SOURCE_DATE_EPOCH`，取自 `pytorch.build_commit_date`）。

## 产物

Artifact：**`wheel_artifact_name`**（保留 7 天；含 `torch-*.whl`、`torch-*.whl.sha256`、`wheel.manifest.json`）

GitHub Release（构建成功后自动上传；`publish_release=true` 时；**prerelease**、不自动设为 latest；标题格式 `{prefix} YYYY.MM.DD HH:mm:ss`，Asia/Shanghai）：

| Workflow | Tag 示例 | Release 标题示例 |
|----------|----------|------------------|
| serial | `torch-ck-cp312-rocm7.14.0-gfx120x-serial-build123` | PyTorch CK SDPA gfx120x Windows 2026.08.10 19:00:00 |

- `torch-*.whl`
- `torch-*.whl.sha256`
- `wheel.manifest.json`

`wheel.manifest.json` 由 `11.verify` 写入（CI 经 `A99.pt-verify-publish` 上传）。主要字段：

| 字段 | 含义 |
|------|------|
| `dispatch` | `ninja_workers`、`use_cache`、`retry_count`（workflow 快照） |
| `build_caches[]` | worktree cache 元数据（`opt_dim` / `key` / `exists` / `used`） |
| `ck_opt_dim`、`gpu_archs`、`ck_targets` | lock 编译配置快照 |
| `size_bytes`、`sha256` | wheel 体积与校验 |

> 旧版 manifest 可能在顶层含 `ck_disable_bwd: true`，或 cache key 为 `worktree-v2-*`；以当前 `11.verify` 输出为准。`dist/` 内本地样例可能来自较早 CI run。

```powershell
gh release list
gh release download torch-ck-cp312-rocm7.14.0-gfx120x-serial-build123 -D .\dist
```

预期 wheel 文件名（由 `wheel.wheel_local_version` + `toolchain.python` 推导；PEP 440 将 local tag 中的 `-` 规范化为 `.`）：

```text
torch-*+ck.rocm7.14.0.gfx120x*-cp312-cp312-win_amd64.whl
```

## 验证

| 检查 | 脚本 |
|------|------|
| CI smoke test（CPU） | `npx tsx scripts/cli.ts 11.verify --dist-dir dist --build-caches dist\build-caches.json` |
| 部署前 GPU smoke test（gfx120x 真机） | `python test/gpu-smoke-test.py -w .` |

Smoke test（`11.verify`，CPU）：wheel 文件名/结构（含 CK fwd/bwd dim 符号）→ SHA256 / manifest → pip 安装 → 校验 `torch.backends.cuda.is_ck_sdpa_available()`。GPU 上跑 CK SDPA fwd/bwd 见 `test/gpu-smoke-test.py`（**先 pip install wheel**，部署前在 gfx120x 真机手动跑；不替代 `11.verify`；在 `TORCH_ROCM_FA_PREFER_CK=1` 下以 `sdpa_kernel(SDPBackend.FLASH_ATTENTION)` 限定 backend，确认 fwd/bwd 均走 CK 而非 math fallback）。

## 安装到 ComfyUI

```powershell
$PY = "<ComfyUI>\python_embeded\python.exe"
& $PY -m pip install --force-reinstall .\downloaded.whl
```

替换 `python_embeded` 中的 torch 后：

- 源码默认 **完整 CK Tile FMHA**（forward + backward）；不含 fav_v3（lock 无 MI3xx arch）。若 Release 早于 full-bwd 合入（见上文），已下载 wheel 可能仍为 inference-only，扩散推理同样可用
- 启动参数保持 **`--use-pytorch-cross-attention`**
- 环境变量 **`TORCH_ROCM_FA_PREFER_CK=1`**（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）

更多维护约定见 [AGENTS.md](AGENTS.md)。
