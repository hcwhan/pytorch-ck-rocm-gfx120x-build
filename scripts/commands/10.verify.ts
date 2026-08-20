import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  readBuildCaches,
  validateBuildCachesForVariant,
} from "../lib/build-caches.js";
import { run } from "../lib/exec.js";
import { getRocmSdkDllDirectories } from "../lib/rocm-sdk-paths.js";
import {
  requireGithubActionsEnv,
  requireLockEnv,
} from "../lib/require-env.js";

const PYTHON = "python";

const WHEEL_INSPECT_CODE = `
import re
import sys
import zipfile
from pathlib import Path

wheel = sys.argv[1]
ck_opt_dim = sys.argv[2]
expected_local = sys.argv[3]
min_pyd_bytes = 512 * 1024
min_core_dll_bytes = 512 * 1024
min_aotriton_dll_bytes = 64 * 1024
min_libomp_dll_bytes = 256 * 1024
min_libuv_dll_bytes = 64 * 1024
min_ck_binary_bytes = 64 * 1024
min_aotriton_aks2_count = 10

def wheel_filename_local(local: str) -> str:
    return local.replace('-', '.').replace('_', '.')

opt_dims = [int(part) for part in ck_opt_dim.split(',') if part.strip()]
if not opt_dims:
    raise SystemExit('ERROR: CK_OPT_DIM is missing or empty')

wheel_name = Path(wheel).name
filename_local = wheel_filename_local(expected_local)
local_tag = f'+{filename_local}'
if local_tag not in wheel_name:
    raise SystemExit(
        f'ERROR: wheel filename missing local version tag {local_tag!r}: {wheel_name}'
    )
print(f'OK wheel local tag {filename_local}')

is_windows_wheel = 'win_amd64' in wheel_name

with zipfile.ZipFile(wheel) as zf:
    names = zf.namelist()
    pyds = [name for name in names if name.endswith('.pyd') and 'torch' in name.lower()]
    if not pyds:
        raise SystemExit('ERROR: torch .pyd not found in wheel archive')
    for name in pyds[:3]:
        info = zf.getinfo(name)
        base = Path(name).name
        if is_windows_wheel and base.startswith('_C') and base.endswith('.pyd'):
            print(
                f'OK {name} size={info.file_size} '
                f'(Windows stub loader from stub.c, size check skipped)'
            )
            continue
        if info.file_size < min_pyd_bytes:
            raise SystemExit(f'ERROR: {name} too small ({info.file_size} bytes)')
        print(f'OK {name} size={info.file_size}')

    if is_windows_wheel:
        required_dlls = [
            'torch/lib/torch_python.dll',
            'torch/lib/torch_hip.dll',
            'torch/lib/aotriton_v2.dll',
            'torch/lib/libomp140.x86_64.dll',
            'torch/lib/uv.dll',
        ]
        for dll in required_dlls:
            if dll not in names:
                raise SystemExit(f'ERROR: required Windows wheel binary missing: {dll}')
            info = zf.getinfo(dll)
            if dll.endswith('aotriton_v2.dll'):
                min_bytes = min_aotriton_dll_bytes
            elif dll.endswith('libomp140.x86_64.dll'):
                min_bytes = min_libomp_dll_bytes
            elif dll.endswith('uv.dll'):
                min_bytes = min_libuv_dll_bytes
            else:
                min_bytes = min_core_dll_bytes
            if info.file_size < min_bytes:
                raise SystemExit(f'ERROR: {dll} too small ({info.file_size} bytes)')
            print(f'OK {dll} size={info.file_size}')

        aotriton_prefix = 'torch/lib/aotriton.images/'
        aks2_files = [
            name for name in names
            if name.startswith(aotriton_prefix) and name.endswith('.aks2')
        ]
        if len(aks2_files) < min_aotriton_aks2_count:
            raise SystemExit(
                f'ERROR: aotriton.images .aks2 count {len(aks2_files)} '
                f'< {min_aotriton_aks2_count}'
            )
        print(f'OK aotriton.images aks2 count={len(aks2_files)}')

    ck_binaries = [
        name for name in names
        if name.startswith('torch/') and name.endswith(('.dll', '.pyd'))
    ]
    if not ck_binaries:
        raise SystemExit('ERROR: no torch/*.dll or torch/*.pyd binaries in wheel archive')

    dim_tokens = [f'_d{dim}_'.encode('ascii') for dim in opt_dims]
    found_dims: set[int] = set()
    scanned = 0
    for name in ck_binaries:
        info = zf.getinfo(name)
        if info.file_size < min_ck_binary_bytes:
            continue
        data = zf.read(name)
        scanned += 1
        for dim, token in zip(opt_dims, dim_tokens):
            if token in data:
                found_dims.add(dim)

    missing = [dim for dim in opt_dims if dim not in found_dims]
    if missing:
        raise SystemExit(
            f'ERROR: CK FMHA OPT_DIM kernels missing in wheel binaries: {missing} '
            f'(scanned {scanned} torch binaries)'
        )
    dims_str = ','.join(str(dim) for dim in opt_dims)
    print(f'OK CK FMHA dim markers present dims={dims_str} scanned={scanned}')

    meta_paths = [name for name in names if name.endswith('.dist-info/METADATA')]
    if not meta_paths:
        raise SystemExit('ERROR: METADATA not found in wheel archive')
    meta_text = zf.read(meta_paths[0]).decode('utf-8', errors='replace')

    if not re.search(r'^Name: torch\\s*$', meta_text, re.M):
        raise SystemExit('ERROR: wheel METADATA Name is not torch')
    version_match = re.search(r'^Version: (.+)$', meta_text, re.M)
    if not version_match:
        raise SystemExit('ERROR: wheel METADATA missing Version')
    wheel_version = version_match.group(1).strip()
    if local_tag not in wheel_version:
        raise SystemExit(
            f'ERROR: wheel METADATA Version missing local tag {local_tag!r}: {wheel_version!r}'
        )
    print(f'OK METADATA Name=torch Version={wheel_version}')
`.trim();

const TORCH_IMPORT_CHECK_CODE = `
import os
import sys

def wheel_filename_local(local: str) -> str:
    return local.replace('-', '.').replace('_', '.')

if sys.platform == 'win32':
    for dll_dir in sys.argv[3:]:
        if os.path.isdir(dll_dir):
            os.add_dll_directory(dll_dir)

import torch

expected_local = sys.argv[1]
expected_rocm = sys.argv[2]
local_tags = [
    f'+{expected_local}',
    f'+{wheel_filename_local(expected_local)}',
]
if not any(tag in torch.__version__ for tag in local_tags):
    raise SystemExit(
        f'ERROR: torch version missing local tag {local_tags!r}: {torch.__version__!r}'
    )
if torch.version.rocm != expected_rocm:
    raise SystemExit(
        f'ERROR: rocm version mismatch: {torch.version.rocm!r} != {expected_rocm!r}'
    )
if not torch.backends.cuda.is_ck_sdpa_available():
    raise SystemExit('ERROR: torch.backends.cuda.is_ck_sdpa_available() is False')
if not torch.distributed.is_available():
    raise SystemExit('ERROR: torch.distributed.is_available() is False')
print('OK torch', torch.__version__)
print('OK rocm', torch.version.rocm)
print('OK is_ck_sdpa_available', torch.backends.cuda.is_ck_sdpa_available())
print('OK distributed.is_available', torch.distributed.is_available())
`.trim();

function prependPath(prefix: string): void {
  const current = process.env.PATH ?? "";
  process.env.PATH = current ? `${prefix}${path.delimiter}${current}` : prefix;
}

function matchesGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    "i",
  );
  return regex.test(name);
}

function readWorkflowDispatch(): {
  ninja_workers: number;
  use_cache: boolean;
  retry_count: number;
} {
  const maxJobs = requireGithubActionsEnv("MAX_JOBS");
  const useCache = requireGithubActionsEnv("USE_CACHE");
  const retryCountRaw = requireGithubActionsEnv("RETRY_COUNT");
  const ninjaWorkers = Number(maxJobs);
  const retryCount = Number.parseInt(retryCountRaw, 10);
  if (
    !Number.isFinite(ninjaWorkers) ||
    !Number.isInteger(ninjaWorkers) ||
    ninjaWorkers < 1
  ) {
    throw new Error(`MAX_JOBS must be a positive integer, got ${maxJobs}`);
  }
  if (useCache !== "true" && useCache !== "false") {
    throw new Error(
      `USE_CACHE must be 'true' or 'false', got ${useCache}`,
    );
  }
  if (!Number.isFinite(retryCount) || !Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error(`RETRY_COUNT must be a non-negative integer, got ${retryCountRaw}`);
  }
  return {
    ninja_workers: ninjaWorkers,
    use_cache: useCache === "true",
    retry_count: retryCount,
  };
}

export function runVerify(options: {
  distDir: string;
  buildCaches: string;
}): void {
  const expectedWheelPattern = requireLockEnv("EXPECTED_WHEEL_PATTERN");
  const ckOptDim = requireLockEnv("CK_OPT_DIM");
  const ckTargets = requireLockEnv("CK_TARGETS");
  const pytorchBuildCommit = requireLockEnv("PYTORCH_BUILD_COMMIT");
  const wheelLocalVersion = requireLockEnv("WHEEL_LOCAL_VERSION");
  const rocmVersion = requireLockEnv("ROCM_VERSION");
  const pythonVersion = requireLockEnv("PYTHON_VERSION");
  const gpuArchs = requireLockEnv("GPU_ARCHS");
  const sourceDateEpoch = requireLockEnv("SOURCE_DATE_EPOCH");
  const githubRunId = requireGithubActionsEnv("GITHUB_RUN_ID");
  const githubRunNumber = requireGithubActionsEnv("GITHUB_RUN_NUMBER");
  const githubSha = requireGithubActionsEnv("GITHUB_SHA");
  const distDir = path.resolve(options.distDir);

  const buildCachesPath = options.buildCaches?.trim();
  if (!buildCachesPath) {
    throw new Error("--build-caches is required");
  }

  const buildCaches = validateBuildCachesForVariant({
    buildCaches: readBuildCaches(buildCachesPath),
    ckOptDim,
  });

  const whls = readdirSync(distDir)
    .filter((name) => name.endsWith(".whl"))
    .map((name) => path.join(distDir, name));

  if (whls.length !== 1) {
    throw new Error(
      `Expected exactly one wheel in ${distDir}, found ${whls.length}`,
    );
  }

  const whlPath = whls[0]!;
  const whlName = path.basename(whlPath);
  if (!matchesGlob(whlName, expectedWheelPattern)) {
    throw new Error(
      `Wheel name '${whlName}' does not match expected pattern '${expectedWheelPattern}'`,
    );
  }

  console.log(`Wheel name OK: ${whlName}`);

  const sha256Hex = createHash("sha256")
    .update(readFileSync(whlPath))
    .digest("hex")
    .toLowerCase();
  const checksumPath = path.join(distDir, `${whlName}.sha256`);
  writeFileSync(checksumPath, `${sha256Hex}  ${whlName}\n`, "ascii");

  console.log("=== Wheel structure (pre-install) ===");
  run(PYTHON, [
    "-c",
    WHEEL_INSPECT_CODE,
    whlPath,
    ckOptDim,
    wheelLocalVersion,
  ]);

  const whlStat = statSync(whlPath);
  const manifest = {
    wheel: whlName,
    sha256: sha256Hex,
    size_bytes: whlStat.size,
    pytorch_build_commit: pytorchBuildCommit,
    pytorch_build_commit_date: requireLockEnv("PYTORCH_BUILD_COMMIT_DATE"),
    python: pythonVersion,
    rocm: rocmVersion,
    gpu_archs: gpuArchs,
    ck_targets: ckTargets,
    ck_opt_dim: ckOptDim,
    fmha_bwd: true,
    wheel_local_version: wheelLocalVersion,
    source_date_epoch: Number(sourceDateEpoch),
    build_variant: "serial",
    dispatch: readWorkflowDispatch(),
    build_caches: buildCaches,
    build_github_run_id: githubRunId,
    build_github_run_number: githubRunNumber,
    build_repository_commit: githubSha,
  };

  console.log(`Wheel SHA256: ${sha256Hex}`);
  console.log(`Checksum file: ${checksumPath}`);

  run(PYTHON, ["-m", "pip", "install", "--force-reinstall", whlPath]);

  const rocmDllDirs = getRocmSdkDllDirectories();
  prependPath(rocmDllDirs.join(path.delimiter));
  console.log(`ROCm DLL directories: ${rocmDllDirs.join("; ")}`);

  console.log("=== torch import checks (CPU) ===");
  run(PYTHON, [
    "-c",
    TORCH_IMPORT_CHECK_CODE,
    wheelLocalVersion,
    rocmVersion,
    ...rocmDllDirs,
  ]);

  const manifestPath = path.join(distDir, "wheel.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Manifest file: ${manifestPath}`);
  console.log("CPU smoke test complete");
}
