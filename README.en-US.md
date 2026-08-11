# pytorch-ck-rocm-gfx120x-build

[中文](README.md)

GitHub Actions workflow to build **PyTorch** with **ROCm CK Tile SDPA** from source for **Windows / gfx120x (RDNA4) / Python 3.12**.

Toolchain versions are pinned in **`VERSION.lock.json`** and loaded via `npx tsx scripts/cli.ts 01.config -w $env:GITHUB_WORKSPACE --export-github-env` in each workflow job.

## Target

| Item | Value |
|------|-------|
| GPU arch | lock **`compile.gpu_archs`** (currently `gfx1200;gfx1201`) |
| OS | Windows |
| Python | 3.12 |
| PyTorch source | `VERSION.lock.json` **`pytorch.build_commit`** |
| ROCm | `7.14.0` (`rocm[devel]` pip) |
| Runner | `windows-2022` (hosted) |

### `VERSION.lock.json` sections

| Section | Field | Role |
|---------|-------|------|
| `toolchain` | `python`, `rocm_index`, `rocm` | pip toolchain pins (**no prebuilt torch install**) |
| `pytorch` | `repo`, `build_commit`, `build_commit_date` | Exact PyTorch source cloned each build (`build_commit` may be a 40-char SHA or tag such as `v2.13.0`); **bump `build_commit` and `build_commit_date` when upgrading PyTorch** |
| `compile` | `gpu_archs`, `ck_opt_dim` | `PYTORCH_ROCM_ARCH` (**single arch source**) and CK FMHA `opt_dim` tiers |
| `wheel` | `wheel_local_version` | Wheel `+local` tag (env `WHEEL_LOCAL_VERSION`) |
| `wheel` | `wheel_artifact_name` | GitHub Actions artifact name |
| `release` | `release_tag_prefix` | Release tag prefix (`{prefix}-serial-build{run_number}`) |
| `release` | `release_title_prefix` | Release title prefix (env `RELEASE_TITLE_PREFIX`; GitHub Release name = `{prefix} YYYY.MM.DD HH:mm:ss`, Asia/Shanghai) |

`EXPECTED_WHEEL_PATTERN` and `CK_TARGETS` are derived from the lock in `version-lock.ts` / `gpu-archs.ts`, not stored in the lock file (e.g. `gfx1200;gfx1201` → `CK_TARGETS=--targets gfx12`).

Prep clones **`pytorch.build_commit`** (SHA or tag; `fetch origin <ref>` + `checkout FETCH_HEAD`), then `04.patch` enables Windows CK SDPA; runtime arch lists in the patch follow lock `compile.gpu_archs`.

### Supported GPUs (gfx120x / RDNA4)

| HIP ID | Chip | Example models |
|--------|------|----------------|
| **gfx1201** | Navi 48 | RX 9070 XT / RX 9070 / RX 9070 GRE; Radeon AI PRO R9700 series |
| **gfx1200** | Navi 44 | RX 9060 XT / RX 9060 / RX 9060 XT LP; RX 9050 series |

## Build profile

- **Full PyTorch source build** (`setup.py build` → `bdist_wheel`)
- **USE_ROCM_CK_SDPA=ON** (Windows + gfx120x patches)
- **`PYTORCH_ROCM_ARCH`** = lock `compile.gpu_archs` (semicolon-separated on Windows)
- **`CK_TARGETS`** = derived from `compile.gpu_archs` (currently `gfx1200;gfx1201` → `--targets gfx12`)
- CK FMHA **`ck_opt_dim`** = lock `compile.ck_opt_dim` (currently `32,64,128,256`)
- Wheel local tag: `ck-rocm7.14.0-gfx120x` (see `wheel.wheel_local_version`)

## Trigger

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| **Build PyTorch CK SDPA serial (Windows gfx120x)** | Single-job full compile + worktree cache + wheel | **Manual only** |

Push to `main` does **not** auto-trigger builds.

**Manual inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `ninja_workers` | `4` | Ninja parallel workers (use `2` if OOM) |
| `use_cache` | `true` | Set `false` to skip restore (still probes `exists`; `used=false`; save only after a successful compile) |
| `publish_release` | `true` | Set `false` to skip GitHub Release upload |

### Serial (`build-pytorch-ck-gfx120x-serial.yml`)

| Job | Role | Timeout |
|-----|------|---------|
| `compile-and-wheel` | bootstrap (toolchain + worktree restore), `07.build` + `08.wheel`, CPU smoke test | 12 h |

**Worktree cache** (entire `C:\pt\pytorch`: patched source + hipify + `build/`):

- Key: `worktree-v1-{lockHash8}-{patchHash8}-{wheelHash8}-msvc{…}-rocmClang{…}-pipToolchain{…}`
- `lockHash8`: lock `toolchain` + `pytorch` + `compile`
- `patchHash8`: `04.patch.ts`, `05.hipify.ts`, `gpu-archs.ts`, `add-make-kernel-pt.py`
- `wheelHash8`: lock `wheel`
- `pipToolchain`: pip / setuptools / wheel / ninja / packaging / psutil / **cmake**
- **Exact match only** (no `restore-keys`)
- **hit**: skip prep / patch / hipify; `07.build` uses **`ninja-install`** (no setup.py/cmake rerun)
- **miss**: prep → patch → hipify → compile → save
- `use_cache=false`: skip restore (still probes `exists`); save only after a **successful** compile

A separate **pip toolchain cache** (`PIP_TOOLCHAIN_CACHE_KEY`) and **ccache** (`CCACHE_CACHE_KEY`, `ccache-v1-{lockHash8}-{patchHash8}-…`) layer above worktree cache.

### Build stages

Single entry point for compile and wheel packaging: `build/build-pytorch-steps.py` (in-process `exec_module(setup.py)`), one of two `--step` modes:

| step | Role |
|------|------|
| `build` | `setup.py build` (worktree miss cold start) |
| `ninja-install` | `ninja -C build install` (worktree hit incremental compile) |
| `wheel` | `setup.py bdist_wheel` (package wheel) |

Serial workflow invocation: `--step build` → `--step wheel`.

Env is set uniformly via `scripts/lib/init-build-env.ts` (includes `SOURCE_DATE_EPOCH` from `pytorch.build_commit_date`).

## Output

Artifact: **`wheel_artifact_name`** — `.whl`, `.sha256`, `wheel.manifest.json` (short-term Actions download).

GitHub Release (uploaded after a successful build when `publish_release=true`; title format `{prefix} YYYY.MM.DD HH:mm:ss`, Asia/Shanghai):

| Workflow | Tag example | Release title example |
|----------|-------------|----------------------|
| serial | `torch-ck-cp312-rocm7.14.0-gfx120x-serial-build123` | PyTorch CK SDPA gfx120x Windows 2026.08.10 19:00:00 |

```powershell
gh release list
gh release download torch-ck-cp312-rocm7.14.0-gfx120x-serial-build123 -D .\dist
```

Expected wheel name (derived from `wheel.wheel_local_version` + `toolchain.python`; PEP 440 normalizes `-` to `.` in the local tag):

```text
torch-*+ck.rocm7.14.0.gfx120x*-cp312-cp312-win_amd64.whl
```

## Verification

| Check | Script |
|-------|--------|
| CI smoke test (CPU) | `npx tsx scripts/cli.ts 09.verify --dist-dir dist --build-caches dist\build-caches.json` |
| Pre-deploy GPU smoke test (gfx120x hardware) | `python test/gpu-smoke-test.py -w .` |

Smoke test covers wheel filename/structure (including CK dim markers), pip install, and `torch.backends.cuda.is_ck_sdpa_available()`. GPU CK SDPA forward pass is in `test/gpu-smoke-test.py` (run manually on gfx120x hardware before deploy).

## ComfyUI install

```powershell
$PY = "<ComfyUI>\python_embeded\python.exe"
& $PY -m pip install --force-reinstall .\downloaded.whl
```

After replacing the torch wheel under `python_embeded`:

- Keep launch arg **`--use-pytorch-cross-attention`**
- Set env **`TORCH_ROCM_FA_PREFER_CK=1`** (or call `torch.backends.cuda.preferred_rocm_fa_library("ck")` at runtime)

See [AGENTS.md](AGENTS.md) for maintainer conventions.
