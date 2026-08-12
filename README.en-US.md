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
| `compile` | `gpu_archs`, `ck_opt_dim`, `ck_disable_bwd` | `PYTORCH_ROCM_ARCH` (**single arch source**), CK FMHA `opt_dim` tiers; `ck_disable_bwd=true` = inference-only (env `CK_FMHA_DISABLE_BWD=1`, skips bwd codegen) |
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
- **`ck_disable_bwd=true`** (inference-only wheel): skips bwd codegen / fav_v3; calling backward fails at runtime via `TORCH_CHECK`
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
| `compile-and-wheel` | bootstrap (toolchain + worktree restore + verify + mtime pin), `08.build` + `09.wheel`, CPU smoke test | 12 h |

**Worktree cache** (entire `C:\pt\pytorch`: patched source + hipify + `build/`):

- Key: `worktree-v2-lock[{lockHash8}]-lockWheel[{lockWheelHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`
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

A separate **pip toolchain cache** (`PIP_TOOLCHAIN_CACHE_KEY`: `pt-pip-toolchain-v2-py[{python}]-rocm[{rocm}]-idx[{indexHash8}]`, `indexHash8` = lock `toolchain.rocm_index` → SHA256 prefix) and **ccache** (`CCACHE_CACHE_KEY`: `ccache-v2-lock[{lockHash8}]-patch[{patchHash8}]-msvc[{msvcVersion}]-rocmClang[{rocmClangVersion}]-ninja[{ninjaMinor}]-cmake[{cmakeMinor}]`, no `lockWheel`) layer above worktree cache.

### Build stages

Compile and wheel packaging go through CLI commands `08.build` / `09.wheel` (which invoke `build/build-pytorch-steps.py --step build|wheel`):

| CLI | setuptools step | Role |
|-----|-----------------|------|
| `08.build` | `build` | `setup.py build` (upstream skips configure when `build/` is valid) |
| `09.wheel` | `wheel` | `setup.py bdist_wheel`, copies the single `.whl` to `--dist-dir` |

Serial workflow invocation: `npx tsx scripts/cli.ts 08.build` → `09.wheel`. Equivalent: `npm run pt -- 08.build` (CLI program name `pt-build`).

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
| CI smoke test (CPU) | `npx tsx scripts/cli.ts 10.verify --dist-dir dist --build-caches dist\build-caches.json` |
| Pre-deploy GPU smoke test (gfx120x hardware) | `python test/gpu-smoke-test.py -w .` |

Smoke test (`10.verify`, CPU): wheel filename/structure (CK fwd dim markers; bwd negative assertion when `ck_disable_bwd=1`) → SHA256 / manifest → pip install → `torch.backends.cuda.is_ck_sdpa_available()`. GPU CK SDPA forward pass is in `test/gpu-smoke-test.py` (**pip install the wheel first**; run manually on gfx120x hardware before deploy; does not replace `10.verify`).

## ComfyUI install

```powershell
$PY = "<ComfyUI>\python_embeded\python.exe"
& $PY -m pip install --force-reinstall .\downloaded.whl
```

After replacing the torch wheel under `python_embeded`:

- Current wheel is **inference-only** (lock `ck_disable_bwd=true`); no CK FMHA backward
- Keep launch arg **`--use-pytorch-cross-attention`**
- Set env **`TORCH_ROCM_FA_PREFER_CK=1`** (or call `torch.backends.cuda.preferred_rocm_fa_library("ck")` at runtime)

See [AGENTS.md](AGENTS.md) for maintainer conventions.
