# pytorch-ck-rocm-gfx120x-build

**Windows / gfx120x（RDNA4）/ Python 3.12** 带 **CK Tile SDPA** 的 PyTorch 源码 wheel。版本 pin 见 **`VERSION.lock.json`**。仅 **CI**（`windows-2022` 干净 runner），无本地编译入口。编排脚本为 **TypeScript**（Node 26 + `tsx`；亦可 `npm run pt -- <cmd>`）。

## CI 路径

| Workflow | 链路 |
|----------|------|
| **serial** | worktree restore → bootstrap verify → `07.pin-mtimes`（含 ROCm 外部头文件） → cache-hit: `ninja -C` / cache-miss: `setup.py build` → save worktree + ccache → `bdist_wheel` → write `dist/build-caches.json` → CPU smoke test → optional Release |

手动 `workflow_dispatch`（输入：`ninja_workers`→`MAX_JOBS`、`use_cache`、`publish_release`）；setuptools 同进程入口：`build/build-pytorch-steps.py`。Worktree cache：`worktree-v2-lock[{lockHash8}]-lockWheel[{lockWheelHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`（`lockHash8` = lock `toolchain`+`pytorch`+`compile`；`lockWheelHash8` = lock `wheel`；`patchHash8` = `scripts/commands/04.patch.ts`+`scripts/commands/05.hipify.ts`+`scripts/lib/gpu-archs.ts`+`build/add-make-kernel-pt.py`；`msvc`/`rocmClang` = 完整工具链版本号；`ninja`/`cmake` = major.minor；精确 key，无 `restore-keys`）。Ccache：`ccache-v2-lock[…]-patch[…]-msvc[…]-rocmClang[…]-ninja[…]-cmake[…]`（无 `lockWheel`）。Pip：`pt-pip-toolchain-v2-py[…]-rocm[…]-idx[…]`（`01.config`）。

## 命名约定

| 概念 | 统一名称 | 备注 |
|------|----------|------|
| PT 源码根 | `PT_SRC` / `--pt-src` / composite `pt-src` | 全层一致 |
| lock GPU 架构 | `GPU_ARCHS` | lock `compile.gpu_archs`（**唯一架构源**）；`PYTORCH_ROCM_ARCH` / patch runtime arch 列表同源 |
| lock CK codegen 目标 | `CK_TARGETS` | 由 `compile.gpu_archs` 经 `gpu-archs.ts` 推导（如 `gfx1200;gfx1201` → `--targets gfx12`）；`04.patch` 只读 env |
| lock CK OPT_DIM | `CK_OPT_DIM` | lock `compile.ck_opt_dim` 逗号列表；`04.patch` 只读 env |
| lock CK bwd | `CK_FMHA_DISABLE_BWD` | lock `compile.ck_disable_bwd`（`true` = 推理专用，跳过 bwd codegen / fav_v3 / `FLASHATTENTION_DISABLE_BACKWARD`） |
| Worktree cache key | `WORKTREE_CACHE_KEY` | `02.toolchain-fingerprint` → bootstrap restore / compile save / manifest `build_caches[].key` |
| Worktree cache exists | `worktree-cache-exists` | A03 output / manifest `build_caches[].exists` |
| Worktree cache used | `worktree-cache-used` / `WORKTREE_CACHE_USED` | restore hit 且 `06.verify-bootstrap` 通过 → 跳过 prep/patch/hipify（manifest `used`） |
| Ccache key | `CCACHE_CACHE_KEY` | `02.toolchain-fingerprint` → A02 restore / A06 save |
| Compile cache metadata | `--build-caches` | workflow 写入 `dist/build-caches.json` → 10.verify → manifest `build_caches`（`opt_dim/key/exists/used`） |
| wheel local tag | `WHEEL_LOCAL_VERSION` | lock `wheel.wheel_local_version` |
| PT 相关 env | `PYTORCH_*` | repo / commit / force-build 等 |

**缩写对照：** 仓库 `pytorch-ck-rocm-gfx120x-build`；worktree cache 前缀 `worktree-v2-…`；release tag / artifact 前缀见 lock `release_tag_prefix` / `wheel_artifact_name`（当前 `torch-ck-cp312-rocm7.14.0-gfx120x`）。

**lock → GITHUB_ENV 映射：** `toolchain.python`→`PYTHON_VERSION`，`toolchain.rocm`→`ROCM_VERSION`，`toolchain.rocm_index`→`ROCM_INDEX`，`compile.gpu_archs`→`GPU_ARCHS`，`compile.gpu_archs`→`CK_TARGETS`（推导），`compile.ck_opt_dim`→`CK_OPT_DIM`，`compile.ck_disable_bwd`→`CK_FMHA_DISABLE_BWD`，`pytorch.repo`→`PYTORCH_REPO`，`pytorch.build_commit`→`PYTORCH_BUILD_COMMIT`，`pytorch.build_commit_date`→`PYTORCH_BUILD_COMMIT_DATE`（另导出 `SOURCE_DATE_EPOCH`），`02.toolchain-fingerprint --export-github-env`→`WORKTREE_CACHE_KEY`+`CCACHE_CACHE_KEY`，`A00` bootstrap→`WORKTREE_CACHE_USED`，`wheel.wheel_local_version`→`WHEEL_LOCAL_VERSION`，`wheel.wheel_artifact_name`→`WHEEL_ARTIFACT_NAME`，`release.release_tag_prefix`→`RELEASE_TAG_PREFIX`，`release.release_title_prefix`→`RELEASE_TITLE_PREFIX`；`EXPECTED_WHEEL_PATTERN` / `PIP_TOOLCHAIN_CACHE_KEY` 由 `version-lock.ts` 推导；`A01` 设 `CCACHE_DIR`。

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
| `scripts/lib/init-build-env.ts` | ROCm 编译 env（含 `USE_KINETO=0`；Windows 无 rocprofiler）；`installRequirements` 默认 true（仅 `08.build`） |
| `01.config` | 读 lock；`--export-github-env` 写 CI env |
| `02.toolchain-fingerprint` | MSVC/clang + ninja/cmake 指纹；`-w --export-github-env` 输出 `WORKTREE_CACHE_KEY` + `CCACHE_CACHE_KEY` |
| `03.prep` | blob-less 浅 clone PyTorch + 浅 submodule + author date 校验 + strip `.git`（worktree cache miss 时由 bootstrap 调用） |
| `04.patch` | Windows CK SDPA + gfx120x 程序化补丁 + MSVC `/Brepro`（仅 shared/exe 链接器，避开 llvm-lib 静态库）；`CK_FMHA_DISABLE_BWD=1` 时省略 bwd codegen/fav_v3、GLOB 排除 `fmha_bwd` blob、**就地 patch** upstream bwd wrapper 并设 `FLASHATTENTION_DISABLE_BACKWARD`；否则完整 bwd；`CK_FMHA_GENERATE` 用 `${Python3_EXECUTABLE}`；部署 `add_make_kernel_pt.py` + `.cpp→.hip` CMake `file(RENAME)` + CK emit 独立 `RESULT_VARIABLE` |
| `05.hipify` | `tools/amd_build/build_amd.py`（生成 `c10/hip/`、`THH/` 等 ROCm 源码） |
| `06.verify-bootstrap` | worktree cache hit 后校验 prep+patch+hipify 产物（不含 `build/`）；失败则 fallback miss |
| `07.pin-mtimes` | bootstrap 末尾将 PT 工作树 + ROCm SDK 外部头文件 mtime 固定为 `SOURCE_DATE_EPOCH`（满足 ninja 3 条 dirty 检查；见下方"缓存复用"节） |
| `08.build` | cache-hit 时 `ninja -C`（跳过 CMake reconfigure，保 `.ninja_log`）；cache-miss 时 `setup.py build`（cmake configure + 全量编译）；`initBuildEnv` 含 ccache launcher + requirements |
| `09.wheel` | `setup.py bdist_wheel` → 复制到 `dist/`（env 重设，不重复 pip install） |
| `10.verify` | CPU 冒烟（wheel CK fwd dim 符号 + 禁用 bwd 负向断言 + `is_ck_sdpa_available()`）；manifest 含 `ck_disable_bwd` |
| `11.publish` | Release 元数据 |
| `build/build-pytorch-steps.py` | `--step build` / `--step wheel` |
| `build/add-make-kernel-pt.py` | CK FMHA blob `make_kernel`→`make_kernel_pt`（`04.patch` 复制到 PT 源码 `ck/`） |
| `test/gpu-smoke-test.py` | 部署前 GPU 校验（gfx120x 真机；CI 不跑） |

规则：lock 只经 `01.config` 读一次；同 job 其余命令只经 `requireLockEnv` 消费 env；`GPU_ARCHS` / `CK_TARGETS` / `CK_OPT_DIM` / `CK_FMHA_DISABLE_BWD` **禁止**在 patch 内硬编码。ROCm 路径只经 `rocm-sdk-paths.ts`；编译/打 wheel 只经 `build-pytorch-steps.py`。**A01 不安装预编译 torch**（全量源码编译）。

**依赖方向（强制）**：workflow 直接调用 `scripts/cli.ts` 与官方 action；`scripts/commands/*` 只 import `scripts/lib/*`。Python 编译逻辑只经 `build/build-pytorch-steps.py`。

**Composite**

| Action | 用途 |
|--------|------|
| `A00.pt-job-bootstrap` | Node 26/npm + `01.config` + A01 toolchain + `02.toolchain-fingerprint` + A02/A03 cache restore + `06.verify-bootstrap` + 条件 prep/patch/hipify + `07.pin-mtimes`（需 job 级 checkout；依赖 env `PT_SRC`/`USE_CACHE`） |
| `A01.pt-rocm-toolchain` | Python / MSVC / rocm[devel] / ccache / pip toolchain cache / rocm-sdk-libraries + device wheels / `rocm_sdk init`（需 env `GPU_ARCHS`） |
| `A02.ccache-restore` | 恢复 `%RUNNER_TEMP%/ccache`（`CCACHE_CACHE_KEY`） |
| `A03.worktree-cache-restore` | 恢复整棵 PT 工作树（`WORKTREE_CACHE_KEY` 精确匹配） |
| `A04.pt-build-with-cache` | 编译 + save worktree + ccache |
| `A05.worktree-cache-save` | 保存整棵 PT 工作树（patch+hipify+build/） |
| `A06.ccache-save` | 保存 ccache 目录 |
| `A99.pt-verify-publish` | `10.verify` + artifact + 可选 Release |

## 设计决策

分析 / 重构时**勿当缺陷**；与本节冲突时以本节为准。

- **全量 PyTorch 源码编译**（无 parallel workflow）
- **gfx120x 双架构 wheel**：lock `compile.gpu_archs=gfx1200;gfx1201` → `PYTORCH_ROCM_ARCH` 与 `04.patch` runtime arch 列表同源（经 `scripts/lib/gpu-archs.ts`）
- **patch 程序化**（`04.patch.ts`）；`CK_OPT_DIM` / `GPU_ARCHS` / `CK_TARGETS` / `CK_FMHA_DISABLE_BWD` 只从 env 取（`CK_TARGETS` 由 lock `gpu_archs` 推导）
- **ComfyUI 推理 wheel 默认 `compile.ck_disable_bwd=true`**（仅前向 CK FMHA；调用 backward 运行时 `TORCH_CHECK`）
- **`/Brepro` + `SOURCE_DATE_EPOCH`**：固定 PE TimeDateStamp 与 wheel zip 时间戳（`/Brepro` 仅追加到 `CMAKE_SHARED_LINKER_FLAGS` / `CMAKE_EXE_LINKER_FLAGS`，不作用于 `llvm-lib` 静态库链接）
- **`use_cache` 默认 true**（false 时不 restore worktree，仅 lookup；**save 仅 compile 成功时**）
- **worktree cache save**：`use_cache=true` 时 compile 非 skipped 即 save（含失败/取消）；save 前删除所有同类（`worktree-v2-*`）缓存条目
- **ccache save**：同上规则；save 前删除所有同类（`ccache-v2-*`）缓存条目；`CCACHE_MAXSIZE=3G`
- **worktree hit bootstrap**：`06.verify-bootstrap` 通过则 skip prep/patch/hipify；verify 失败 fallback miss
- **compile**：cache-hit 时 `ninja -C build install`（跳过 CMake reconfigure，保 `.ninja_log`）；cache-miss 时 `setup.py build`
- **ccache**：`CMAKE_*_COMPILER_LAUNCHER=ccache`；GHA cache `ccache-v2-lock[…]-patch[…]-msvc[…]-rocmClang[…]-ninja[…]-cmake[…]`（无 `lockWheel`）

## 缓存复用

worktree cache 恢复后，ninja 必须同时通过 **3 条 dirty 检查**才跳过已编译对象。任一失败 → mass recompile。

| 检查 | ninja 源码 | 条件 | 失败时的 explain 原因 | 本项目如何满足 |
|------|-----------|------|---------------------|---------------|
| 1 | `graph.cc:324` | `obj.mtime >= 最新 input mtime` | "output older than most recent input" | `07.pin-mtimes` 将 ROCm SDK 外部头文件钉到 `SOURCE_DATE_EPOCH`（2026-07-03），使缓存 `.obj`（~构建时刻）比所有 input 新 |
| 2 | `graph.cc:338` | `.ninja_log entry.mtime >= 最新 input mtime` | "recorded mtime older than most recent input" | `.ninja_log` 是文本文件，tar 原样保留内容；entry mtime = 编译时刻 > pinned headers |
| 3 | `graph.cc:737` | `obj.mtime <= .ninja_deps 记录的 mtime` | "stored deps info out of date" | `pin-mtimes` 跳过 `build/`（`SKIP_DIR_NAMES = {".git", "build"}`），不 touch `.obj`；tar `--posix` floor 截断 `.obj` mtime 到秒 ≤ 原始纳秒值 |

**关键：为什么必须用 `ninja -C` 而非 `cmake --build`**

`cmake --build` 会检查 CMake reconfigure（依赖 `build/` 内部状态文件 mtime）。`pin-mtimes` 跳过 `build/`，这些文件 mtime 被 tar 扰动，可能触发 reconfigure → 重新生成 `build.ninja` → command hash 全部变化 → mass recompile。`ninja -C` 完全绕过 CMake，直接按现有 `build.ninja` 编译。cache key 的 `patch[hash]` 段保证 patch 变了走 cache-miss 重新 configure。

**pin 的外部目录**（经 `getRocmSdkPaths()` 获取路径）：

| 目录 | pip 包来源 | 包含的关键头文件 |
|------|----------|-----------------|
| `coreRoot/lib/llvm/lib/clang` | `_rocm_sdk_core` | `yvals_core.h`, `vadefs.h` |
| `develRoot/lib/llvm/lib/clang` | `_rocm_sdk_devel` | `cuda_wrappers/new` |
| `develRoot/include` | `_rocm_sdk_devel` | `hip_runtime.h` 等 |

**cache key 前缀统一定义**：`WORKTREE_CACHE_PREFIX`（`worktree-v2`）和 `CCACHE_CACHE_PREFIX`（`ccache-v2`）在 `worktree-cache-key.ts` / `ccache-cache-key.ts` 导出，经 `02.toolchain-fingerprint` 写入 `GITHUB_ENV`，A04 delete step 用 `$env:*_CACHE_PREFIX-*` 做通配匹配。

**cache save 前的清理**：A04 在 save 前删除所有同类前缀缓存（不只删同名 key），确保旧 patch 的缓存不积累，总量不超过 10GB 限制（1 worktree ~2.45GB + 1 ccache ~2GB + 1 pip ~2.25GB ≈ 6.7GB）。

## 编写规范

1. **单一事实来源** — lock 为准；配置/env 仅经 `01.config` 导出一次；hash 计算可经 `version-lock.ts` 再读 lock 文件，禁止命令内二次 `readVersionLock` 取配置。
2. **信任流水线** — 不为漏传参 / 缺 env 加 silent fallback；`appendGithubEnv` / `appendGithubOutput` 缺文件即 throw。
3. **最小路径** — 能力一个入口；异常快速失败，禁止命令内兜底读 lock、`??` 默认 env。
4. **AGENTS 增改须简洁** — 并入现有条目，禁复述 README/代码。

**不要添加：** 双源校验、manifest 读回自证、`PT_SKIP_*`、patch 内硬编码 lock 字段、命令内二次 `readVersionLock`、单行 composite 包装。

**应当保留：** patch 补丁前状态；`10.verify` CK dim 符号扫描；worktree cache 精确 key（`worktree-v2-…`）；`04.patch` `/Brepro`。

## 维护

- 升级 PyTorch：改 `pytorch.build_commit` 与 `pytorch.build_commit_date`（须等于该 commit 的 git **author date**），并核对 `04.patch.ts` 补丁前状态
- 升级 ROCm：同步 `wheel.wheel_local_version`、`wheel.wheel_artifact_name`、`release.*`
- 调整 GPU 架构：只改 lock `compile.gpu_archs`（Windows 分号分隔）
- 部署前：`python test/gpu-smoke-test.py -w .`（gfx120x 真机，需已 pip install wheel）

## ComfyUI 用法

替换 `python_embeded` 中的 torch wheel 后，启动参数保持 `--use-pytorch-cross-attention`，并设 `TORCH_ROCM_FA_PREFER_CK=1`（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）。
