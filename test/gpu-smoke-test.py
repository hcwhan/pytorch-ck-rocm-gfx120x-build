#!/usr/bin/env python3
"""部署前 torch CK SDPA GPU 冒烟测试（gfx120x 真机；需已 pip install wheel；CI 不运行；不替代 10.verify）。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch


def load_lock(workspace_root: Path) -> dict:
    lock_path = workspace_root / "VERSION.lock.json"
    with lock_path.open(encoding="utf-8") as handle:
        return json.load(handle)


def parse_ck_opt_dims(ck_opt_dim: str) -> list[int]:
    dims = [int(part.strip()) for part in ck_opt_dim.split(",") if part.strip()]
    if not dims:
        raise SystemExit("VERSION.lock.json compile.ck_opt_dim is missing or empty")
    return dims


def parse_gpu_archs(gpu_archs: str) -> list[str]:
    parts = [
        part.strip().lower()
        for part in gpu_archs.replace(",", ";").split(";")
        if part.strip()
    ]
    if not parts:
        raise SystemExit("VERSION.lock.json compile.gpu_archs is missing or empty")
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(
        description="已安装 torch wheel 的 GPU CK SDPA 前向冒烟测试（需先 pip install wheel）",
    )
    parser.add_argument(
        "-w",
        "--workspace-root",
        required=True,
        help="包含 VERSION.lock.json 的仓库根目录",
    )
    args = parser.parse_args()

    lock = load_lock(Path(args.workspace_root).resolve())
    compile_lock = lock.get("compile")
    if not isinstance(compile_lock, dict):
        raise SystemExit("VERSION.lock.json compile section is missing")

    gpu_archs = compile_lock.get("gpu_archs")
    ck_opt_dim = compile_lock.get("ck_opt_dim")
    if not isinstance(gpu_archs, str) or not gpu_archs.strip():
        raise SystemExit("VERSION.lock.json compile.gpu_archs is missing")
    if not isinstance(ck_opt_dim, str) or not ck_opt_dim.strip():
        raise SystemExit("VERSION.lock.json compile.ck_opt_dim is missing")

    expected_archs = parse_gpu_archs(gpu_archs)
    head_dims = parse_ck_opt_dims(ck_opt_dim)

    print(f"GPU smoke test on {gpu_archs} (requires ROCm PyTorch + GPU)")
    print(f"CK OPT_DIM tiers: {', '.join(str(dim) for dim in head_dims)}")

    if not torch.cuda.is_available():
        raise SystemExit("ERROR: torch.cuda.is_available() is False; need ROCm GPU")

    if not torch.backends.cuda.is_ck_sdpa_available():
        raise SystemExit("ERROR: torch.backends.cuda.is_ck_sdpa_available() is False")

    os.environ["TORCH_ROCM_FA_PREFER_CK"] = "1"
    if hasattr(torch.backends.cuda, "preferred_rocm_fa_library"):
        torch.backends.cuda.preferred_rocm_fa_library("ck")

    device = torch.device("cuda")
    props = torch.cuda.get_device_properties(0)
    arch = (getattr(props, "gcnArchName", None) or "").lower()
    print(f"GPU: {props.name} (gcnArchName={arch or 'unknown'})")

    if not any(expected in arch for expected in expected_archs):
        raise SystemExit(
            "ERROR: gcnArchName "
            f"{arch!r} does not match lock compile.gpu_archs {expected_archs!r}"
        )
    matched = next(expected for expected in expected_archs if expected in arch)
    print(f"OK GPU arch matches lock entry {matched!r}")

    batch, seqlen, nheads = 1, 64, 4
    for headdim in head_dims:
        q = torch.randn(
            batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
        )
        k = torch.randn(
            batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
        )
        v = torch.randn(
            batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
        )
        out = torch.nn.functional.scaled_dot_product_attention(
            q, k, v, is_causal=True
        )
        if out.shape != q.shape:
            raise SystemExit(
                f"ERROR: headdim={headdim} unexpected output shape {out.shape}"
            )
        if not torch.isfinite(out).all():
            raise SystemExit(
                f"ERROR: headdim={headdim} output has non-finite values"
            )
        torch.cuda.synchronize()
        print(f"GPU CK SDPA OK headdim={headdim} shape={tuple(out.shape)}")

    print("GPU smoke test complete")


if __name__ == "__main__":
    main()
