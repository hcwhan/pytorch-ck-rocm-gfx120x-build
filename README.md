# pytorch-ck-rocm-gfx1201-build

[English](README.en-US.md)

使用 GitHub Actions 为 **Windows / gfx1201 / Python 3.12** 从源码编译带 **ROCm CK Tile SDPA** 的 **PyTorch** wheel。

工具链版本以 **`VERSION.lock.json`** 为唯一来源，经 workflow 内 `npx tsx scripts/cli.ts 01.config -w $env:GITHUB_WORKSPACE --export-github-env` 注入 CI。

## 目标环境

| 项 | 值 |
|----|-----|
| GPU 架构 | `gfx1201`（RDNA4，Navi 48） |
| 系统 | Windows |
| Python | 3.12 |
| PyTorch 源码 | `VERSION.lock.json` **`pytorch.build_commit`** |
| ROCm | `7.14.0`（`rocm[devel]` pip） |
| Runner | `windows-2022`（GitHub 托管） |

### `VERSION.lock.json` 分组

| 分组 | 字段 | 作用 |
|------|------|------|
| `toolchain` | `python`、`rocm_index`、`rocm` | pip 工具链 pin（**不安装预编译 torch**） |
| `pytorch` | `repo`、`build_commit`、`build_commit_date` | 每次构建精确 clone 的 PyTorch 源码；**升级 PyTorch 时改 `build_commit` 与 `build_commit_date`** |
| `compile` | `gpu_archs`、`ck_opt_dim` | `PYTORCH_ROCM_ARCH` 与 CK FMHA codegen 档位 |
| `wheel` | `wheel_local_version` | wheel 的 `+local` 标签（env `WHEEL_LOCAL_VERSION`） |
| `wheel` | `wheel_artifact_name` | GitHub Actions artifact 名称 |
| `release` | `release_tag_prefix` | Release tag 前缀（`{prefix}-serial-build{run_number}`） |
| `release` | `release_title_prefix` | Release 标题前缀（env `RELEASE_TITLE_PREFIX`） |

`EXPECTED_WHEEL_PATTERN` 由 `wheel.wheel_local_version` + `toolchain.python` 在 `version-lock.ts` 推导，不在 lock 中存储。

规则：CI 始终 clone **`pytorch.build_commit`**（`fetch` + `checkout FETCH_HEAD`），再经 `04.patch` 启用 Windows CK SDPA 并加入 gfx1201 支持。

### 适用显卡（`gfx1201`）

| 类别 | 型号 |
|------|------|
| 消费级 | Radeon RX 9070 XT / RX 9070 / RX 9070 GRE |
| 专业级 | Radeon AI PRO R9700 / R9700S / R9600D |

> **`gfx1200`** 型号（如 RX 9060 系列）不在本 wheel 目标内。

## 编译配置

- **全量 PyTorch 源码编译**（`setup.py build` → `bdist_wheel`）
- **USE_ROCM_CK_SDPA=ON**（Windows + gfx1201 补丁）
- **`PYTORCH_ROCM_ARCH=gfx1201`**
- CK FMHA **`ck_opt_dim=32,64,128,256`**
- wheel local tag：`rocm7.14.0.ck.gfx1201`（见 `wheel.wheel_local_version`）

## 触发方式

| Workflow | 用途 | 触发 |
|----------|------|------|
| **Build PyTorch CK SDPA serial (Windows gfx1201)** | 单 job 全量编译 + ninja cache + 打 wheel | **仅手动** |

> 推送到 `main` **不会**自动触发编译。

**手动输入：**

| 输入 | 默认 | 说明 |
|------|------|------|
| `ninja_workers` | `4` | Ninja 并行 worker 数（OOM 时可改为 `2`） |
| `skip_cache_restore` | `false` | 设为 `true` 时跳过 cache restore（仅 lookup 探测，仍会在编译后保存） |
| `publish_release` | `true` | 设为 `false` 时跳过 GitHub Release 上传 |

### 串行（`build-pytorch-ck-gfx1201-serial.yml`）

| Job | 作用 | 超时 |
|-----|------|------|
| `compile-and-wheel` | clone+patch、toolchain、ninja cache、`06.build` + `08.wheel`、CPU smoke test | 12 h |

- Cache key 含 `VERSION.lock.json` SHA256 前 8 位（`torch-ck-gfx1201-serial-v1-{lockHash8}-`）及三段工具链指纹（MSVC 工具集 / ROCm clang / pip 工具链）；**仅精确匹配**（无 `restore-keys`）。

### 构建阶段

编译/打 wheel 唯一入口：`build/build-pytorch-steps.py`（同进程 `exec_module(setup.py)`），按 `--step` 二选一：

| step | 作用 |
|------|------|
| `build` | `setup.py build`（全量编译） |
| `wheel` | `setup.py bdist_wheel`（打包 wheel） |

串行 workflow 调用序列：`--step build` → `--step wheel`。

env 统一经 `scripts/lib/init-build-env.ts`（含 `SOURCE_DATE_EPOCH`，取自 `pytorch.build_commit_date`）。

## 产物

Artifact：**`wheel_artifact_name`**（Actions 短期下载）

GitHub Release（构建成功后自动上传；`publish_release=true` 时）：

| 字段 | 示例 |
|------|------|
| Tag | `torch-ck-gfx1201-cp312-rocm7.14.0-serial-build123` |
| 标题 | `PyTorch CK SDPA gfx1201 Windows 2026.08.10 19:00:00` |

- `torch-*.whl`
- `torch-*.whl.sha256`
- `wheel.manifest.json`

```powershell
gh release list
gh release download torch-ck-gfx1201-cp312-rocm7.14.0-serial-build123 -D .\dist
```

预期 wheel 文件名（由 `wheel.wheel_local_version` + `toolchain.python` 推导）：

```text
torch-*+rocm7.14.0.ck.gfx1201*-cp312-cp312-win_amd64.whl
```

## 验证

| 检查 | 脚本 |
|------|------|
| CI smoke test（CPU） | `npx tsx scripts/cli.ts 09.verify --dist-dir dist --build-caches dist\build-caches.json` |
| 部署前 GPU smoke test（gfx1201 真机） | `python test/gpu-smoke-test.py -w .` |

Smoke test：wheel 文件名/结构 → pip 安装 → 校验 `torch.backends.cuda.is_ck_sdpa_available()`。GPU 上跑 CK SDPA 见 `test/gpu-smoke-test.py`（部署前在真机手动跑）。

## 安装到 ComfyUI

```powershell
$PY = "<ComfyUI>\python_embeded\python.exe"
& $PY -m pip install --force-reinstall .\downloaded.whl
```

替换 `python_embeded` 中的 torch 后：

- 启动参数保持 **`--use-pytorch-cross-attention`**
- 环境变量 **`TORCH_ROCM_FA_PREFER_CK=1`**（或运行时 `torch.backends.cuda.preferred_rocm_fa_library("ck")`）

更多维护约定见 [AGENTS.md](AGENTS.md)。
