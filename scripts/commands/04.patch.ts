import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatGpuArchCmakeList,
  formatGpuArchCppDefines,
  formatGpuArchCppStrings,
  gpuArchListIncludesMi3xxForFavV3,
  parseGpuArchList,
} from "../lib/gpu-archs.js";
import { requireLockEnv } from "../lib/require-env.js";

/**
 * PyTorch CK SDPA gfx120x 程序化补丁。
 *
 * 合入状态以 VERSION.lock `pytorch.build_commit`（当前 v2.13.0）为准，非 main HEAD。
 *
 * PR 备注格式：
 * - `pytorch/pytorch#NNNN` — 上游 PR 或与其等价的改动
 * - `local` — 本仓库 Windows/gfx120x 构建补丁（上游未合并或需额外适配）
 *
 * 上游 PR 索引：
 * - #143695 — 已合入 v2.13.0：CK SDPA 后端（mha_*_ck.hip、add_make_kernel_pt.sh）
 * - #144777 — 已合入 v2.13.0：kentry_pt 架构 guard 移至 launch_kernel_pt.hpp
 * - #155103 — 已合入 v2.13.0：launch_kernel_pt.hpp 增加 gfx950
 * - #157964 — 已合入 v2.13.0：CK FMHA codegen recipe（仍用 python3/bash）
 * - #178310 — 已合入 v2.13.0：USE_FLASH_ATTENTION 路径默认启用 CK SDPA
 * - #182733 — 已合入 v2.13.0：Windows 禁用 CK SDPA（NOT WIN32；本仓库 patch 撤销）
 * - #183962 — 已合入 v2.13.0：aten CMake 中 Windows 不自动 USE_ROCM_CK_SDPA=ON
 * - #187267 — 已合 main，未进 v2.13.0：ckSDPASupported() 从 ckSupported() 拆分
 * - #188114 — 未合（OPEN）：gfx1200/gfx1201 RDNA4 支持（本仓库 patch 提前应用）
 */
type PatchPoint = {
  name: string;
  before: string | string[];
  after: string | string[];
  replaceAll?: boolean;
};

/** 从多组 before/after 备选中解析与当前文件内容匹配的一组。 */
function resolvePatchVariant(
  content: string,
  point: PatchPoint,
): { before: string; after: string } {
  if (typeof point.before === "string") {
    if (typeof point.after !== "string") {
      throw new Error(
        `patch: '${point.name}' single before requires a single after`,
      );
    }
    return { before: point.before, after: point.after };
  }

  const afters =
    typeof point.after === "string"
      ? point.before.map(() => point.after as string)
      : Array.isArray(point.after)
        ? point.after
        : [point.after];
  if (point.before.length !== afters.length) {
    throw new Error(
      `patch: '${point.name}' before/after alternative count mismatch`,
    );
  }

  for (let i = 0; i < point.before.length; i++) {
    const before = point.before[i]!;
    if (content.includes(before)) {
      return { before, after: afters[i]! };
    }
  }

  throw new Error(
    `patch: before-state not found for '${point.name}' (${point.before.length} alternatives)`,
  );
}

/** 读取文件并统一为 LF，同时记录原始 EOL 以便写回。 */
function readNormalized(filePath: string): { content: string; eol: "\n" | "\r\n" } {
  const raw = readFileSync(filePath, "utf8");
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  return { content: raw.replace(/\r\n/g, "\n"), eol };
}

/** 按原始 EOL 写回文件。 */
function writeNormalized(
  filePath: string,
  content: string,
  eol: "\n" | "\r\n",
): void {
  const out = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
  writeFileSync(filePath, out, "utf8");
}

/** 对单文件依次校验 before-state 并应用全部 patch 点。 */
function applyPoints(filePath: string, points: PatchPoint[]): void {
  let { content, eol } = readNormalized(filePath);
  const resolved = points.map((point) => ({
    point,
    variant: resolvePatchVariant(content, point),
  }));

  for (const { point, variant } of resolved) {
    const count = point.replaceAll
      ? content.split(variant.before).length - 1
      : content.includes(variant.before)
        ? 1
        : 0;
    if (count < 1) {
      throw new Error(`patch: before-state not found for '${point.name}' in ${filePath}`);
    }
    console.log(`  OK ${point.name}: before-state found (${count})`);
  }

  for (const { point, variant } of resolved) {
    content = point.replaceAll
      ? content.replaceAll(variant.before, variant.after)
      : content.replace(variant.before, variant.after);
    console.log(`  OK ${point.name}: patched`);
  }

  writeNormalized(filePath, content, eol);
}

/**
 * CK FMHA 子目录 `flash_attn/ck/CMakeLists.txt` 的 patch 点。
 *
 * 基于 v2.13.0 上游 #143695/#157964 的 codegen 流程，补充 Windows 适配（Python3_EXECUTABLE、
 * 独立 RESULT_VARIABLE）与 #188114 的 `--targets gfx12`（由 lock CK_TARGETS 参数化）。
 * 完整编译 fwd 与 bwd codegen。
 */
function buildCkCmakePoints(ckTargets: string, ckOptDim: string): PatchPoint[] {
  return [
    // local：Windows 无 python3 命令；上游 #143695/#157964 CK FMHA CMake 假定 Linux python3
    {
      name: "ck-fmha-generate-python3-executable",
      before: `set(CK_FMHA_GENERATE python3 \${CMAKE_CURRENT_LIST_DIR}/generate_compat.py
    \${CMAKE_SOURCE_DIR}/third_party/composable_kernel/example/ck_tile/01_fmha/generate.py)`,
      after: `set(CK_FMHA_GENERATE \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/generate_compat.py
    \${CMAKE_SOURCE_DIR}/third_party/composable_kernel/example/ck_tile/01_fmha/generate.py)`,
    },
    // pytorch/pytorch#188114 + local：codegen 传入 --targets gfx12（由 lock CK_TARGETS 参数化）
    {
      name: "ck-codegen-list-optdim",
      before: `COMMAND \${CK_FMHA_GENERATE} --optdim=${ckOptDim}`,
      after: `COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --optdim=${ckOptDim}`,
      replaceAll: true,
    },
    // pytorch/pytorch#188114 + local：bwd list_blobs 传入 --targets，独立 RESULT_VARIABLE
    {
      name: "ck-codegen-list-bwd-result",
      before: `execute_process(
  COMMAND \${CK_FMHA_GENERATE}
  --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --list_blobs \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt
  RESULT_VARIABLE ret
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate a list of BWD kernels via Python.")
endif()`,
      after: `execute_process(
  COMMAND \${CK_FMHA_GENERATE} ${ckTargets}
  --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --list_blobs \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt
  RESULT_VARIABLE ck_fmha_list_bwd_ret
)

if(ck_fmha_list_bwd_ret AND NOT ck_fmha_list_bwd_ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate a list of BWD kernels via Python.")
endif()`,
    },
    // local：各 emit 步骤独立 RESULT_VARIABLE；上游共用 ret 在 Windows 易掩盖失败
    {
      name: "ck-codegen-emit-fwd-result",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api fwd  --optdim=${ckOptDim} --receipt 4 --filter "*_lse*ntrload*nsink*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD kernels.")
endif()`,
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api fwd  --optdim=${ckOptDim} --receipt 4 --filter "*_lse*ntrload*nsink*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
 RESULT_VARIABLE ck_fmha_emit_fwd_ret
)

if(ck_fmha_emit_fwd_ret AND NOT ck_fmha_emit_fwd_ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD kernels.")
endif()`,
    },
    // local：同上（fwd_splitkv emit）
    {
      name: "ck-codegen-emit-fwd-splitkv-result",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api fwd_splitkv --optdim=${ckOptDim} --receipt 4 --filter "*psdv*_lse*_nsquant*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
)

if(ret AND NOT ret EQUAL 0)
    message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD_SPLITKV kernels.")
endif()`,
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api fwd_splitkv --optdim=${ckOptDim} --receipt 4 --filter "*psdv*_lse*_nsquant*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
 RESULT_VARIABLE ck_fmha_emit_fwd_splitkv_ret
)

if(ck_fmha_emit_fwd_splitkv_ret AND NOT ck_fmha_emit_fwd_splitkv_ret EQUAL 0)
    message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD_SPLITKV kernels.")
endif()`,
    },
    // local：同上（fwd_appendkv emit）
    {
      name: "ck-codegen-emit-fwd-appendkv-result",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api fwd_appendkv --optdim=${ckOptDim} --receipt 4 --filter "*psskddv_*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
)

if(ret AND NOT ret EQUAL 0)
    message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD_APPENDKV kernels.")
endif()`,
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api fwd_appendkv --optdim=${ckOptDim} --receipt 4 --filter "*psskddv_*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
 RESULT_VARIABLE ck_fmha_emit_fwd_appendkv_ret
)

if(ck_fmha_emit_fwd_appendkv_ret AND NOT ck_fmha_emit_fwd_appendkv_ret EQUAL 0)
    message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD_APPENDKV kernels.")
endif()`,
    },
    // local：bwd emit 独立 RESULT_VARIABLE
    {
      name: "ck-codegen-emit-bwd-result",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
  RESULT_VARIABLE ret
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate BWD kernels.")
endif()`,
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
  RESULT_VARIABLE ck_fmha_emit_bwd_ret
)

if(ck_fmha_emit_bwd_ret AND NOT ck_fmha_emit_bwd_ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate BWD kernels.")
endif()`,
    },
    // local：Windows 无 bash；替代上游 #143695 add_make_kernel_pt.sh
    {
      name: "ck-make-kernel-pt-fwd-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    // local：同上（fwd_splitkv blob list）
    {
      name: "ck-make-kernel-pt-fwd-splitkv-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_splitkv_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_splitkv_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    // local：同上（fwd_appendkv blob list）
    {
      name: "ck-make-kernel-pt-fwd-appendkv-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_appendkv_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_appendkv_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    // local：bwd blob list 用 Python 替代 #143695 add_make_kernel_pt.sh
    {
      name: "ck-make-kernel-pt-bwd-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    // local：Windows 无 bash mv；上游 #143695 用 bash 将 .cpp 重命名为 .hip
    {
      name: "ck-rename-cpp-to-hip-cmake",
      before: `# Change file extensions to .hip
execute_process(COMMAND bash -c "for file in \${CMAKE_CURRENT_LIST_DIR}/*.cpp; do mv -- \\"$file\\" \\"\\$\{file%.cpp}.hip\\"; done"
  RESULT_VARIABLE ret
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to change the generated instances extensions from .cpp to .hpp")
endif()`,
      after: `# Change file extensions to .hip
file(GLOB _ck_fmha_cpp_files "\${CMAKE_CURRENT_LIST_DIR}/*.cpp")
foreach(_ck_fmha_cpp \${_ck_fmha_cpp_files})
  get_filename_component(_ck_fmha_base \${_ck_fmha_cpp} NAME_WE)
  file(RENAME \${_ck_fmha_cpp} "\${CMAKE_CURRENT_LIST_DIR}/\${_ck_fmha_base}.hip")
endforeach()`,
    },
  ];
}

/**
 * lock `GPU_ARCHS` 不含 MI3xx（gfx942/gfx950）时跳过 fav_v3 与 AITER embedded HSA。
 * CK Tile fwd/bwd codegen 与 mha_bwd_ck.hip 仍完整保留（与 inference-only 不同，不排除 fmha_bwd）。
 */
function buildSkipFavV3AtenPoints(): PatchPoint[] {
  return [
    {
      name: "aten-ck-sdpa-skip-fav-v3",
      before: `    add_subdirectory(native/transformers/hip/flash_attn/ck)
    # FAv3 Generation
    add_subdirectory(native/transformers/hip/flash_attn/ck/fav_v3)
    file(GLOB ck_sdpa_sources_hip CONFIGURE_DEPENDS
         "native/transformers/hip/flash_attn/ck/*.hip"
         "native/transformers/hip/flash_attn/ck/fav_v3/*.hip")`,
      after: `    add_subdirectory(native/transformers/hip/flash_attn/ck)
    # FAv3 Generation skipped (lock GPU_ARCHS has no MI3xx gfx942/gfx950)
    file(GLOB ck_sdpa_sources_hip CONFIGURE_DEPENDS
         "native/transformers/hip/flash_attn/ck/*.hip")`,
    },
    {
      name: "aten-ck-sdpa-omit-aiter-hsa-header",
      before: `    target_compile_definitions(ck_sdpa PUBLIC \${CK_SDPA_EXTRA_HIPCC_OPTIONS})
    target_compile_definitions(ck_sdpa PRIVATE AITER_EMBEDDED_HSA_HEADER="aiter_embedded_hsa.h")
    target_include_directories(ck_sdpa PUBLIC
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/library/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/example/ck_tile/01_fmha
                               \${CMAKE_CURRENT_BINARY_DIR}/composable_kernel
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/aiter/csrc/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/native/transformers/hip/flash_attn/ck
                               \${AITER_EMBEDDED_HSA_HEADER_DIR}
                               )`,
      after: `    target_compile_definitions(ck_sdpa PUBLIC \${CK_SDPA_EXTRA_HIPCC_OPTIONS})
    target_include_directories(ck_sdpa PUBLIC
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/library/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/composable_kernel/example/ck_tile/01_fmha
                               \${CMAKE_CURRENT_BINARY_DIR}/composable_kernel
                               \${CMAKE_CURRENT_SOURCE_DIR}/../../../third_party/aiter/csrc/include
                               \${CMAKE_CURRENT_SOURCE_DIR}/native/transformers/hip/flash_attn/ck
                               )`,
    },
  ];
}

/**
 * 对 clone 后的 PyTorch 源码应用 gfx120x CK SDPA 全部 patch。
 *
 * 补丁分组：
 * 1. 根 CMakeLists.txt — 启用 Windows CK SDPA（撤销 #182733）、MSVC /Brepro 与 clang-cl 警告抑制（local）
 * 2. cmake/External/aotriton.cmake — 外部依赖 UPDATE_DISCONNECTED、CMAKE_SUPPRESS_REGENERATION 与编译选项注入（local）
 * 3. Context.cpp / launch_kernel_pt.hpp — #188114 gfx120x 架构支持
 * 4. hip/flash_attn/flash_api.h — 移除 mha_fwd_ck 声明的 TORCH_API（local，Windows dllimport）
 * 5. ck/CMakeLists.txt — Windows codegen 适配 + CK_TARGETS（buildCkCmakePoints）
 * 6. aten/CMakeLists.txt — #188114 arch whitelist；无 MI3xx 时 skip fav_v3（buildSkipFavV3AtenPoints）
 */
export function runPatch(options: { ptSrc: string }): void {
  const root = path.resolve(options.ptSrc);
  const ckTargets = requireLockEnv("CK_TARGETS");
  const ckOptDim = requireLockEnv("CK_OPT_DIM");
  const gpuArchsEnv = requireLockEnv("GPU_ARCHS");
  const gpuArchList = parseGpuArchList(gpuArchsEnv);
  const includeFavV3 = gpuArchListIncludesMi3xxForFavV3(gpuArchsEnv);
  const gpuArchCpp = formatGpuArchCppStrings(gpuArchList);
  const gpuArchDefines = formatGpuArchCppDefines(gpuArchList);
  const gpuArchCmake = formatGpuArchCmakeList(gpuArchList);

  applyPoints(path.join(root, "CMakeLists.txt"), [
    // local：撤销 v2.13.0 已合入的 #182733 NOT WIN32，Windows gfx120x 显式启用 CK SDPA
    {
      name: "enable-windows-ck-sdpa",
      before:
        'cmake_dependent_option(USE_ROCM_CK_SDPA "Use ROCm Composable Kernel for SDPA" ON "USE_ROCM;NOT WIN32" OFF)',
      after:
        'cmake_dependent_option(USE_ROCM_CK_SDPA "Use ROCm Composable Kernel for SDPA" ON "USE_ROCM" OFF)',
    },
    // local：可复现 wheel——编译器 /Brepro 固定 .obj COFF TimeDateStamp；链接器 /Brepro 固定 PE
    // TimeDateStamp（仅 shared/exe；llvm-lib 静态链接器不接受 /Brepro）；Windows clang-cl 诊断警告抑制
    {
      name: "msvc-brepro-compile-and-link",
      before: `  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS CMAKE_STATIC_LINKER_FLAGS
                   CMAKE_EXE_LINKER_FLAGS CMAKE_MODULE_LINKER_FLAGS)
    string(APPEND \${flag_var} " /ignore:4049 /ignore:4217 /ignore:4099")
  endforeach(flag_var)

  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS)`,
      after: `  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS CMAKE_STATIC_LINKER_FLAGS
                   CMAKE_EXE_LINKER_FLAGS CMAKE_MODULE_LINKER_FLAGS)
    string(APPEND \${flag_var} " /ignore:4049 /ignore:4217 /ignore:4099")
  endforeach(flag_var)

  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS CMAKE_EXE_LINKER_FLAGS)
    string(APPEND \${flag_var} " /Brepro")
  endforeach(flag_var)

  foreach(flag_var CMAKE_C_FLAGS CMAKE_CXX_FLAGS)
    string(APPEND \${flag_var} " /Brepro")
  endforeach(flag_var)

  if(MSVC AND CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    string(APPEND CMAKE_C_FLAGS " -Wno-ignored-attributes -Wno-unknown-argument -Wno-unused-command-line-argument -Wno-unknown-warning-option -Wno-unsafe-buffer-usage -Wno-declaration-after-statement -Wno-missing-prototypes -Wno-implicit-float-conversion -Wno-sign-conversion -Wno-cast-align -Wno-reserved-identifier -Wno-reserved-macro-identifier -Wno-disabled-macro-expansion -Wno-implicit-void-ptr-cast -Wno-double-promotion -Wno-shadow -Wno-unused-macros -Wno-jump-misses-init -Wno-padded -Wno-tentative-definition-compat -Wno-inconsistent-dllimport -Wno-deprecated-declarations -Wno-pass-failed -Wno-unused-parameter -Wno-used-but-marked-unused -Wno-float-equal -Wno-nonportable-system-include-path -Wno-strict-prototypes -Wno-implicit-int-conversion -Wno-implicit-int-enum-cast -Wno-unknown-attributes -Wno-covered-switch-default -Wno-shorten-64-to-32 -Wno-bad-function-cast -Wno-extra-semi-stmt -Wno-float-conversion -Wno-switch-default -Wno-c++-keyword -Wno-implicit-int-float-conversion -Wno-missing-variable-declarations -Wno-pedantic -Wno-switch-enum -Wno-cast-qual -Wno-overlength-strings -Wno-undef -Wno-missing-noreturn -Wno-redundant-parens -Wno-microsoft-unqualified-friend -Wno-pre-c11-compat -Wno-pointer-sign -Wno-global-constructors -Wno-unterminated-string-initialization -Wno-c++-unterminated-string-initialization -Wno-sign-compare -Wno-conditional-uninitialized -Wno-macro-redefined -Wno-format -Wno-implicit-const-int-float-conversion -Wno-cuda-compat -Wno-switch -Wno-unused-value -Wno-dll-attribute-on-redeclaration -Wno-format-nonliteral -Wno-exceptions -Wno-unused-result")
    string(APPEND CMAKE_CXX_FLAGS " -Wno-ignored-attributes -Wno-unknown-argument -Wno-unused-command-line-argument -Wno-unknown-warning-option -Wno-unsafe-buffer-usage -Wno-declaration-after-statement -Wno-missing-prototypes -Wno-implicit-float-conversion -Wno-sign-conversion -Wno-cast-align -Wno-reserved-identifier -Wno-reserved-macro-identifier -Wno-disabled-macro-expansion -Wno-implicit-void-ptr-cast -Wno-double-promotion -Wno-shadow -Wno-unused-macros -Wno-jump-misses-init -Wno-padded -Wno-tentative-definition-compat -Wno-inconsistent-dllimport -Wno-deprecated-declarations -Wno-pass-failed -Wno-unused-parameter -Wno-used-but-marked-unused -Wno-float-equal -Wno-nonportable-system-include-path -Wno-strict-prototypes -Wno-implicit-int-conversion -Wno-implicit-int-enum-cast -Wno-unknown-attributes -Wno-covered-switch-default -Wno-shorten-64-to-32 -Wno-bad-function-cast -Wno-extra-semi-stmt -Wno-float-conversion -Wno-switch-default -Wno-c++-keyword -Wno-implicit-int-float-conversion -Wno-missing-variable-declarations -Wno-pedantic -Wno-switch-enum -Wno-cast-qual -Wno-overlength-strings -Wno-undef -Wno-missing-noreturn -Wno-redundant-parens -Wno-microsoft-unqualified-friend -Wno-pre-c11-compat -Wno-pointer-sign -Wno-global-constructors -Wno-unterminated-string-initialization -Wno-c++-unterminated-string-initialization -Wno-sign-compare -Wno-conditional-uninitialized -Wno-macro-redefined -Wno-format -Wno-implicit-const-int-float-conversion -Wno-cuda-compat -Wno-switch -Wno-unused-value -Wno-dll-attribute-on-redeclaration -Wno-format-nonliteral -Wno-exceptions -Wno-unused-result")
  endif()

  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS)`,
    },
  ]);

  // local：三处 ExternalProject（dlfcn-win32 / xz / aotriton_runtime）在缓存
  // 恢复后续编时不重新 configure，从而保住各子树的 .ninja_log，跳过 ~4110
  // aotriton autotune 对象重编。dlfcn 用 MSVC cl（/utf-8 /Brepro）；xz / aotriton_runtime 用 clang-cl。
  const msvcExternalCFlags = "/utf-8 /Brepro";
  const clangExternalCFlags =
    "/utf-8 /Brepro -Wno-ignored-attributes -Wno-unknown-argument -Wno-unused-command-line-argument";
  const xzExternalCFlags =
    "/utf-8 /Brepro -Wno-ignored-attributes -Wno-unknown-argument -Wno-unused-command-line-argument -Wno-unsafe-buffer-usage -Wno-declaration-after-statement -Wno-disabled-macro-expansion -Wno-implicit-void-ptr-cast -Wno-reserved-macro-identifier -Wno-jump-misses-init -Wno-padded -Wno-reserved-identifier -Wno-used-but-marked-unused -Wno-nonportable-system-include-path -Wno-unused-parameter -Wno-implicit-int-conversion -Wno-implicit-int-enum-cast -Wno-deprecated-declarations -Wno-c++-unterminated-string-initialization -Wno-sign-compare -Wno-conditional-uninitialized -Wno-covered-switch-default -Wno-sign-conversion -Wno-cast-align -Wno-shorten-64-to-32 -Wno-extra-semi-stmt -Wno-c++-keyword -Wno-switch-default -Wno-switch-enum -Wno-cast-qual -Wno-undef -Wno-overlength-strings";
  applyPoints(path.join(root, "cmake/External/aotriton.cmake"), [
    // dlfcn-win32：CMAKE_ARGS（仅首次 configure 生效）+ UPDATE_DISCONNECTED
    {
      name: "aotriton-dlfcn-update-disconnected",
      before: `    ExternalProject_Add(\${dlfcn-win32_external}
      GIT_REPOSITORY https://github.com/dlfcn-win32/dlfcn-win32.git
      GIT_TAG v1.4.2
      PREFIX \${__DLFCN_WIN32_PREFIX}
      INSTALL_DIR \${__DLFCN_WIN32_INSTALL_DIR}
      CMAKE_ARGS
        -DCMAKE_INSTALL_PREFIX=\${__DLFCN_WIN32_INSTALL_DIR}`,
      after: `    ExternalProject_Add(\${dlfcn-win32_external}
      GIT_REPOSITORY https://github.com/dlfcn-win32/dlfcn-win32.git
      GIT_TAG v1.4.2
      PREFIX \${__DLFCN_WIN32_PREFIX}
      INSTALL_DIR \${__DLFCN_WIN32_INSTALL_DIR}
      UPDATE_DISCONNECTED TRUE
      CMAKE_ARGS
        -DCMAKE_SUPPRESS_REGENERATION:BOOL=ON
        "-DCMAKE_C_FLAGS=${msvcExternalCFlags}"
        "-DCMAKE_CXX_FLAGS=${msvcExternalCFlags}"
        -DCMAKE_SHARED_LINKER_FLAGS=/Brepro
        -DCMAKE_EXE_LINKER_FLAGS=/Brepro
        -DCMAKE_INSTALL_PREFIX=\${__DLFCN_WIN32_INSTALL_DIR}`,
    },
    // xz/liblzma：继承父工程 clang-cl（非 dlfcn 的 MSVC cl）
    {
      name: "aotriton-xz-update-disconnected",
      before: `    ExternalProject_Add(\${xz_external}
      GIT_REPOSITORY https://github.com/tukaani-project/xz.git
      GIT_TAG v5.8.1
      PREFIX \${__XZ_PREFIX}
      INSTALL_DIR \${__XZ_INSTALL_DIR}
      CMAKE_ARGS
        -DCMAKE_INSTALL_PREFIX=\${__XZ_INSTALL_DIR}`,
      after: `    ExternalProject_Add(\${xz_external}
      GIT_REPOSITORY https://github.com/tukaani-project/xz.git
      GIT_TAG v5.8.1
      PREFIX \${__XZ_PREFIX}
      INSTALL_DIR \${__XZ_INSTALL_DIR}
      UPDATE_DISCONNECTED TRUE
      CMAKE_ARGS
        -DCMAKE_SUPPRESS_REGENERATION:BOOL=ON
        "-DCMAKE_C_FLAGS=${xzExternalCFlags}"
        -DCMAKE_INSTALL_PREFIX=\${__XZ_INSTALL_DIR}`,
    },
    // aotriton_runtime：CMAKE_ARGS 注入 flags（dlfcn/xz 同模式）；CMAKE_CACHE_ARGS 仅存无空格 cache 项
    // （STRING 含空格会被 CMake 拆成 list，clang-cl 收到 ;/utf-8;/Brepro;... 单参数而 configure 失败）
    {
      name: "aotriton-runtime-update-disconnected",
      before: `      CMAKE_CACHE_ARGS
      -DAOTRITON_TARGET_ARCH:STRING=\${PYTORCH_ROCM_ARCH}
      -DCMAKE_INSTALL_PREFIX:FILEPATH=\${__AOTRITON_INSTALL_DIR}`,
      after: `      UPDATE_DISCONNECTED TRUE
      CMAKE_ARGS
        -DCMAKE_SUPPRESS_REGENERATION:BOOL=ON
        "-DCMAKE_C_FLAGS=${clangExternalCFlags}"
        "-DCMAKE_CXX_FLAGS=${clangExternalCFlags}"
        -DCMAKE_SHARED_LINKER_FLAGS=/Brepro
        -DCMAKE_EXE_LINKER_FLAGS=/Brepro
      CMAKE_CACHE_ARGS
      -DCMAKE_SUPPRESS_REGENERATION:BOOL=ON
      -DAOTRITON_TARGET_ARCH:STRING=\${PYTORCH_ROCM_ARCH}
      -DCMAKE_INSTALL_PREFIX:FILEPATH=\${__AOTRITON_INSTALL_DIR}`,
    },
  ]);

  applyPoints(path.join(root, "aten/src/ATen/Context.cpp"), [
    // #188114（未合）：v2.13.0 仍用 ckSupported()，增加 gfx1200/gfx1201
    {
      name: "ck-sdpa-gfx12-arch-list",
      before: [
        '"gfx942", "gfx950",',
        `  static const std::vector<std::string> supported_archs = {
    "gfx942", "gfx950"
  };`,
      ],
      after: [
        `"gfx942", "gfx950", ${gpuArchCpp},`,
        `  static const std::vector<std::string> supported_archs = {
    "gfx942", "gfx950", ${gpuArchCpp}
  };`,
      ],
    },
  ]);

  applyPoints(
    path.join(root, "aten/src/ATen/native/transformers/hip/flash_attn/ck/launch_kernel_pt.hpp"),
    [
      // #188114（未合）：在 #144777/#155103 已有 gfx90a/gfx942/gfx950 guard 上增加 gfx120x
      {
        name: "kentry-pt-gfx12-guard",
        before:
          "#if (defined(__gfx90a__) || defined(__gfx942__) || defined(__gfx950__))",
        after:
          `#if (defined(__gfx90a__) || defined(__gfx942__) || defined(__gfx950__) || \\\n ${gpuArchDefines})`,
        replaceAll: true,
      },
    ],
  );

  applyPoints(
    path.join(
      root,
      "aten/src/ATen/native/transformers/hip/flash_attn/flash_api.h",
    ),
    [
      // local：mha_fwd_ck 声明带 TORCH_API。Windows 下 ck_sdpa 静态库 TU 中展开为
      // __declspec(dllimport)，定义本身被打标 → lld-link 无法用静态档案定义解析
      // dllimport 引用（"cannot be used because it is not an import library"）。
      // 该符号仅在 torch_hip.dll 内部消费，无需导出；去掉后与同块其余 CK 声明对齐。
      {
        name: "flash-api-mha-fwd-ck-drop-torch-api",
        before: `// CK implementation
TORCH_API
std::tuple<`,
        after: `// CK implementation
std::tuple<`,
      },
    ],
  );

  const ckDir = path.join(
    root,
    "aten/src/ATen/native/transformers/hip/flash_attn/ck",
  );
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const addMakeKernelPtSrc = path.join(repoRoot, "build/add-make-kernel-pt.py");
  const addMakeKernelPtDst = path.join(ckDir, "add_make_kernel_pt.py");
  // local：部署 Python 版 add_make_kernel_pt，替代上游 #143695 add_make_kernel_pt.sh
  copyFileSync(addMakeKernelPtSrc, addMakeKernelPtDst);
  console.log(`  OK ck-add-make-kernel-pt-py: copied to ${addMakeKernelPtDst}`);

  const ckCmake = path.join(ckDir, "CMakeLists.txt");
  applyPoints(ckCmake, buildCkCmakePoints(ckTargets, ckOptDim));

  const atenCmake = path.join(root, "aten/src/ATen/CMakeLists.txt");
  const atenPoints: PatchPoint[] = [
    // #188114（未合）：aten arch 检测 whitelist 增加 gfx1200/gfx1201
    {
      name: "aten-ck-sdpa-arch-detect-foreach",
      before: `      set(_have_ck_sdpa_arch FALSE)
      foreach(ARCH gfx942 gfx950)`,
      after: `      set(_have_ck_sdpa_arch FALSE)
      foreach(ARCH gfx942 gfx950 ${gpuArchCmake})`,
    },
    // #188114（未合）：_ck_sdpa_hip_arches 构建列表增加 gfx1200/gfx1201
    {
      name: "aten-ck-sdpa-hip-arches-foreach",
      before: `    foreach(ARCH gfx942 gfx950)
      if("\${ARCH}" IN_LIST PYTORCH_ROCM_ARCH)
        list(APPEND _ck_sdpa_hip_arches \${ARCH})`,
      after: `    foreach(ARCH gfx942 gfx950 ${gpuArchCmake})
      if("\${ARCH}" IN_LIST PYTORCH_ROCM_ARCH)
        list(APPEND _ck_sdpa_hip_arches \${ARCH})`,
    },
  ];
  if (!includeFavV3) {
    atenPoints.push(...buildSkipFavV3AtenPoints());
  }
  applyPoints(atenCmake, atenPoints);

  const favV3Status = includeFavV3
    ? "enabled (MI3xx in GPU_ARCHS)"
    : "skipped (no gfx942/gfx950 in GPU_ARCHS)";
  console.log(
    `Patched pytorch source at ${root} for gfx120x CK SDPA (GPU_ARCHS=${gpuArchCmake}, CK_TARGETS=${ckTargets}, fav_v3=${favV3Status})`,
  );
}
