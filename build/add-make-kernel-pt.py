"""在 CK FMHA 生成 blob 中将 make_kernel 替换为 make_kernel_pt（跨平台）。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_FWD_INCLUDE = '#include "fmha_fwd.hpp"'
_BWD_INCLUDE = '#include "fmha_bwd.hpp"'
_LAUNCH_INCLUDE = '#include "launch_kernel_pt.hpp"'


def _patch_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    text = text.replace("make_kernel", "make_kernel_pt")
    text = text.replace(_FWD_INCLUDE, f"{_FWD_INCLUDE}\n{_LAUNCH_INCLUDE}")
    text = text.replace(_BWD_INCLUDE, f"{_BWD_INCLUDE}\n{_LAUNCH_INCLUDE}")
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="为 PyTorch launch_kernel_pt 分发补丁 CK FMHA blob 源码。",
    )
    parser.add_argument("blob_list", type=Path, help="CK codegen 输出的 blob 列表文件路径")
    args = parser.parse_args()

    blob_list = args.blob_list.resolve()
    if not blob_list.is_file():
        print(f"Error: File '{blob_list}' not found!", file=sys.stderr)
        raise SystemExit(1)

    ck_dir = blob_list.parent
    updated = 0

    for line in blob_list.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if not entry:
            continue

        target = ck_dir / Path(entry).name
        if target.is_file():
            _patch_file(target)
            print(f"Updated: {target.name}")
            updated += 1
        else:
            print(f"Skipping: {target.name} (not found in {ck_dir})")

    print("Replacement completed.")
    if updated == 0:
        print("Error: no blob files were updated.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
