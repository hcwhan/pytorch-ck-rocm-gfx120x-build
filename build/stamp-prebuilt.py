#!/usr/bin/env python3
"""Stamp prebuilt .obj files and .ninja_log entries with a unified future mtime.

Ported from flash-attn's build-fa-steps.py stamp_prebuilt_objects.

Windows HIP (PyTorch CMake + clang-cl) builds have no deps=gcc/deps=msvc
rules (no .ninja_deps).  Ninja's dirty check therefore requires BOTH:
  1. obj.mtime >= most_recent_input mtime
  2. .ninja_log entry exists, command hash matches, and entry.mtime >= most_recent_input mtime

Cache round-trip (tar --posix save -> extract) truncates sub-second mtime
precision and can shift .obj mtime relative to .ninja_log entry mtime.
Stamping both with the same future nanosecond value satisfies both checks
simultaneously, enabling true incremental resume instead of mass recompile.
"""
from __future__ import annotations

import argparse
import os
import re
import time
from pathlib import Path

_LOG_HEADER_RE = re.compile(r"^# ninja log v(\d+)$")


def compute_stamp() -> int:
    """Single stamp value (integer nanoseconds) strictly greater than any file mtime.

    time.time_ns() is the current wall clock -- always >= any file's mtime on
    the same machine.  Adding 1 s (1_000_000_000 ns) ensures strict inequality.
    Using int nanoseconds makes os.utime(ns=...) and .ninja_log recording
    bit-exact consistent (float-second stamps drift enough to trigger dirty).
    """
    return time.time_ns() + 1_000_000_000


def rewrite_ninja_log(log_path: Path, stamp: int) -> int:
    """Rewrite .ninja_log entry mtimes to a single stamp value.

    Preserves header version and command hashes.  Deduplicates by output path
    (last entry wins, matching ninja's loader behavior).  Returns the number
    of entries rewritten, or 0 if the log is missing or has no header.
    """
    if not log_path.is_file():
        print(f"No .ninja_log found at {log_path}", flush=True)
        return 0

    version = 0
    by_output: dict[str, str] = {}

    with open(log_path, "r", encoding="utf-8", newline="") as fh:
        lines = fh.read().splitlines()

    for line in lines:
        if not line:
            continue
        m = _LOG_HEADER_RE.match(line)
        if m:
            version = int(m.group(1))
            continue
        fields = line.split("\t")
        if len(fields) < 4:
            continue
        # Rewrite mtime field (fields[2]) to the unified stamp.
        # v7+ (ninja >= 1.13) uses nanoseconds; v5/v6 use seconds.
        fields[2] = str(stamp) if version >= 7 else str(stamp // 1_000_000_000)
        by_output[fields[3]] = "\t".join(fields)

    if not version:
        print(f"No ninja log header found in {log_path}", flush=True)
        return 0

    with open(log_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f"# ninja log v{version}\n")
        for line in by_output.values():
            fh.write(line + "\n")

    return len(by_output)


def stamp_prebuilt_objects(build_dir: Path) -> tuple[int, int]:
    """Stamp all .obj files and .ninja_log entries with a unified future mtime.

    Returns (obj_count, log_entries).
    """
    if not build_dir.is_dir():
        print(f"Build directory not found: {build_dir}", flush=True)
        return 0, 0

    stamp = compute_stamp()

    # Stamp all .obj files with the same future mtime.
    obj_count = 0
    for obj in build_dir.rglob("*.obj"):
        os.utime(obj, ns=(stamp, stamp))
        obj_count += 1

    # Rewrite .ninja_log entry mtimes to the same stamp.
    log_path = build_dir / ".ninja_log"
    log_entries = rewrite_ninja_log(log_path, stamp)

    print(
        f"Stamped {obj_count} prebuilt .obj files with mtime {stamp / 1e9:.3f} "
        f"in {build_dir} ({log_entries} .ninja_log entries)",
        flush=True,
    )
    return obj_count, log_entries


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stamp prebuilt .obj and .ninja_log for ninja cache resume"
    )
    parser.add_argument("--pt-src", type=Path, required=True, help="PyTorch source root")
    args = parser.parse_args()

    if not args.pt_src.is_dir():
        raise SystemExit(f"PyTorch source missing: {args.pt_src}")

    build_dir = args.pt_src / "build"
    obj_count, log_entries = stamp_prebuilt_objects(build_dir)

    if obj_count == 0:
        print("No prebuilt .obj files found - cold build, nothing to stamp", flush=True)
    else:
        print(
            f"Stamp complete: {obj_count} objects, {log_entries} log entries",
            flush=True,
        )


if __name__ == "__main__":
    main()
