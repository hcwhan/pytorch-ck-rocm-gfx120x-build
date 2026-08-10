#!/usr/bin/env python3
"""Deploy-time GPU smoke test for torch CK SDPA (gfx1201 hardware; not run in CI)."""
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


def main() -> None:
    parser = argparse.ArgumentParser(description="GPU smoke test for torch CK SDPA wheel")
    parser.add_argument(
        "-w",
        "--workspace-root",
        required=True,
        help="Repo root containing VERSION.lock.json",
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

    expected_arch = gpu_archs.strip().lower()
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

    if expected_arch not in arch:
        raise SystemExit(
            f"ERROR: expected {expected_arch!r} not found in gcnArchName {arch!r}"
        )

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
