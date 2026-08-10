# pytorch-ck-rocm-gfx1201-build

**Windows / gfx1201 / Python 3.12** 带 **CK Tile SDPA + gfx1201** 的 PyTorch 源码 wheel。版本 pin 见 **`VERSION.lock.json`**。仅 **CI**（`windows-2022` 干净 runner），无本地编译入口。编排脚本为 **TypeScript**（Node 26 + `tsx`；亦可 `npm run pt -- <cmd>`）。

## CI 路径

| Workflow | 链路 |
|----------|------|
| **serial** | clone+patch → `setup.py build`（ninja cache）→ `bdist_wheel` → CPU smoke test |

手动 `workflow_dispatch`；setuptools 同进程入口：`build/build-pytorch-steps.py`。Cache 前缀：`torch-ck-gfx1201-serial-v1-{lockHash8}`（`lockHash8` = `VERSION.lock.json` SHA256 前 8 位；精确 key，无 `restore-keys`；key 含 `msvc` + `rocmClang` + `pipToolchain` 三段指纹）。

## 命名约定

| 概念 | 统一名称 | 备注 |
|------|----------|------|
| PT 源码根 | `PT_SRC` / `--pt-src` / composite `pt-src` | 全层一致 |
| lock CK OPT_DIM | `CK_OPT_DIM` | lock `compile.ck_opt_dim` 逗号列表 |
| Ninja cache key | `cache-key` | 05.toolchain-fingerprint output → A03.pt-build-with-cache input |
| Compile cache metadata | `--build-caches` | workflow 写入 `dist/build-caches.json` → 09.verify → manifest `build_caches` |
| wheel local tag | `WHEEL_LOCAL_VERSION` | lock `wheel.wheel_local_version` |
| PT 相关 env | `PYTORCH_*` | repo / commit / force-build 等 |

**lock → GITHUB_ENV 映射：** `toolchain.python`→`PYTHON_VERSION`，`toolchain.rocm`→`ROCM_VERSION`，`toolchain.rocm_index`→`ROCM_INDEX`，`compile.gpu_archs`→`GPU_ARCHS`，`compile.ck_opt_dim`→`CK_OPT_DIM`，`pytorch.repo`→`PYTORCH_REPO`，`pytorch.build_commit`→`PYTORCH_BUILD_COMMIT`，`pytorch.build_commit_date`→`PYTORCH_BUILD_COMMIT_DATE`（另导出 `SOURCE_DATE_EPOCH`），`wheel.*` / `release.*` 同 FA 项目模式；`EXPECTED_WHEEL_PATTERN` / `PIP_TOOLCHAIN_CACHE_KEY` 由 `version-lock.ts` 推导。

## 复用入口

| 入口 | 职责 |
|------|------|
| `scripts/cli.ts` | 统一 CLI |
| `scripts/lib/version-lock.ts` | **唯一直接读 lock 的 TS 模块** |
| `01.config` | 读 lock；`--export-github-env` 写 CI env |
| `03.prep` | clone PyTorch + 浅 submodule |
| `04.patch` | Windows CK SDPA + gfx1201 程序化补丁 |
| `05.toolchain-fingerprint` | MSVC/clang + pip 指纹；`-w` 输出 `cache-key` |
| `06.build` | `setup.py build` |
| `08.wheel` | `setup.py bdist_wheel` → 复制到 `dist/` |
| `09.verify` | CPU smoke（`is_ck_sdpa_available()`） |
| `10.publish` | Release 元数据 |
| `build/build-pytorch-steps.py` | `--step build` / `--step wheel` |
| `test/gpu-smoke-test.py` | 部署前 GPU 校验（gfx1201 真机；CI 不跑） |

规则：lock 只经 `01.config` 读一次；ROCm 路径只经 `rocm-sdk-paths.ts`；编译/打 wheel 只经 `build-pytorch-steps.py`。**A01 不安装预编译 torch**（全量源码编译）。

**Composite：** `A00.pt-job-bootstrap` → `A01.pt-rocm-toolchain`（仅 rocm[devel]）→ `A03.pt-build-with-cache`（A02/A04 ninja cache）→ `A99.pt-verify-publish`。

## 设计决策

- **全量 PyTorch 源码编译**（非替换现有 torch wheel 的扩展包）
- **patch 程序化**（`04.patch.ts`），对齐 upstream gfx1201 CK SDPA 所需改动
- **`ninja_workers` 默认 4**；**`skip_cache_restore` 默认 false**
- smoke test 在 CPU runner 上验证 `is_ck_sdpa_available()`（不跑 GPU kernel）

## 维护

- 升级 PyTorch：改 `pytorch.build_commit` 与 `pytorch.build_commit_date`，并核对 `04.patch.ts` before-state
- bump ROCm：同步 `wheel.wheel_local_version`、`release.*`
- 部署前：`python test/gpu-smoke-test.py -w .`（gfx1201 真机，需已 pip install wheel）

## ComfyUI 用法

替换 `python_embeded` 中的 torch wheel 后，启动参数保持 `--use-pytorch-cross-attention`，并设 `TORCH_ROCM_FA_PREFER_CK=1`（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）。
