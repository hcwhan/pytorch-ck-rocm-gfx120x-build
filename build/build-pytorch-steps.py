"""通过 subprocess 调用 setuptools 构建 PyTorch（build / wheel / ninja-install）。"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _exec_setup_py(pt_src: Path, command_argv: list[str]) -> None:
    setup_py = pt_src / "setup.py"
    argv = [sys.executable, str(setup_py), *command_argv]
    print("Running:", " ".join(argv), flush=True)
    result = subprocess.run(argv, cwd=pt_src, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def build_only(pt_src: Path, *, verbose: bool = False) -> None:
    argv = ["build"]
    if verbose:
        argv.append("-v")
    _exec_setup_py(pt_src, argv)


def build_wheel(pt_src: Path, *, verbose: bool = False) -> None:
    argv = ["bdist_wheel"]
    if verbose:
        argv.insert(0, "-v")
    _exec_setup_py(pt_src, argv)


def ninja_install(pt_src: Path, *, jobs: int, verbose: bool = False) -> None:
    build_dir = pt_src / "build"
    ninja_file = build_dir / "build.ninja"
    if not ninja_file.is_file():
        raise SystemExit(f"build.ninja missing for ninja-install: {ninja_file}")
    argv = ["ninja", "-C", str(build_dir), "install", f"-j{jobs}"]
    if verbose:
        argv.append("-v")
    print("Running:", " ".join(argv), flush=True)
    result = subprocess.run(argv, cwd=pt_src, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--step",
        choices=["build", "wheel", "ninja-install"],
        required=True,
        help="build：setup.py build；wheel：setup.py bdist_wheel；ninja-install：ninja -C build install",
    )
    parser.add_argument("--pt-src", type=Path, required=True)
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=0,
        help="ninja-install 并行 worker 数（默认读 MAX_JOBS env）",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if not args.pt_src.is_dir():
        raise SystemExit(f"PyTorch source missing: {args.pt_src}")

    if args.step == "build":
        build_only(args.pt_src, verbose=args.verbose)
        return

    if args.step == "wheel":
        build_wheel(args.pt_src, verbose=args.verbose)
        return

    jobs = args.jobs
    if jobs < 1:
        import os

        raw = os.environ.get("MAX_JOBS", "").strip()
        if not raw:
            raise SystemExit("ninja-install: set -j or MAX_JOBS env")
        jobs = int(raw)
        if jobs < 1:
            raise SystemExit(f"ninja-install: invalid MAX_JOBS={raw!r}")

    ninja_install(args.pt_src, jobs=jobs, verbose=args.verbose)


if __name__ == "__main__":
    main()
