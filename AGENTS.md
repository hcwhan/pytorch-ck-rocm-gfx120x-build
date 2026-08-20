# pytorch-ck-rocm-gfx120x-build

**Windows / gfx120x（RDNA4）/ Python 3.12** 带 **CK Tile SDPA** 的 PyTorch 源码 wheel。版本 pin 见 **`VERSION.lock.json`**。仅 **CI**（`windows-2022` 干净 runner），无本地编译入口。编排脚本为 **TypeScript**（Node 26 + `tsx`；亦可 `npm run pt -- <cmd>`）。

## CI 路径

| Workflow | 链路 |
|----------|------|
| **serial** | worktree restore → bootstrap verify → `07.pin-mtimes`（含 ROCm 外部头文件） → cache-hit: `ninja -C` / cache-miss: `setup.py build` → save worktree + ccache → `bdist_wheel` → write `dist/compile-success-meta.json` → CPU smoke test → optional Release |

手动 `workflow_dispatch`（输入：`ninja_workers`→`MAX_JOBS`、`use_cache`、`publish_release`、`retry_count`→`RETRY_COUNT` 默认 `0` 由看门狗递增）；setuptools 同进程入口：`build/build-pytorch-steps.py`。GHA cache 经 **`hcwhan/actions/kit/cache@main`**（`family-key` + `cache-key` 槽位；实际 key = `cache-key` + UTC 后缀；restore（含 `only-lookup`）取槽位最新 versioned key；save 后 API verify + `cleanup-stale`）。Worktree cache-key：`worktree-v3-lock[{lockHash8}]-lockWheel[{lockWheelHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`（`lockHash8` = lock `toolchain`+`pytorch`+`compile`；`lockWheelHash8` = lock `wheel`；`patchHash8` = `scripts/commands/04.patch.ts`+`scripts/commands/05.hipify.ts`+`scripts/lib/gpu-archs.ts`+`build/add-make-kernel-pt.py`；`msvc`/`rocmClang` = 完整工具链版本号；`ninja`/`cmake` = major.minor）。Ccache cache-key：`ccache-v3-lock[…]-patch[…]-msvc[…]-rocmClang[…]-ninja[…]-cmake[…]`（无 `lockWheel`）。Pip cache-key：`pt-pip-toolchain-v2-py[…]-rocm[…]-idx[…]`（`01.config`）。

## 命名约定

| 概念 | 统一名称 | 备注 |
|------|----------|------|
| PT 源码根 | `PT_SRC` / `--pt-src` / composite `pt-src` | 全层一致 |
| lock GPU 架构 | `GPU_ARCHS` | lock `compile.gpu_archs`（**唯一架构源**）；`PYTORCH_ROCM_ARCH` / patch runtime arch 列表同源 |
| lock CK codegen 目标 | `CK_TARGETS` | 由 `compile.gpu_archs` 经 `gpu-archs.ts` 推导（如 `gfx1200;gfx1201` → `--targets gfx12`）；`04.patch` 只读 env |
| lock CK OPT_DIM | `CK_OPT_DIM` | lock `compile.ck_opt_dim` 逗号列表；`04.patch` 只读 env |
| Worktree cache key | `WORKTREE_CACHE_KEY` | `02.toolchain-fingerprint` → bootstrap restore / compile save / manifest `build_meta[].worktree-cache-key` |
| Worktree cache exists | `worktree-cache-exists` | A00 output / manifest `build_meta[].worktree-cache-exists` |
| Worktree cache used | `worktree-cache-used` | A00 output → workflow → A01 input → `08.prepare --worktree-cache-used`；跳过 prep/patch/hipify；manifest `build_meta[].worktree-cache-used` |
| Ccache cache key | `CCACHE_CACHE_KEY` | `02.toolchain-fingerprint` → A00 restore / A01 save / manifest `build_meta[].ccache-cache-key` |
| Ccache cache exists | `ccache-cache-exists` | A00 output / manifest `build_meta[].ccache-cache-exists` |
| Ccache cache used | `ccache-cache-used` | A00 output / manifest `build_meta[].ccache-cache-used` |
| Compile cache metadata | `--build-meta` | workflow 写入 `dist/compile-success-meta.json` → 10.verify → manifest `build_meta`（worktree + ccache 字段） |
| wheel local tag | `WHEEL_LOCAL_VERSION` | lock `wheel.wheel_local_version` |
| PT 相关 env | `PYTORCH_*` | repo / commit / force-build 等 |

**缩写对照：** 仓库 `pytorch-ck-rocm-gfx120x-build`；worktree cache 前缀 `worktree-v3-…`；release tag / artifact 前缀见 lock `release_tag_prefix` / `wheel_artifact_name`（当前 `torch-ck-cp312-rocm7.14.0-gfx120x`）。

**lock → GITHUB_ENV 映射：** `toolchain.python`→`PYTHON_VERSION`，`toolchain.rocm`→`ROCM_VERSION`，`toolchain.rocm_index`→`ROCM_INDEX`，`compile.gpu_archs`→`GPU_ARCHS`，`compile.gpu_archs`→`CK_TARGETS`（推导），`compile.ck_opt_dim`→`CK_OPT_DIM`，`pytorch.repo`→`PYTORCH_REPO`，`pytorch.build_commit`→`PYTORCH_BUILD_COMMIT`，`pytorch.build_commit_date`→`PYTORCH_BUILD_COMMIT_DATE`（另导出 `SOURCE_DATE_EPOCH`），`02.toolchain-fingerprint --export-github-env`→`WORKTREE_CACHE_KEY`+`WORKTREE_CACHE_PREFIX`+`CCACHE_CACHE_KEY`+`CCACHE_CACHE_PREFIX`，`wheel.wheel_local_version`→`WHEEL_LOCAL_VERSION`，`wheel.wheel_artifact_name`→`WHEEL_ARTIFACT_NAME`，`release.release_tag_prefix`→`RELEASE_TAG_PREFIX`，`release.release_title_prefix`→`RELEASE_TITLE_PREFIX`；`EXPECTED_WHEEL_PATTERN` / `PIP_TOOLCHAIN_CACHE_PREFIX` / `PIP_TOOLCHAIN_CACHE_KEY` 由 `version-lock.ts` 推导；`A00` / `00.install-windows-deps` 设 `CCACHE_DIR`+`CCACHE_COMPRESS`+`libuv_ROOT`/`LIBUV_ROOT`+`PIP_CACHE_DIR`；`08.prepare --export-github-env`→`init-build-env.ts` 的 `BUILD_ENV_VAR_NAMES`（编译/`CMAKE_*`/ROCm 路径/`PATH`/`INCLUDE`/`LIB`/ccache launcher + `CCACHE_DIR`/`CCACHE_COMPRESS`/`CCACHE_*` 等）+ 已存在的 `PASSTHROUGH_MSVC_ENV_VAR_NAMES`（`VCToolsInstallDir`、`VCToolsRedistDir` 等，供 `watchdog/run` spawn 与 wheel 阶段 `libomp` 查找）；`worktree-cache-used` 经 A01 input 传 `08.prepare --worktree-cache-used`（非 GITHUB_ENV）。

## 复用入口

**脚本**

| 入口 | 职责 |
|------|------|
| `scripts/cli.ts` | 统一 CLI（`npm run pt -- <cmd>` 或 `npx tsx scripts/cli.ts <cmd>`；`npm run typecheck` 本地 TS 检查） |
| `scripts/lib/version-lock.ts` | **唯一直接读 lock 的 TS 模块**（Zod 校验） |
| `scripts/lib/gpu-archs.ts` | 解析 lock `GPU_ARCHS`；由 `gpu_archs` 推导 `CK_TARGETS`（HIP → CK 族映射）供 patch |
| `scripts/lib/require-env.ts` | CI env 读取；缺 env 直接 throw |
| `scripts/lib/rocm-sdk-paths.ts` | ROCm SDK 路径（唯一路径发现） |
| `scripts/lib/worktree-bootstrap.ts` | bootstrap 完成探针（hipify 关键路径，与 `05.hipify` 对齐） |
| `scripts/lib/init-build-env.ts` | ROCm 编译 env（含 `USE_KINETO=0`；Windows 无 rocprofiler）；`exportGithubEnv` 供 `08.prepare` 写入 GITHUB_ENV |
| `00.install-windows-deps` | 安装 ccache + libuv；导出 `CCACHE_DIR` / `CCACHE_COMPRESS` / `libuv_ROOT`（A00 bootstrap） |
| `01.config` | 读 lock；`--export-github-env` 写 CI env |
| `02.toolchain-fingerprint` | MSVC/clang + ninja/cmake 指纹；`-w --export-github-env` 输出 `WORKTREE_CACHE_KEY` + `CCACHE_CACHE_KEY` |
| `03.prep` | blob-less 浅 clone PyTorch + 浅 submodule + author date 校验 + strip `.git`（worktree cache miss 时由 bootstrap 调用） |
| `04.patch` | Windows CK SDPA + gfx120x 程序化补丁 + MSVC `/Brepro`（仅 shared/exe 链接器，避开 llvm-lib 静态库）；完整编译 CK Tile FMHA fwd/bwd codegen；lock `GPU_ARCHS` 含 gfx942/gfx950 时才编 fav_v3（AITER MI3xx ASM）；`CK_FMHA_GENERATE` 用 `${Python3_EXECUTABLE}`；部署 `add_make_kernel_pt.py` + `.cpp→.hip` CMake `file(RENAME)` + CK emit 独立 `RESULT_VARIABLE` |
| `05.hipify` | `tools/amd_build/build_amd.py`（生成 `c10/hip/`、`THH/` 等 ROCm 源码） |
| `06.verify-bootstrap` | worktree cache hit 后校验 prep+patch+hipify 产物（不含 `build/`）；失败则 job 终止 |
| `07.pin-mtimes` | bootstrap 末尾将 PT 工作树 + ROCm SDK 外部头文件 mtime 固定为 `SOURCE_DATE_EPOCH`（满足 ninja 3 条 dirty 检查；见下方"缓存复用"节） |
| `08.prepare` | 初始化编译 env（`--export-github-env` 写 GITHUB_ENV，含 ccache/MSVC 路径）并输出 `command`/`args`（JSON）；`--worktree-cache-used` → cache-hit 时 `ninja -C`；miss → `setup.py build`；由 A01 转发至 `hcwhan/actions/kit/watchdog/run@main` |
| `09.wheel` | `build-pytorch-steps --step wheel`（打 wheel 前 CK FMHA bwd 产物校验）→ 复制到 `dist/` |
| `10.verify` | CPU 冒烟（wheel CK fwd dim 符号 + `is_ck_sdpa_available()`）；manifest `fmha_bwd` + `dispatch` |
| `11.publish` | Release 元数据 |
| `build/build-pytorch-steps.py` | `--step build` / `verify-build` / `wheel`（build/wheel 后校验 bwd obj + 链接新鲜度） |
| `build/add-make-kernel-pt.py` | CK FMHA blob `make_kernel`→`make_kernel_pt`（`04.patch` 复制到 PT 源码 `ck/`） |
| `test/gpu-smoke-test.py` | 部署前 GPU 校验（gfx120x 真机；CK SDPA fwd/bwd；CI 不跑） |

规则：lock 只经 `01.config` 读一次；同 job 其余命令只经 `requireLockEnv` 消费 env；`GPU_ARCHS` / `CK_TARGETS` / `CK_OPT_DIM` **禁止**在 patch 内硬编码。ROCm 路径只经 `rocm-sdk-paths.ts`；编译/打 wheel 只经 `build-pytorch-steps.py`。**A00 bootstrap 不安装预编译 torch**（全量源码编译）。

**依赖方向（强制）**：workflow 直接调用 `scripts/cli.ts` 与官方 action；`scripts/commands/*` 只 import `scripts/lib/*`。Python 编译逻辑只经 `build/build-pytorch-steps.py`。

**Composite**

**Composite 编号**：`Axx` = workflow 直接 `uses` 的单文件 composite。

| Action | 用途 |
|--------|------|
| `A00.bootstrap-job` | Node 26/npm + `01.config` + `00.install-windows-deps` + `02.toolchain-fingerprint` + ccache/worktree restore（`use_cache=false` 时二者均 `only-lookup`）+ `06.verify-bootstrap` + 条件 prep/patch/hipify + `07.pin-mtimes`（需 job 级 checkout；依赖 env `PT_SRC`/`USE_CACHE`） |
| `A01.compile-with-cache` | `worktree-cache-used` input + `08.prepare` + `watchdog/run@main` + save worktree/ccache；转发 `should-retry` 等 outputs |
| `A99.verify-and-publish` | `10.verify` + artifact + 可选 Release |

## 设计决策

分析 / 重构时**勿当缺陷**；与本节冲突时以本节为准。

- **全量 PyTorch 源码编译**（无 parallel workflow）
- **gfx120x 双架构 wheel**：lock `compile.gpu_archs=gfx1200;gfx1201` → `PYTORCH_ROCM_ARCH` 与 `04.patch` runtime arch 列表同源（经 `scripts/lib/gpu-archs.ts`）
- **patch 程序化**（`04.patch.ts`）；`CK_OPT_DIM` / `GPU_ARCHS` / `CK_TARGETS` 只从 env 取（`CK_TARGETS` 由 lock `gpu_archs` 推导）
- **完整编译 CK Tile FMHA fwd/bwd**；**fav_v3**（MI3xx AITER ASM）仅 lock `gpu_archs` 含 **gfx942/gfx950** 时编入（当前 `gfx1200;gfx1201` 跳过）
- **`/Brepro` + `SOURCE_DATE_EPOCH`**：固定 PE TimeDateStamp 与 wheel zip 时间戳（`/Brepro` 仅追加到 `CMAKE_SHARED_LINKER_FLAGS` / `CMAKE_EXE_LINKER_FLAGS`，不作用于 `llvm-lib` 静态库链接）
- **`use_cache` 默认 true**（false 时不 restore ccache/worktree，均 `only-lookup` 探测；**save 仅 compile 成功时**）
- **worktree cache save**：`use_cache=true` 时 compile 非 skipped 即 save（含失败/取消）；`hcwhan/actions/kit/cache` 默认 `cleanup-stale` 在 save/restore 成功后清理同族旧 key
- **ccache save**：同上规则；`CCACHE_MAXSIZE=3G`
- **worktree hit bootstrap**：restore 命中 → `06.verify-bootstrap` fail-fast；通过则 skip prep/patch/hipify
- **compile**：cache-hit 时 `ninja -C build install`（跳过 CMake reconfigure，保 `.ninja_log`）；cache-miss 时 `setup.py build`
- **ccache**：`CMAKE_*_COMPILER_LAUNCHER=ccache`；GHA cache `ccache-v3-lock[…]-patch[…]-msvc[…]-rocmClang[…]-ninja[…]-cmake[…]`（无 `lockWheel`）
- **看门狗 5h 优雅中断**：workflow 第一步 `watchdog/job-start@main`；A01 `watchdog/run@main` spawn 编译 + deadline；graceful abort → `should-retry=true` → save → `watchdog/dispatch-retry@main`；`force-killed=true` 时不 save/retry；wheel 等下游 `if: success()`

## 缓存复用

worktree cache 恢复后，ninja 必须同时通过 **3 条 dirty 检查**才跳过已编译对象。任一失败 → mass recompile。

| 检查 | ninja 源码 | 条件 | 失败时的 explain 原因 | 本项目如何满足 |
|------|-----------|------|---------------------|---------------|
| 1 | `graph.cc:324` | `obj.mtime >= 最新 input mtime` | "output older than most recent input" | `07.pin-mtimes` 将 ROCm SDK 外部头文件钉到 `SOURCE_DATE_EPOCH`（2026-07-03），使缓存 `.obj`（~构建时刻）比所有 input 新 |
| 2 | `graph.cc:338` | `.ninja_log entry.mtime >= 最新 input mtime` | "recorded mtime older than most recent input" | `.ninja_log` 是文本文件，tar 原样保留内容；entry mtime = 编译时刻 > pinned headers |
| 3 | `graph.cc:737` | `obj.mtime <= .ninja_deps 记录的 mtime` | "stored deps info out of date" | `pin-mtimes` 跳过 `build/`（`SKIP_DIR_NAMES = {".git", "build"}`），不 touch `.obj`；tar `--posix` floor 截断 `.obj` mtime 到秒 ≤ 原始纳秒值 |

**关键：为什么必须用 `ninja -C` 而非 `cmake --build`**

`cmake --build` 会检查 CMake reconfigure（依赖 `build/` 内部状态文件 mtime）。`pin-mtimes` 跳过 `build/`，这些文件 mtime 被 tar 扰动，可能触发 reconfigure → 重新生成 `build.ninja` → command hash 全部变化 → mass recompile。`ninja -C` 完全绕过 CMake，直接按现有 `build.ninja` 编译。cache key 的 `patch[hash]` 段保证 patch 变了走 cache-miss 重新 configure。

**pin 的外部目录**（经 `getRocmSdkPaths()` 与可选 `libuv_ROOT`/`LIBUV_ROOT` 获取路径）：

| 目录 | pip 包来源 | 作用 |
|------|----------|------|
| `coreRoot/lib/llvm/lib/clang` | `_rocm_sdk_core` | `yvals_core.h`, `vadefs.h` 等 |
| `develRoot/lib/llvm/lib/clang` | `_rocm_sdk_devel` | `cuda_wrappers/new` 等 |
| `develRoot/include` | `_rocm_sdk_devel` | `hip_runtime.h` 等 |
| `coreRoot/lib` | `_rocm_sdk_core` | `amdhip64.lib` 等 import lib |
| `develRoot/lib` | `_rocm_sdk_devel` | ROCm devel 链接库 |
| `libuv_ROOT/include`、`libuv_ROOT/lib` | libuv（env 已设时） | libuv 头文件与库 |

**cache key 前缀统一定义**：`WORKTREE_CACHE_PREFIX`（`worktree-v3`）、`CCACHE_CACHE_PREFIX`（`ccache-v3`）、`PIP_TOOLCHAIN_CACHE_PREFIX`（`pt-pip-toolchain-v2`）分别在 `worktree-cache-key.ts` / `ccache-cache-key.ts` / `pip-cache-key.ts` 导出，经 `02.toolchain-fingerprint` 或 `01.config` 写入 `GITHUB_ENV`，作为 `hcwhan/actions/kit/cache` 的 `family-key`。

**同族清理**：save/restore 成功后 `cleanup-stale`（默认 true）删除 `family-key` 下除当前 `cache-key-full` 外的条目，避免旧 patch 缓存堆积；典型占用约 6.7GB（1 worktree ~2.45GB + 1 ccache ~2GB + 1 pip ~2.25GB），低于 GHA 10GB 上限。

## 编写规范

1. **单一事实来源** — lock 为准；配置/env 仅经 `01.config` 导出一次；hash 计算可经 `version-lock.ts` 再读 lock 文件，禁止命令内二次 `readVersionLock` 取配置。
2. **信任流水线** — 不为漏传参 / 缺 env 加 silent fallback；`appendGithubEnv` / `appendGithubOutput` 缺文件即 throw。
3. **最小路径** — 能力一个入口；异常快速失败，禁止命令内兜底读 lock、`??` 默认 env。
4. **AGENTS 增改须简洁** — 并入现有条目，禁复述 README/代码。

**不要添加：** 双源校验、manifest 读回自证、`PT_SKIP_*`、patch 内硬编码 lock 字段、命令内二次 `readVersionLock`、单行 composite 包装。

**应当保留：** patch 补丁前状态；`10.verify` CK fwd dim 符号扫描；`09.wheel` 前 CK FMHA bwd 产物校验；worktree cache cache-key 槽位（`worktree-v3-…`）；`04.patch` `/Brepro`。

## 维护

- 升级 PyTorch：改 `pytorch.build_commit` 与 `pytorch.build_commit_date`（须等于该 commit 的 git **author date**），并核对 `04.patch.ts` 补丁前状态
- 升级 ROCm：同步 `wheel.wheel_local_version`、`wheel.wheel_artifact_name`、`release.*`
- 调整 GPU 架构：只改 lock `compile.gpu_archs`（Windows 分号分隔）
- 部署前：`python test/gpu-smoke-test.py -w .`（gfx120x 真机，需已 pip install wheel）

## ComfyUI 用法

替换 `python_embeded` 中的 torch wheel 后，启动参数保持 `--use-pytorch-cross-attention`，并设 `TORCH_ROCM_FA_PREFER_CK=1`（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）。
