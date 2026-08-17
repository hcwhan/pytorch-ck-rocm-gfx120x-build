#!/usr/bin/env python3
"""部署前 torch CK SDPA GPU 冒烟测试（gfx120x 真机；需已 pip install wheel；CI 不运行；不替代 10.verify）。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch
from torch.nn.attention import SDPBackend, sdpa_kernel


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


def enable_ck_preference() -> None:
    os.environ["TORCH_ROCM_FA_PREFER_CK"] = "1"
    if hasattr(torch.backends.cuda, "preferred_rocm_fa_library"):
        torch.backends.cuda.preferred_rocm_fa_library("ck")


def probe_ck_sdpa_fwd(
    device: torch.device,
    batch: int,
    seqlen: int,
    nheads: int,
    headdim: int,
) -> torch.Tensor:
    q = torch.randn(
        batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
    )
    k = torch.randn(
        batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
    )
    v = torch.randn(
        batch, nheads, seqlen, headdim, device=device, dtype=torch.float16
    )
    try:
        with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
            out = torch.nn.functional.scaled_dot_product_attention(
                q, k, v, is_causal=True
            )
        torch.cuda.synchronize()
    except RuntimeError as exc:
        torch.cuda.synchronize()
        raise SystemExit(
            "ERROR: headdim="
            f"{headdim} CK SDPA forward failed under FLASH_ATTENTION-only "
            f"(TORCH_ROCM_FA_PREFER_CK=1): {exc}"
        ) from exc
    return out


def probe_ck_sdpa_bwd(
    device: torch.device,
    batch: int,
    seqlen: int,
    nheads: int,
    headdim: int,
) -> None:
    q = torch.randn(
        batch,
        nheads,
        seqlen,
        headdim,
        device=device,
        dtype=torch.float16,
        requires_grad=True,
    )
    k = torch.randn(
        batch,
        nheads,
        seqlen,
        headdim,
        device=device,
        dtype=torch.float16,
        requires_grad=True,
    )
    v = torch.randn(
        batch,
        nheads,
        seqlen,
        headdim,
        device=device,
        dtype=torch.float16,
        requires_grad=True,
    )
    try:
        with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
            out = torch.nn.functional.scaled_dot_product_attention(
                q, k, v, is_causal=True
            )
            out.sum().backward()
        torch.cuda.synchronize()
    except RuntimeError as exc:
        torch.cuda.synchronize()
        raise SystemExit(
            "ERROR: headdim="
            f"{headdim} CK SDPA backward failed under FLASH_ATTENTION-only "
            f"(TORCH_ROCM_FA_PREFER_CK=1): {exc}"
        ) from exc

    if q.grad is None or k.grad is None or v.grad is None:
        raise SystemExit(
            f"ERROR: headdim={headdim} backward produced no gradients for q/k/v"
        )
    for name, grad in (("q", q.grad), ("k", k.grad), ("v", v.grad)):
        if not torch.isfinite(grad).all():
            raise SystemExit(
                f"ERROR: headdim={headdim} {name}.grad has non-finite values"
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="已安装 torch wheel 的 GPU CK SDPA fwd/bwd 冒烟测试（需先 pip install wheel）",
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

    enable_ck_preference()

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
        out = probe_ck_sdpa_fwd(device, batch, seqlen, nheads, headdim)
        expected_shape = (batch, nheads, seqlen, headdim)
        if out.shape != expected_shape:
            raise SystemExit(
                f"ERROR: headdim={headdim} unexpected output shape {out.shape}"
            )
        if not torch.isfinite(out).all():
            raise SystemExit(
                f"ERROR: headdim={headdim} output has non-finite values"
            )
        print(
            "GPU CK SDPA forward OK headdim="
            f"{headdim} shape={tuple(out.shape)} backend=FLASH_ATTENTION"
        )

    for headdim in head_dims:
        probe_ck_sdpa_bwd(device, batch, seqlen, nheads, headdim)
        print(
            "GPU CK SDPA backward OK headdim="
            f"{headdim} backend=FLASH_ATTENTION"
        )

    print("GPU smoke test complete")


if __name__ == "__main__":
    main()
