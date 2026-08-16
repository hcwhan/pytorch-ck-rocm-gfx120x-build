"""通过 subprocess 调用 setuptools 构建 PyTorch（build / wheel）。"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

_SETUP_SKIP_BUILD_DEPS_MARKER = "PYTORCH_CK_SKIP_BUILD_DEPS"
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


def build_only(pt_src: Path, *, verbose: bool = False) -> None:
    argv = ["build"]
    if verbose:
        argv.append("-v")
    _exec_setup_py(pt_src, argv)


def build_wheel(pt_src: Path, *, verbose: bool = False) -> None:
    # 08.build 已完成 ninja/cmake install（产物在 PT 源码树 torch/）。
    # setup.py 默认在 bdist_wheel 前会 build_deps() -> cmake --build install，
    # 与 08.build 的 ninja -C 路径重复且可能触发 CMake reconfigure。
    # 运行时 patch setup.py 使 PYTORCH_CK_SKIP_BUILD_DEPS=1 时跳过 build_deps；
    # build 仅同步 torch/ -> build/lib；bdist_wheel --skip-build 只打包。
    _ensure_setup_skip_build_deps_patch(pt_src)

    wheel_env = os.environ.copy()
    wheel_env[_SETUP_SKIP_BUILD_DEPS_MARKER] = "1"

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
        choices=["build", "wheel"],
        required=True,
        help="build：setup.py build；wheel：build 同步 + bdist_wheel --skip-build",
    )
    parser.add_argument("--pt-src", type=Path, required=True)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if not args.pt_src.is_dir():
        raise SystemExit(f"PyTorch source missing: {args.pt_src}")

    if args.step == "build":
        build_only(args.pt_src, verbose=args.verbose)
        return

    build_wheel(args.pt_src, verbose=args.verbose)


if __name__ == "__main__":
    main()
