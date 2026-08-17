# pytorch-ck-rocm-gfx120x-build

[中文](README.md)

GitHub Actions workflow to build **PyTorch** with **ROCm CK Tile SDPA** from source for **Windows / gfx120x (RDNA4) / Python 3.12**.

Toolchain versions are pinned in **`VERSION.lock.json`** and loaded via `npx tsx scripts/cli.ts 01.config -w $env:GITHUB_WORKSPACE --export-github-env` in each workflow job. Orchestration scripts are TypeScript (**Node.js 26** + `tsx`).

## Target

| Item | Value |
|------|-------|
| GPU arch | lock **`compile.gpu_archs`** (currently `gfx1200;gfx1201`) |
| OS | Windows |
| Python | 3.12 |
| PyTorch source | `VERSION.lock.json` **`pytorch.build_commit`** (currently `v2.13.0`) |
| ROCm | `7.14.0` (`rocm[devel]` pip) |
| Runner | `windows-2022` (hosted) |

### `VERSION.lock.json` sections

| Section | Field | Role |
|---------|-------|------|
| `toolchain` | `python`, `rocm_index`, `rocm` | pip toolchain pins (**no prebuilt torch install**) |
| `pytorch` | `repo`, `build_commit`, `build_commit_date` | Exact PyTorch source cloned each build (`build_commit` may be a 40-char SHA or tag such as `v2.13.0`); **bump `build_commit` and `build_commit_date` when upgrading PyTorch** |
| `compile` | `gpu_archs`, `ck_opt_dim` | `PYTORCH_ROCM_ARCH` (**single arch source**), CK FMHA `opt_dim` tiers |
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
- **Full CK Tile FMHA build** (forward + backward); **fav_v3** (MI3xx AITER ASM bwd) is included only when lock `gpu_archs` contains **gfx942/gfx950** (skipped for current `gfx1200;gfx1201`)
- Wheel local tag: `ck-rocm7.14.0-gfx120x` (see `wheel.wheel_local_version`)

### vs inference-only (full bwd)

The lock now defaults to **full fwd + bwd** (`compile.ck_disable_bwd` removed). Compared to the previous inference-only wheel (e.g. serial-build100, ~**302 MiB** / `316798971` bytes, CK fwd only):

| Item | inference-only (old) | full bwd (current) |
|------|----------------------|--------------------|
| CK codegen | fwd / fwd_splitkv / fwd_appendkv only | adds bwd list + emit + blob steps |
| Wheel size | ~302 MiB reference (build100) | expected larger (bwd kernels in `torch_hip.dll`, etc.; check Release manifest `size_bytes` after first full-bwd CI) |
| CI full compile | build100 scale | expected significantly longer (extra bwd ninja targets + codegen; cold compile may hit the 5h watchdog retry) |
| ComfyUI diffusion | fwd only; old wheel sufficient | default full wheel works as-is; larger but supports training / backward |

> fav_v3 (MI3xx AITER ASM) is still omitted unless lock includes gfx942/gfx950; current gfx120x lock skips fav_v3.

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
| `compile-and-wheel` | bootstrap (toolchain + worktree restore + verify + mtime pin), `08.build` + `09-retry`/`10.wheel`, CPU smoke test | 12 h |

**Worktree cache** (entire `C:\pt\pytorch`: patched source + hipify + `build/`):

- Key: `worktree-v3-lock[{lockHash8}]-lockWheel[{lockWheelHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`
- `lockHash8`: lock `toolchain` + `pytorch` + `compile` → SHA256 prefix (8 hex chars)
- `lockWheelHash8`: lock `wheel` → SHA256 prefix (8 hex chars)
- `patchHash8`: `scripts/commands/04.patch.ts`, `scripts/commands/05.hipify.ts`, `scripts/lib/gpu-archs.ts`, `build/add-make-kernel-pt.py` → SHA256 prefix (8 hex chars)
- `msvcVersion`: latest MSVC toolset dir name from vswhere (full version, e.g. `14.42.34433`)
- `rocmClangVersion`: full version token parsed from `clang --version` (e.g. `19.0.0git`)
- `ninja` / `cmake`: major.minor from `ninja --version` / `cmake --version`
- **Exact match only** (no `restore-keys`)
- **hit + verify pass**: skip prep / patch / hipify
- **compile**: always **`setup.py build`** (upstream skips configure when `build/` is valid)
- **save**: `use_cache=true` saves after compile (not skipped); `use_cache=false` saves only on success
- **miss / verify fail**: prep → patch → hipify → compile → save

A separate **pip toolchain cache** (`PIP_TOOLCHAIN_CACHE_KEY`: `pt-pip-toolchain-v2-py[{python}]-rocm[{rocm}]-idx[{indexHash8}]`, `indexHash8` = lock `toolchain.rocm_index` → SHA256 prefix) and **ccache** (`CCACHE_CACHE_KEY`: `ccache-v3-lock[{lockHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`, no `lockWheel`) layer above worktree cache.

### Build stages

After bootstrap (`01.config`–`07.pin-mtimes`, via A00), the serial workflow runs CLI `08`–`12` in order; `08.build` / `10.wheel` invoke `build/build-pytorch-steps.py --step build|wheel`:

| CLI | setuptools step | Role |
|-----|-----------------|------|
| `08.build` | `build` | `setup.py build` (upstream skips configure when `build/` is valid) |
| `09-retry` | — | Dispatch retry workflow after watchdog abort (after A04 save; `if: always()` guard; skipped on success path) |
| `10.wheel` | `wheel` | `setup.py bdist_wheel`, copies the single `.whl` to `--dist-dir` |
| `11.verify` | — | CPU wheel smoke test (structure/CK symbols/SHA256/manifest + pip install + `is_ck_sdpa_available()`) |
| `12.publish` | — | Prepare GitHub Release metadata (`publish_release=true`, via A99) |

Success path: `npx tsx scripts/cli.ts 08.build` → `10.wheel` → `11.verify` → `12.publish`. On watchdog abort, `09-retry` runs after `08.build`. Equivalent: `npm run pt -- 08.build` (CLI program name `pt-build`).

Env is set uniformly via `scripts/lib/init-build-env.ts` (includes `SOURCE_DATE_EPOCH` from `pytorch.build_commit_date`).

## Output

Artifact: **`wheel_artifact_name`** — `.whl`, `.sha256`, `wheel.manifest.json` (7-day retention)

GitHub Release (uploaded after a successful build when `publish_release=true`; **prerelease**, not auto-marked latest; title format `{prefix} YYYY.MM.DD HH:mm:ss`, Asia/Shanghai):

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
| CI smoke test (CPU) | `npx tsx scripts/cli.ts 11.verify --dist-dir dist --build-caches dist\build-caches.json` |
| Pre-deploy GPU smoke test (gfx120x hardware) | `python test/gpu-smoke-test.py -w .` |

Smoke test (`11.verify`, CPU): wheel filename/structure (CK fwd/bwd dim markers) → SHA256 / manifest → pip install → `torch.backends.cuda.is_ck_sdpa_available()`. GPU CK SDPA fwd/bwd is in `test/gpu-smoke-test.py` (**pip install the wheel first**; run manually on gfx120x hardware before deploy; does not replace `11.verify`; uses `sdpa_kernel(SDPBackend.FLASH_ATTENTION)` under `TORCH_ROCM_FA_PREFER_CK=1` so fwd/bwd must use CK, not math fallback).

## ComfyUI install

```powershell
$PY = "<ComfyUI>\python_embeded\python.exe"
& $PY -m pip install --force-reinstall .\downloaded.whl
```

After replacing the torch wheel under `python_embeded`:

- Current wheel is **full CK Tile FMHA** (forward + backward); fav_v3 omitted (lock has no MI3xx arch)
- Keep launch arg **`--use-pytorch-cross-attention`**
- Set env **`TORCH_ROCM_FA_PREFER_CK=1`** (or call `torch.backends.cuda.preferred_rocm_fa_library("ck")` at runtime)

See [AGENTS.md](AGENTS.md) for maintainer conventions.
