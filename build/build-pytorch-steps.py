"""Build PyTorch via in-process setuptools (build / wheel)."""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path


def _exec_setup_py(pt_src: Path, command_argv: list[str]) -> None:
    os.chdir(pt_src)
    setup_py = pt_src / "setup.py"
    sys.argv = [str(setup_py), *command_argv]
    print("Running:", " ".join(sys.argv), flush=True)

    spec = importlib.util.spec_from_file_location("pytorch_setup", setup_py)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Failed to load {setup_py}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--step",
        choices=["build", "wheel"],
        required=True,
        help="build: setup.py build; wheel: setup.py bdist_wheel",
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
