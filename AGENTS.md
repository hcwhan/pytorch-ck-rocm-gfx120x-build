# pytorch-ck-rocm-gfx120x-build

**Windows / gfx120x（RDNA4）/ Python 3.12** 带 **CK Tile SDPA** 的 PyTorch 源码 wheel。版本 pin 见 **`VERSION.lock.json`**。仅 **CI**（`windows-2022` 干净 runner），无本地编译入口。编排脚本为 **TypeScript**（Node 26 + `tsx`；亦可 `npm run pt -- <cmd>`）。

## CI 路径

| Workflow | 链路 |
|----------|------|
| **serial** | clone+patch+hipify → `setup.py build`（ninja cache）→ `bdist_wheel` → CPU smoke test |

手动 `workflow_dispatch`；setuptools 同进程入口：`build/build-pytorch-steps.py`。Cache 前缀：`torch-ck-gfx120x-serial-v2-{lockHash8}`（`lockHash8` = lock `toolchain`+`pytorch`+`compile` JSON SHA256 前 8 位；不含 `wheel`/`release`；精确 key，无 `restore-keys`；key 含 `msvc` + `rocmClang` + `pipToolchain` 三段指纹）。

## 命名约定

| 概念 | 统一名称 | 备注 |
|------|----------|------|
| PT 源码根 | `PT_SRC` / `--pt-src` / composite `pt-src` | 全层一致 |
| lock GPU 架构 | `GPU_ARCHS` | lock `compile.gpu_archs`（**唯一架构源**）；`PYTORCH_ROCM_ARCH` / patch runtime arch 列表同源 |
| lock CK codegen 目标 | `CK_TARGETS` | 由 `compile.gpu_archs` 经 `gpu-archs.ts` 推导（如 `gfx1200;gfx1201` → `--targets gfx12`）；`04.patch` 只读 env |
| lock CK OPT_DIM | `CK_OPT_DIM` | lock `compile.ck_opt_dim` 逗号列表；`04.patch` 只读 env |
| lock CK bwd | `CK_FMHA_DISABLE_BWD` | lock `compile.ck_disable_bwd`（`true` = 推理专用，跳过 bwd codegen / fav_v3 / `FLASHATTENTION_DISABLE_BACKWARD`） |
| Ninja cache key | `cache-key` | 05.toolchain-fingerprint output → A03.pt-build-with-cache input / manifest `build_caches[].key` |
| Ninja cache exists | `cache-exists` | A02/A03 output / manifest `build_caches[].exists` |
| Ninja cache used | `cache-used` | A02/A03 output / manifest `build_caches[].used`（`use_cache=true` 且 restore 命中） |
| Compile cache metadata | `--build-caches` | workflow 写入 `dist/build-caches.json` → 09.verify → manifest `build_caches`（`opt_dim/key/exists/used`） |
| wheel local tag | `WHEEL_LOCAL_VERSION` | lock `wheel.wheel_local_version` |
| PT 相关 env | `PYTORCH_*` | repo / commit / force-build 等 |

**缩写对照：** 仓库 `pytorch-ck-rocm-gfx120x-build`；ninja cache 前缀 `torch-ck-gfx120x-serial-v2-{lockHash8}`；release tag / artifact 前缀见 lock `release_tag_prefix` / `wheel_artifact_name`（当前 `torch-ck-cp312-rocm7.14.0-gfx120x`）。

**lock → GITHUB_ENV 映射：** `toolchain.python`→`PYTHON_VERSION`，`toolchain.rocm`→`ROCM_VERSION`，`toolchain.rocm_index`→`ROCM_INDEX`，`compile.gpu_archs`→`GPU_ARCHS`，`compile.gpu_archs`→`CK_TARGETS`（推导），`compile.ck_opt_dim`→`CK_OPT_DIM`，`compile.ck_disable_bwd`→`CK_FMHA_DISABLE_BWD`，`pytorch.repo`→`PYTORCH_REPO`，`pytorch.build_commit`→`PYTORCH_BUILD_COMMIT`，`pytorch.build_commit_date`→`PYTORCH_BUILD_COMMIT_DATE`（另导出 `SOURCE_DATE_EPOCH`），`pytorch.repo`+`pytorch.build_commit`→`PT_SRC_CACHE_KEY`（`pt-src-v1-{hash8}`），`wheel.wheel_local_version`→`WHEEL_LOCAL_VERSION`，`wheel.wheel_artifact_name`→`WHEEL_ARTIFACT_NAME`，`release.release_tag_prefix`→`RELEASE_TAG_PREFIX`，`release.release_title_prefix`→`RELEASE_TITLE_PREFIX`；`EXPECTED_WHEEL_PATTERN` / `PIP_TOOLCHAIN_CACHE_KEY` 由 `version-lock.ts` 推导。

## 复用入口

**脚本**

| 入口 | 职责 |
|------|------|
| `scripts/cli.ts` | 统一 CLI |
| `scripts/lib/version-lock.ts` | **唯一直接读 lock 的 TS 模块**（Zod 校验） |
| `scripts/lib/gpu-archs.ts` | 解析 lock `GPU_ARCHS`；由 `gpu_archs` 推导 `CK_TARGETS`（HIP → CK 族映射）供 patch |
| `scripts/lib/require-env.ts` | CI env 读取；缺 env 直接 throw |
| `scripts/lib/rocm-sdk-paths.ts` | ROCm SDK 路径（唯一路径发现） |
| `scripts/lib/init-build-env.ts` | ROCm 编译 env（含 `USE_KINETO=0`；Windows 无 rocprofiler）；`installRequirements` 默认 true（仅 `06.build`） |
| `01.config` | 读 lock；`--export-github-env` 写 CI env |
| `03.prep` | clone PyTorch + 浅 submodule；`--use-cache` 校验 `.pt-prep-stamp.json` 后跳过 clone |
| `04.patch` | Windows CK SDPA + gfx120x 程序化补丁 + MSVC `/Brepro`（仅 shared/exe 链接器，避开 llvm-lib 静态库）；`CK_FMHA_DISABLE_BWD=1` 时省略 bwd codegen/fav_v3、GLOB 排除 `fmha_bwd` blob、**就地 patch** upstream bwd wrapper 并设 `FLASHATTENTION_DISABLE_BACKWARD`；否则完整 bwd；`CK_FMHA_GENERATE` 用 `${Python3_EXECUTABLE}`；部署 `add_make_kernel_pt.py` + `.cpp→.hip` CMake `file(RENAME)` + CK emit 独立 `RESULT_VARIABLE` |
| `04.hipify` | `tools/amd_build/build_amd.py`（生成 `c10/hip/`、`THH/` 等 ROCm 源码） |
| `05.toolchain-fingerprint` | MSVC/clang + pip 指纹；`-w` 输出 `cache-key` |
| `06.build` | `setup.py build`（`initBuildEnv` 含 requirements 安装） |
| `08.wheel` | `setup.py bdist_wheel` → 复制到 `dist/`（env 重设，不重复 pip install） |
| `09.verify` | CPU 冒烟（wheel CK fwd dim 符号 + 禁用 bwd 负向断言 + `is_ck_sdpa_available()`）；manifest 含 `ck_disable_bwd` |
| `10.publish` | Release 元数据 |
| `build/build-pytorch-steps.py` | `--step build` / `--step wheel` |
| `build/add-make-kernel-pt.py` | CK FMHA blob `make_kernel`→`make_kernel_pt`（`04.patch` 复制到 PT 源码 `ck/`） |
| `test/gpu-smoke-test.py` | 部署前 GPU 校验（gfx120x 真机；CI 不跑） |

规则：lock 只经 `01.config` 读一次；同 job 其余命令只经 `requireLockEnv` 消费 env；`GPU_ARCHS` / `CK_TARGETS` / `CK_OPT_DIM` / `CK_FMHA_DISABLE_BWD` **禁止**在 patch 内硬编码。ROCm 路径只经 `rocm-sdk-paths.ts`；编译/打 wheel 只经 `build-pytorch-steps.py`。**A01 不安装预编译 torch**（全量源码编译）。

**依赖方向（强制）**：workflow 直接调用 `scripts/cli.ts` 与官方 action；`scripts/commands/*` 只 import `scripts/lib/*`。Python 编译逻辑只经 `build/build-pytorch-steps.py`。

**Composite**

| Action | 用途 |
|--------|------|
| `A00.pt-job-bootstrap` | Node/npm + `01.config` + prep/patch/hipify + A01 toolchain |
| `A01.pt-rocm-toolchain` | Python / MSVC / rocm[devel]（pip toolchain cache） |
| `A02.pt-ninja-cache-restore` | 恢复 ninja 增量缓存 |
| `A03.pt-build-with-cache` | A02 + 编译 + A04 |
| `A04.pt-ninja-cache-save` | 保存 ninja 增量缓存 |
| `A05.pt-src-cache-restore` | 恢复 prep 源码树（`PT_SRC_CACHE_KEY` 精确匹配） |
| `A06.pt-src-cache-save` | 保存 prep 源码树（仅 `03.prep` 实际 clone 时） |
| `A99.pt-verify-publish` | `09.verify` + artifact + 可选 Release |

## 设计决策

分析 / 重构时**勿当缺陷**；与本节冲突时以本节为准。

- **全量 PyTorch 源码编译**（无 parallel workflow）
- **gfx120x 双架构 wheel**：lock `compile.gpu_archs=gfx1200;gfx1201` → `PYTORCH_ROCM_ARCH` 与 `04.patch` runtime arch 列表同源（经 `scripts/lib/gpu-archs.ts`）
- **patch 程序化**（`04.patch.ts`）；`CK_OPT_DIM` / `GPU_ARCHS` / `CK_TARGETS` / `CK_FMHA_DISABLE_BWD` 只从 env 取（`CK_TARGETS` 由 lock `gpu_archs` 推导）
- **ComfyUI 推理 wheel 默认 `compile.ck_disable_bwd=true`**（仅前向 CK FMHA；调用 backward 运行时 `TORCH_CHECK`）
- **`/Brepro` + `SOURCE_DATE_EPOCH`**：固定 PE TimeDateStamp 与 wheel zip 时间戳（`/Brepro` 仅追加到 `CMAKE_SHARED_LINKER_FLAGS` / `CMAKE_EXE_LINKER_FLAGS`，不作用于 `llvm-lib` 静态库链接）
- **`ninja_workers` 默认 4**；**`use_cache` 默认 true**（false 时仅 lookup：`cache-exists` 仍探测，`cache-used=false`）
- **ninja cache save**：`use_cache=true` 时 build 非 skipped 即 save；**`use_cache=false` 时仅成功时 save**；`cache-exists` 时 save 前先 delete
- smoke test 在 CPU runner 上验证 wheel CK dim 符号 + `is_ck_sdpa_available()`（不跑 GPU kernel）

## 编写规范

1. **单一事实来源** — lock 为准；每 job 仅 `01.config` 读 lock 一次，其余从 `GITHUB_ENV` 取。
2. **信任流水线** — 不为漏传参 / 缺 env 加 silent fallback；`appendGithubEnv` / `appendGithubOutput` 缺文件即 throw。
3. **最小路径** — 能力一个入口；异常快速失败，禁止命令内兜底读 lock、`??` 默认 env。
4. **AGENTS 增改须简洁** — 并入现有条目，禁复述 README/代码。

**不要添加：** 双源校验、manifest 读回自证、`PT_SKIP_*`、patch 内硬编码 lock 字段、命令内二次 `readVersionLock`、单行 composite 包装。

**应当保留：** patch 补丁前状态；`09.verify` CK dim 符号扫描；cache 精确 key（`torch-ck-gfx120x-serial-v2-{lockHash8}` + 工具链指纹）；`04.patch` `/Brepro`。

## 维护

- 升级 PyTorch：改 `pytorch.build_commit` 与 `pytorch.build_commit_date`，并核对 `04.patch.ts` 补丁前状态
- 升级 ROCm：同步 `wheel.wheel_local_version`、`release.*`
- 调整 GPU 架构：只改 lock `compile.gpu_archs`（Windows 分号分隔）
- 部署前：`python test/gpu-smoke-test.py -w .`（gfx120x 真机，需已 pip install wheel）

## ComfyUI 用法

替换 `python_embeded` 中的 torch wheel 后，启动参数保持 `--use-pytorch-cross-attention`，并设 `TORCH_ROCM_FA_PREFER_CK=1`（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）。
