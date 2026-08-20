"""通过 subprocess 调用 setuptools 构建 PyTorch（build / wheel）。"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

_BWD_API_OBJ = "fmha_bwd_api.hip.obj"
_MHA_BWD_CK_OBJ = "mha_bwd_ck.hip.obj"
_CK_SDPA_LIB_NAMES = ("ck_sdpa.lib", "libck_sdpa.a")
_TORCH_HIP_DLL_NAMES = ("torch_hip.dll", "libtorch_hip.so")

_SETUP_SKIP_BUILD_DEPS_MARKER = "PYTORCH_CK_SKIP_BUILD_DEPS"
_LIBOMP_DLL = "libomp140.x86_64.dll"
_LIBUV_DLL = "uv.dll"
_SETUP_SKIP_BUILD_DEPS_BEFORE = (
    "RUN_BUILD_DEPS = True\n"
    "# see if the user passed a quiet flag to setup.py arguments and respect"
)
_SETUP_SKIP_BUILD_DEPS_AFTER = (
    "RUN_BUILD_DEPS = True\n"
    f'if os.getenv("{_SETUP_SKIP_BUILD_DEPS_MARKER}") == "1":\n'
    "    RUN_BUILD_DEPS = False\n"
    "# see if the user passed a quiet flag to setup.py arguments and respect"
)


def _ensure_setup_skip_build_deps_patch(pt_src: Path) -> None:
    """Wheel 阶段运行时注入 setup.py 补丁，不进入 04.patch（避免 patch hash 变化导致 cache miss）。"""
    setup_py = pt_src / "setup.py"
    content = setup_py.read_text(encoding="utf-8")
    if _SETUP_SKIP_BUILD_DEPS_MARKER in content:
        print(f"setup.py already has {_SETUP_SKIP_BUILD_DEPS_MARKER} hook", flush=True)
        return
    if _SETUP_SKIP_BUILD_DEPS_BEFORE not in content:
        raise SystemExit(
            "setup.py missing expected RUN_BUILD_DEPS anchor for wheel-only patch"
        )
    setup_py.write_text(
        content.replace(_SETUP_SKIP_BUILD_DEPS_BEFORE, _SETUP_SKIP_BUILD_DEPS_AFTER, 1),
        encoding="utf-8",
    )
    print(f"Patched setup.py for {_SETUP_SKIP_BUILD_DEPS_MARKER}", flush=True)


def _rank_libomp_candidate(path: Path) -> tuple[int, str]:
    """Prefer release OpenMP redist over debug_nonredist (TheRock #1520)."""
    lowered = str(path).lower()
    rank = 0
    if "debug" in lowered:
        rank += 10
    if "nonredist" in lowered:
        rank += 5
    return (rank, lowered)


def _find_libomp_dll() -> Path:
    if os.name != "nt":
        raise SystemExit(f"ERROR: {_LIBOMP_DLL} bundling is Windows-only")

    candidates: list[Path] = []
    vc_redist = os.environ.get("VCToolsRedistDir", "").strip()
    if vc_redist:
        root = Path(vc_redist)
        if root.is_dir():
            candidates.extend(p for p in root.rglob(_LIBOMP_DLL) if p.is_file())

    for root in (
        Path(r"C:\Program Files\Microsoft Visual Studio"),
        Path(r"C:\Program Files (x86)\Microsoft Visual Studio"),
    ):
        if root.is_dir():
            candidates.extend(p for p in root.rglob(_LIBOMP_DLL) if p.is_file())

    if not candidates:
        raise SystemExit(
            f"ERROR: {_LIBOMP_DLL} not found "
            "(MSVC OpenMP runtime; expect VCToolsRedistDir on CI)"
        )

    candidates.sort(key=_rank_libomp_candidate)
    return candidates[0]


def _ensure_libomp_in_torch_lib(pt_src: Path) -> None:
    """torch_cpu.dll 链接 libomp140；ROCm Windows 构建不会自动 install 该 DLL。"""
    if os.name != "nt":
        return

    dst_dir = pt_src / "torch" / "lib"
    dst = dst_dir / _LIBOMP_DLL
    src = _find_libomp_dll()
    dst_dir.mkdir(parents=True, exist_ok=True)

    if dst.exists() and dst.stat().st_size == src.stat().st_size:
        print(f"libomp already in torch/lib: {dst}", flush=True)
        return

    dst.write_bytes(src.read_bytes())
    print(f"Copied {_LIBOMP_DLL}: {src} -> {dst}", flush=True)


def _find_libuv_dll() -> Path | None:
    if os.name != "nt":
        return None

    libuv_root = os.environ.get("libuv_ROOT") or os.environ.get("LIBUV_ROOT")
    if libuv_root:
        candidate = Path(libuv_root) / "bin" / _LIBUV_DLL
        if candidate.is_file():
            return candidate

    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
    for p in path_dirs:
        if p.strip():
            candidate = Path(p.strip()) / _LIBUV_DLL
            if candidate.is_file():
                return candidate
    return None


def _ensure_libuv_in_torch_lib(pt_src: Path) -> None:
    """确保 uv.dll 存在于 torch/lib/（分布式 Gloo 传输所需）。"""
    if os.name != "nt":
        return

    dst_dir = pt_src / "torch" / "lib"
    dst = dst_dir / _LIBUV_DLL
    if dst.exists() and dst.stat().st_size > 0:
        print(f"libuv (uv.dll) already in torch/lib: {dst}", flush=True)
        return

    src = _find_libuv_dll()
    if not src:
        print(
            "Warning: uv.dll not found in libuv_ROOT/PATH to copy to torch/lib",
            flush=True,
        )
        return

    dst_dir.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    print(f"Copied {_LIBUV_DLL}: {src} -> {dst}", flush=True)


def _wheel_subprocess_env() -> dict[str, str]:
    """Wheel 阶段 setup.py 子进程：跳过 build_deps + UTF-8（aotriton.images 全角文件名）。"""
    env = os.environ.copy()
    env[_SETUP_SKIP_BUILD_DEPS_MARKER] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _exec_setup_py(
    pt_src: Path,
    command_argv: list[str],
    *,
    env: dict[str, str] | None = None,
) -> None:
    setup_py = pt_src / "setup.py"
    argv = [sys.executable, str(setup_py), *command_argv]
    print("Running:", " ".join(argv), flush=True)
    run_env = os.environ.copy() if env is None else env
    result = subprocess.run(argv, cwd=pt_src, check=False, env=run_env)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def _parse_ck_opt_dims() -> list[int]:
    raw = os.environ.get("CK_OPT_DIM", "").strip()
    dims = [int(part) for part in raw.split(",") if part.strip()]
    if not dims:
        raise SystemExit("CK_OPT_DIM is missing or empty")
    return dims


def _find_single_artifact(build_dir: Path, names: tuple[str, ...]) -> Path:
    matches: list[Path] = []
    for name in names:
        matches.extend(p for p in build_dir.rglob(name) if p.is_file())
    if len(matches) != 1:
        examples = ", ".join(str(p.relative_to(build_dir)) for p in matches[:5])
        raise SystemExit(
            f"Expected exactly one of {names!r} under {build_dir}, "
            f"found {len(matches)}"
            + (f" (e.g. {examples})" if examples else "")
        )
    return matches[0]


def _find_fmha_bwd_objs(build_dir: Path) -> list[Path]:
    return [
        p
        for p in build_dir.rglob("*.obj")
        if p.is_file() and "fmha_bwd" in p.name
    ]


def verify_ck_fmha_bwd_artifacts(pt_src: Path) -> None:
    """编译后校验 CK FMHA bwd 产物（对齐 FA：链接期对象 + 新鲜度，非 wheel 二进制扫符号）。"""
    build_dir = pt_src / "build"
    if not build_dir.is_dir():
        raise SystemExit(f"build directory missing: {build_dir}")

    ck_sdpa_lib = _find_single_artifact(build_dir, _CK_SDPA_LIB_NAMES)
    torch_hip = _find_single_artifact(build_dir, _TORCH_HIP_DLL_NAMES)
    for required in (_BWD_API_OBJ, _MHA_BWD_CK_OBJ):
        obj = _find_single_artifact(build_dir, (required,))
        print(
            f"OK CK FMHA bwd artifact {obj.relative_to(build_dir).as_posix()}",
            flush=True,
        )

    opt_dims = _parse_ck_opt_dims()
    bwd_objs = _find_fmha_bwd_objs(build_dir)
    for dim in opt_dims:
        token = f"fmha_bwd_d{dim}_"
        matches = [p for p in bwd_objs if token in p.name]
        if not matches:
            raise SystemExit(
                f"No fmha_bwd_d{dim}_ *.obj under {build_dir} "
                f"(CK_OPT_DIM={','.join(str(d) for d in opt_dims)})"
            )
        print(
            f"OK fmha_bwd_d{dim}_ obj count={len(matches)}",
            flush=True,
        )

    lib_mtime_ns = ck_sdpa_lib.stat().st_mtime_ns
    stale_vs_lib = [
        p for p in bwd_objs if p.stat().st_mtime_ns > lib_mtime_ns
    ]
    if stale_vs_lib:
        examples = ", ".join(
            p.relative_to(build_dir).as_posix() for p in stale_vs_lib[:5]
        )
        raise SystemExit(
            f"{ck_sdpa_lib.relative_to(build_dir).as_posix()} is older than "
            f"{len(stale_vs_lib)} fmha_bwd object(s); ck_sdpa.lib must be "
            f"re-linked after bwd blobs (e.g. {examples})"
        )

    hip_mtime_ns = torch_hip.stat().st_mtime_ns
    if hip_mtime_ns < lib_mtime_ns:
        raise SystemExit(
            f"{torch_hip.relative_to(build_dir).as_posix()} is older than "
            f"{ck_sdpa_lib.relative_to(build_dir).as_posix()}; torch_hip "
            "must be re-linked after ck_sdpa.lib"
        )

    print(
        f"OK ck_sdpa.lib fresh vs {len(bwd_objs)} fmha_bwd obj(s); "
        f"torch_hip fresh vs ck_sdpa.lib",
        flush=True,
    )


def build_only(pt_src: Path, *, verbose: bool = False) -> None:
    argv = ["build"]
    if verbose:
        argv.append("-v")
    _exec_setup_py(pt_src, argv)
    verify_ck_fmha_bwd_artifacts(pt_src)


def build_wheel(pt_src: Path, *, verbose: bool = False) -> None:
    # compile（watchdog/run spawn）已完成 ninja/cmake install（产物在 PT 源码树 torch/）。
    # setup.py 默认在 bdist_wheel 前会 build_deps() -> cmake --build install，
    # 与 compile 的 ninja -C 路径重复且可能触发 CMake reconfigure。
    # 运行时 patch setup.py 使 PYTORCH_CK_SKIP_BUILD_DEPS=1 时跳过 build_deps；
    # build 仅同步 torch/ -> build/lib；bdist_wheel --skip-build 只打包。
    verify_ck_fmha_bwd_artifacts(pt_src)
    _ensure_setup_skip_build_deps_patch(pt_src)
    _ensure_libomp_in_torch_lib(pt_src)
    _ensure_libuv_in_torch_lib(pt_src)

    wheel_env = _wheel_subprocess_env()

    sync_argv = ["build"]
    if verbose:
        sync_argv.append("-v")
    _exec_setup_py(pt_src, sync_argv, env=wheel_env)

    wheel_argv = ["bdist_wheel", "--skip-build"]
    if verbose:
        wheel_argv.insert(0, "-v")
    _exec_setup_py(pt_src, wheel_argv, env=wheel_env)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--step",
        choices=["build", "verify-build", "wheel"],
        required=True,
        help="build：setup.py build + CK FMHA bwd 产物校验；verify-build：仅校验；"
        "wheel：校验 + build 同步 + bdist_wheel --skip-build",
    )
    parser.add_argument("--pt-src", type=Path, required=True)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if not args.pt_src.is_dir():
        raise SystemExit(f"PyTorch source missing: {args.pt_src}")

    if args.step == "build":
        build_only(args.pt_src, verbose=args.verbose)
        return

    if args.step == "verify-build":
        verify_ck_fmha_bwd_artifacts(args.pt_src)
        return

    build_wheel(args.pt_src, verbose=args.verbose)


if __name__ == "__main__":
    main()
