# pytorch-ck-rocm-gfx1201-build

Windows / **gfx1201** / Python 3.12 上从源码编译带 **ROCm CK Tile SDPA** 的 **PyTorch** wheel（GitHub Actions only）。

## 快速开始

1. Fork 或 push 本仓库到 GitHub
2. Actions → **Build PyTorch CK SDPA serial (Windows gfx1201)** → Run workflow
3. 成功后从 Release 或 Artifacts 下载 `torch-*.whl`

## 配置

所有 pin 在 [`VERSION.lock.json`](VERSION.lock.json)：

| 字段 | 当前值 | 说明 |
|------|--------|------|
| `pytorch.build_commit` | `be878749…` | 含 CK SDPA gfx1201 验证点的 main 分支 |
| `toolchain.rocm` | `7.14.0` | rocm[devel] pip 版本 |
| `compile.gpu_archs` | `gfx1201` | `PYTORCH_ROCM_ARCH` |
| `wheel.wheel_local_version` | `rocm7.14.0.ck.gfx1201` | wheel 本地版本标签 |

## 部署验证（gfx1201 真机）

```powershell
python -m pip install --force-reinstall dist\torch-*.whl
python test\gpu-smoke-test.py -w .
```

## 与 flash-attn 子项目的区别

| | flash-attn-rocm-gfx1201-build | 本仓库 |
|--|-------------------------------|--------|
| 产物 | `flash_attn` 扩展 | 完整 `torch` |
| 依赖 | 需预装 PyTorch | 不装预编译 torch |
| 构建时长 | 数小时 | 更长（全量 PyTorch） |

详见 [`AGENTS.md`](AGENTS.md)。
