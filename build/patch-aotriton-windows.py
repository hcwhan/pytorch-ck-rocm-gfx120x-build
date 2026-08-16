"""AOTriton ExternalProject 补丁：clang-cl UTF-8 编译参数与 enum dllexport 警告。"""
from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path

PatchFn = Callable[[Path], bool]


def _replace_once(path: Path, before: str, after: str, *, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if before not in text:
        if after in text:
            print(f"skip {label}: already patched ({path.name})", flush=True)
            return False
        raise SystemExit(f"{label}: expected snippet missing in {path}")
    path.write_text(text.replace(before, after, 1), encoding="utf-8")
    print(f"patched {label}: {path.name}", flush=True)
    return True


def _patch_cmake_lists(root: Path) -> bool:
    before = (
        'set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -finput-charset=UTF-8")\n'
        'set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -finput-charset=UTF-8")\n'
        'message(STATUS "[AOTriton] UTF-8 input character is set for all C/C++ source files.")'
    )
    after = (
        'set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} /utf-8 /Zc:preprocessor")\n'
        'set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} /utf-8 /Zc:preprocessor")\n'
        'message(STATUS "[AOTriton] clang-cl: /utf-8 and /Zc:preprocessor set for all C/C++ source files.")'
    )
    return _replace_once(root / "CMakeLists.txt", before, after, label="charset")


def _patch_config_h_in(root: Path) -> bool:
    before = """#ifdef _MSC_VER
#define AOTRITON_API __declspec(dllexport)
#else
#define AOTRITON_API __attribute__ ((visibility ("default")))
#endif"""
    after = """#ifdef _MSC_VER
#define AOTRITON_API __declspec(dllexport)
#define AOTRITON_ENUM_API
#else
#define AOTRITON_API __attribute__ ((visibility ("default")))
#define AOTRITON_ENUM_API AOTRITON_API
#endif"""
    return _replace_once(
        root / "include/aotriton/config.h.in",
        before,
        after,
        label="config.h.in",
    )


def _patch_enum_api(root: Path, rel: str, before: str, after: str) -> bool:
    return _replace_once(root / rel, before, after, label=rel)


def main() -> None:
    if len(sys.argv) > 2:
        raise SystemExit(f"usage: {sys.argv[0]} [aotriton-source-root]")
    root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path.cwd()
    if not root.is_dir():
        raise SystemExit(f"aotriton source missing: {root}")

    patches: list[PatchFn] = [
        _patch_cmake_lists,
        _patch_config_h_in,
        lambda r: _patch_enum_api(
            r,
            "include/aotriton/dtypes.h",
            "enum AOTRITON_API DType",
            "enum AOTRITON_ENUM_API DType",
        ),
        lambda r: _patch_enum_api(
            r,
            "include/aotriton/util.h",
            "enum AOTRITON_API GpuVendor",
            "enum AOTRITON_ENUM_API GpuVendor",
        ),
        lambda r: _patch_enum_api(
            r,
            "include/aotriton/util.h",
            "enum AOTRITON_API Gpu",
            "enum AOTRITON_ENUM_API Gpu",
        ),
        lambda r: _patch_enum_api(
            r,
            "include/aotriton/v2/cpp_tune.h",
            'enum [[deprecated("V2 API is deprecated, use V3 API instead")]] AOTRITON_API CppTuneSpecialKernelIndex',
            'enum [[deprecated("V2 API is deprecated, use V3 API instead")]] AOTRITON_ENUM_API CppTuneSpecialKernelIndex',
        ),
    ]

    applied = sum(int(fn(root)) for fn in patches)
    print(f"AOTriton Windows patch complete ({applied} file updates)", flush=True)


if __name__ == "__main__":
    main()
