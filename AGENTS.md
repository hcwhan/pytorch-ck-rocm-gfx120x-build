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
| lock CK OPT_DIM | `CK_OPT_DIM` | lock `compile.ck_opt_dim` 逗号列表；`04.patch` 只读 env |
| lock GPU 架构 | `GPU_ARCHS` | lock `compile.gpu_archs`；`PYTORCH_ROCM_ARCH` 同源 |
| Ninja cache key | `cache-key` | 05.toolchain-fingerprint output → A03.pt-build-with-cache input |
| Compile cache metadata | `--build-caches` | workflow 写入 `dist/build-caches.json` → 09.verify → manifest `build_caches` |
| wheel local tag | `WHEEL_LOCAL_VERSION` | lock `wheel.wheel_local_version` |
| PT 相关 env | `PYTORCH_*` | repo / commit / force-build 等 |

**lock → GITHUB_ENV 映射：** `toolchain.python`→`PYTHON_VERSION`，`toolchain.rocm`→`ROCM_VERSION`，`toolchain.rocm_index`→`ROCM_INDEX`，`compile.gpu_archs`→`GPU_ARCHS`，`compile.ck_opt_dim`→`CK_OPT_DIM`，`pytorch.repo`→`PYTORCH_REPO`，`pytorch.build_commit`→`PYTORCH_BUILD_COMMIT`，`pytorch.build_commit_date`→`PYTORCH_BUILD_COMMIT_DATE`（另导出 `SOURCE_DATE_EPOCH`），`wheel.wheel_local_version`→`WHEEL_LOCAL_VERSION`，`wheel.wheel_artifact_name`→`WHEEL_ARTIFACT_NAME`，`release.release_tag_prefix`→`RELEASE_TAG_PREFIX`，`release.release_title_prefix`→`RELEASE_TITLE_PREFIX`；`EXPECTED_WHEEL_PATTERN` / `PIP_TOOLCHAIN_CACHE_KEY` 由 `version-lock.ts` 推导。

## 复用入口

**脚本**

| 入口 | 职责 |
|------|------|
| `scripts/cli.ts` | 统一 CLI |
| `scripts/lib/version-lock.ts` | **唯一直接读 lock 的 TS 模块**（Zod 校验） |
| `scripts/lib/require-env.ts` | CI env 读取；缺 env 直接 throw |
| `scripts/lib/rocm-sdk-paths.ts` | ROCm SDK 路径（唯一路径发现） |
| `scripts/lib/init-build-env.ts` | ROCm 编译 env；`installRequirements` 默认 true（仅 `06.build`） |
| `01.config` | 读 lock；`--export-github-env` 写 CI env |
| `03.prep` | clone PyTorch + 浅 submodule |
| `04.patch` | Windows CK SDPA + gfx12 程序化补丁 + MSVC `/Brepro` |
| `05.toolchain-fingerprint` | MSVC/clang + pip 指纹；`-w` 输出 `cache-key` |
| `06.build` | `setup.py build`（`initBuildEnv` 含 requirements 安装） |
| `08.wheel` | `setup.py bdist_wheel` → 复制到 `dist/`（env 重设，不重复 pip install） |
| `09.verify` | CPU smoke（wheel 结构 + CK dim 符号 + `is_ck_sdpa_available()`） |
| `10.publish` | Release 元数据 |
| `build/build-pytorch-steps.py` | `--step build` / `--step wheel` |
| `test/gpu-smoke-test.py` | 部署前 GPU 校验（gfx1201 真机；CI 不跑） |

规则：lock 只经 `01.config` 读一次；同 job 其余命令只经 `requireLockEnv` 消费 env，**禁止**命令内再调 `readVersionLock` 或 `??` 默认值兜底。ROCm 路径只经 `rocm-sdk-paths.ts`；编译/打 wheel 只经 `build-pytorch-steps.py`。**A01 不安装预编译 torch**（全量源码编译）。

**依赖方向（强制）**：workflow 直接调用 `scripts/cli.ts` 与官方 action；`scripts/commands/*` 只 import `scripts/lib/*`。Python 编译逻辑只经 `build/build-pytorch-steps.py`。

**Composite**

| Action | 用途 |
|--------|------|
| `A00.pt-job-bootstrap` | Node/npm + `01.config` + prep/patch + A01 toolchain |
| `A01.pt-rocm-toolchain` | Python / MSVC / rocm[devel]（pip toolchain cache） |
| `A02.pt-ninja-cache-restore` | 恢复 ninja 增量缓存 |
| `A03.pt-build-with-cache` | A02 + 编译 + A04 |
| `A04.pt-ninja-cache-save` | 保存 ninja 增量缓存 |
| `A99.pt-verify-publish` | `09.verify` + artifact + 可选 Release |

## 设计决策

分析 / refactor 时**勿当缺陷**；与本节冲突时以本节为准。

- **全量 PyTorch 源码编译**（无 parallel workflow；全量 torch 无法像 FA 按 OPT_DIM 分片）
- **patch 程序化**（`04.patch.ts`），对齐 upstream gfx1201 CK SDPA 所需改动；`CK_OPT_DIM` 只从 env 取
- **upstream 含 bwd CK FMHA**（fwd + fwd_splitkv + fwd_appendkv + bwd）；ComfyUI 推理不用 bwd，但 upstream 无官方 skip 开关，当前不裁 bwd
- **双 gfx12 架构**：patch 在 runtime arch 列表加入 `gfx1200` + `gfx1201`；实际编译目标由 lock `compile.gpu_archs`（`PYTORCH_ROCM_ARCH`）决定，可设为 `gfx1200;gfx1201` 同 wheel 支持两档
- **`/Brepro` + `SOURCE_DATE_EPOCH`**：固定 PE TimeDateStamp 与 wheel zip 时间戳（同 lock/commit 下可复现 SHA256）
- **`ninja_workers` 默认 4**；**`skip_cache_restore` 默认 false**
- smoke test 在 CPU runner 上验证 wheel 二进制 CK dim 符号 + `is_ck_sdpa_available()`（不跑 GPU kernel）

## 编写规范

1. **单一事实来源** — lock 为准；每 job 仅 `01.config` 读 lock 一次，其余从 `GITHUB_ENV` 取。
2. **信任流水线** — 不为漏传参 / 缺 env 加 silent fallback；`appendGithubEnv` / `appendGithubOutput` 缺文件即 throw。
3. **最小路径** — 能力一个入口；异常 fail fast，禁止命令内兜底读 lock、`??` 默认 env。
4. **AGENTS 增改须简洁** — 并入现有条目，禁复述 README/代码。

**不要添加：** 双源校验、manifest 读回自证、`PT_SKIP_*`、命令内二次 `readVersionLock`、patch 内硬编码 lock 字段、薄 one-liner composite。

**应当保留：** patch before-state；`09.verify` CK dim 符号扫描；cache 精确 key；`04.patch` `/Brepro`；`06.build` 单独 pip install requirements。

## 维护

- 升级 PyTorch：改 `pytorch.build_commit` 与 `pytorch.build_commit_date`，并核对 `04.patch.ts` before-state
- bump ROCm：同步 `wheel.wheel_local_version`、`release.*`
- 多 GPU 架构：改 lock `compile.gpu_archs`（Windows 分号分隔，如 `gfx1200;gfx1201`）
- 部署前：`python test/gpu-smoke-test.py -w .`（gfx1201 真机，需已 pip install wheel）

## ComfyUI 用法

替换 `python_embeded` 中的 torch wheel 后，启动参数保持 `--use-pytorch-cross-attention`，并设 `TORCH_ROCM_FA_PREFER_CK=1`（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）。
