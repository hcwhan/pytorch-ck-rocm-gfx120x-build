import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatGpuArchCmakeList,
  formatGpuArchCppDefines,
  formatGpuArchCppStrings,
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

/** 读取 lock `CK_FMHA_DISABLE_BWD` 是否为 inference-only 构建。 */
function ckFmhaDisableBwd(): boolean {
  return requireLockEnv("CK_FMHA_DISABLE_BWD") === "1";
}

/**
 * CK FMHA 子目录 `flash_attn/ck/CMakeLists.txt` 的 patch 点。
 *
 * 基于 v2.13.0 上游 #143695/#157964 的 codegen 流程，补充 Windows 适配（Python3_EXECUTABLE、
 * 独立 RESULT_VARIABLE）与 #188114 的 `--targets gfx12`（由 lock CK_TARGETS 参数化）。
 * `disableBwd=true` 时省略 bwd codegen（local inference-only）。
 */
function buildCkCmakePoints(ckTargets: string, ckOptDim: string, disableBwd: boolean): PatchPoint[] {
  const common: PatchPoint[] = [
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

  if (!disableBwd) {
    return [
      ...common.slice(0, 2),
      // pytorch/pytorch#188114 + local：bwd codegen 传入 --targets（CK_TARGETS 参数化）
      {
        name: "ck-codegen-list-bwd",
        before: `  COMMAND \${CK_FMHA_GENERATE}
  --api bwd --optdim=${ckOptDim}`,
        after: `  COMMAND \${CK_FMHA_GENERATE} ${ckTargets}
  --api bwd --optdim=${ckOptDim}`,
      },
      ...common.slice(2, 5),
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
      ...common.slice(5),
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
    ];
  }

  const bwdOmit = "# CK FMHA bwd omitted (inference-only; CK_FMHA_DISABLE_BWD=1)\n";
  return [
    ...common.slice(0, 2),
    // local：inference-only 省略 bwd codegen list（lock CK_FMHA_DISABLE_BWD=1）
    {
      name: "ck-codegen-list-bwd-omit",
      before: `execute_process(
  COMMAND \${CK_FMHA_GENERATE}
  --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --list_blobs \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt
  RESULT_VARIABLE ret
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate a list of BWD kernels via Python.")
endif()

`,
      after: bwdOmit,
    },
    ...common.slice(2, 5),
    // local：inference-only 省略 bwd kernel emit
    {
      name: "ck-codegen-emit-bwd-omit",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api bwd --optdim=${ckOptDim} --receipt 4 --filter "*psdv*@*psd*@*_pd1dv1*_ntrload*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
  RESULT_VARIABLE ret
)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to generate BWD kernels.")
endif()

`,
      after: bwdOmit,
    },
    ...common.slice(5),
    // local：inference-only 省略 bwd make_kernel_pt 步骤
    {
      name: "ck-make-kernel-pt-bwd-omit",
      before: `# Change make_kernel to make_kernel_pt for bwd
execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt"
  RESULT_VARIABLE ret)

if(ret AND NOT ret EQUAL 0)
  message( FATAL_ERROR "CK Tile FMHA FAILED to change make_kernel to make_kernel_pt for the bwd pass")
endif()

`,
      after: bwdOmit,
    },
  ];
}

/**
 * inference-only 时 `aten/src/ATen/CMakeLists.txt` 的 CK SDPA 相关 patch。
 *
 * local：lock `CK_FMHA_DISABLE_BWD=1` 时跳过 fav_v3/bwd blob、定义 FLASHATTENTION_DISABLE_BACKWARD。
 * 上游 #143695 默认仍编译完整 bwd 与 fav_v3（MI3xx ASM）。
 */
function buildInferenceOnlyAtenPoints(): PatchPoint[] {
  return [
    // local：inference-only 定义 FLASHATTENTION_DISABLE_BACKWARD（上游 #143695 bwd 仍编译）
    {
      name: "aten-ck-sdpa-disable-backward-def",
      before: `        __GCC_HAVE_DWARF2_CFI_ASM=1
        USE_ROCM_CK_SDPA)`,
      after: `        __GCC_HAVE_DWARF2_CFI_ASM=1
        FLASHATTENTION_DISABLE_BACKWARD
        USE_ROCM_CK_SDPA)`,
    },
    // local：inference-only 跳过 fav_v3（MI3xx ASM bwd，#143695 fav_v3 子目录）
    {
      name: "aten-ck-sdpa-skip-fav-v3",
      before: `    add_subdirectory(native/transformers/hip/flash_attn/ck)
    # FAv3 Generation
    add_subdirectory(native/transformers/hip/flash_attn/ck/fav_v3)
    file(GLOB ck_sdpa_sources_hip CONFIGURE_DEPENDS
         "native/transformers/hip/flash_attn/ck/*.hip"
         "native/transformers/hip/flash_attn/ck/fav_v3/*.hip")`,
      after: `    add_subdirectory(native/transformers/hip/flash_attn/ck)
    # FAv3 Generation skipped (inference-only CK FMHA build; MI3xx ASM bwd)
    file(GLOB ck_sdpa_sources_hip CONFIGURE_DEPENDS
         "native/transformers/hip/flash_attn/ck/*.hip")
    list(FILTER ck_sdpa_sources_hip EXCLUDE REGEX "fmha_bwd")`,
    },
    // local：inference-only 移除 AITER_EMBEDDED_HSA_HEADER（无 fav_v3 嵌入 HSA）
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

const BWD_DISABLED_MSG =
  "This flash attention build does not support backward.";

/**
 * inference-only 时对 `mha_bwd_ck.hip` 的就地 stub patch。
 *
 * local：用 `#if 0` 包裹 bwd helper/函数体，入口保留 TORCH_CHECK。
 * helper `#endif` 前关闭 namespace 并在 stub 函数前重新打开，避免 v2.13.0 出现 extraneous `}`。
 * 兼容 v2.13.0（已有 FLASHATTENTION_DISABLE_BACKWARD guard）与更早 upstream 布局。
 * 上游 bwd 实现来自 #143695。
 */
function buildMhaBwdCkStubPoints(): PatchPoint[] {
  const omitFunctionBodyBefore = [
    `#ifdef FLASHATTENTION_DISABLE_BACKWARD
    TORCH_CHECK(false, "This flash attention build does not support backward.");
#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    `#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
  ];
  const omitFunctionBodyAfter = [
    `    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    `#endif
    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
  ];
  const reopenNamespaceBeforeMhaBwdCk = `
namespace pytorch_flash {

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_bwd_ck(const at::Tensor &dout,                   // batch_size x seqlen_q x num_heads, x head_size_og`;

  return [
    // local：inference-only 用 #if 0 包裹 bwd helper（上游 #143695 mha_bwd_ck.hip）
    {
      name: "mha-bwd-ck-omit-helper-preamble",
      before: [
        `#include <mha_bwd.h>
#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` vs older CK (see mha_fwd_ck.hip).`,
        `#include <mha_bwd.h>
#include <fmha_bwd.hpp>
#include <mask.hpp>

namespace pytorch_flash {

aiter::mha_bwd_args get_ck_fmha_bwd_args`,
      ],
      after: [
        `#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
#include <mha_bwd.h>
#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` vs older CK (see mha_fwd_ck.hip).`,
        `#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
#include <mha_bwd.h>
#include <fmha_bwd.hpp>
#include <mask.hpp>

namespace pytorch_flash {

aiter::mha_bwd_args get_ck_fmha_bwd_args`,
      ],
    },
    // local：inference-only 关闭 bwd helper #if 0 块
    {
      name: "mha-bwd-ck-close-helper-if0",
      before: [
        `    args.drop_seed_offset       = drop_seed_offset;
    return args;
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_bwd_ck(const at::Tensor &dout,                   // batch_size x seqlen_q x num_heads, x head_size_og`,
        `        drop_seed_offset
    };
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_bwd_ck(const at::Tensor &dout,                   // batch_size x seqlen_q x num_heads, x head_size_og`,
      ],
      after: [
        `    args.drop_seed_offset       = drop_seed_offset;
    return args;
}
} // namespace pytorch_flash
#endif${reopenNamespaceBeforeMhaBwdCk}`,
        `        drop_seed_offset
    };
}
} // namespace pytorch_flash
#endif${reopenNamespaceBeforeMhaBwdCk}`,
      ],
    },
    // local：inference-only stub mha_bwd_ck 函数体（v2.13.0 已有 FLASHATTENTION_DISABLE_BACKWARD guard）
    {
      name: "mha-bwd-ck-omit-function-body",
      before: omitFunctionBodyBefore,
      after: omitFunctionBodyAfter,
    },
    // local：inference-only 关闭 mha_bwd_ck 函数体 #if 0
    {
      name: "mha-bwd-ck-close-function-body-if0",
      before: `    return { dq, dk, dv, softmax_d, dbias };
}
} // namespace pytorch_flash`,
      after: `    return { dq, dk, dv, softmax_d, dbias };
#endif
}
} // namespace pytorch_flash`,
    },
  ];
}

/**
 * inference-only 时对 `mha_varlen_bwd_ck.hip` 的就地 stub patch。
 *
 * 逻辑同 {@link buildMhaBwdCkStubPoints}，适配 varlen bwd 上游布局差异（#143695）。
 */
function buildMhaVarlenBwdCkStubPoints(): PatchPoint[] {
  const omitFunctionBodyBefore = [
    `#ifdef FLASHATTENTION_DISABLE_BACKWARD
    TORCH_CHECK(false, "This flash attention build does not support backward.");
#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    `#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
  ];
  const omitFunctionBodyAfter = [
    `    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    `#endif
    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
  ];
  const reopenNamespaceBeforeMhaVarlenBwdCk = `
namespace pytorch_flash {

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_varlen_bwd_ck(const at::Tensor &dout,                   // total_q x num_heads x head_size`;

  return [
    // local：inference-only 用 #if 0 包裹 varlen bwd helper（上游 #143695 mha_varlen_bwd_ck.hip）
    {
      name: "mha-varlen-bwd-ck-omit-helper-preamble",
      before: [
        `#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` layout vs older CK revisions.`,
        `#include <fmha_bwd.hpp>
#include <mask.hpp>


namespace pytorch_flash {


fmha_bwd_traits get_ck_fmha_varlen_bwd_traits`,
      ],
      after: [
        `#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` layout vs older CK revisions.`,
        `#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
#include <fmha_bwd.hpp>
#include <mask.hpp>


namespace pytorch_flash {


fmha_bwd_traits get_ck_fmha_varlen_bwd_traits`,
      ],
    },
    // local：inference-only 关闭 varlen bwd helper #if 0 块
    {
      name: "mha-varlen-bwd-ck-close-helper-if0",
      before: [
        `    args.drop_seed_offset        = drop_seed_offset;
    return args;
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_varlen_bwd_ck(const at::Tensor &dout,                   // total_q x num_heads x head_size`,
        `                         drop_seed_offset};
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_varlen_bwd_ck(const at::Tensor &dout,                   // total_q x num_heads x head_size`,
      ],
      after: [
        `    args.drop_seed_offset        = drop_seed_offset;
    return args;
}
} // namespace pytorch_flash
#endif${reopenNamespaceBeforeMhaVarlenBwdCk}`,
        `                         drop_seed_offset};
}
} // namespace pytorch_flash
#endif${reopenNamespaceBeforeMhaVarlenBwdCk}`,
      ],
    },
    // local：inference-only stub mha_varlen_bwd_ck 函数体
    {
      name: "mha-varlen-bwd-ck-omit-function-body",
      before: omitFunctionBodyBefore,
      after: omitFunctionBodyAfter,
    },
    // local：inference-only 关闭 mha_varlen_bwd_ck 函数体 #if 0
    {
      name: "mha-varlen-bwd-ck-close-function-body-if0",
      before: `    return { dq, dk, dv, softmax_d, dbias };
}
} // namespace pytorch_flash`,
      after: `    return { dq, dk, dv, softmax_d, dbias };
#endif
}
} // namespace pytorch_flash`,
    },
  ];
}

/**
 * inference-only 时对 `me_bwd_ck.hip` 的就地 stub patch。
 *
 * local：memory-efficient bwd 包装层直接 TORCH_CHECK，不调用 mha_bwd_ck（#143695）。
 */
function buildMeBwdCkStubPoints(): PatchPoint[] {
  return [
    // local：inference-only stub me_bwd_ck 函数体（上游 #143695 me_bwd_ck.hip）
    {
      name: "me-bwd-ck-omit-function-body",
      before: `{

  const int non_null_window_left  = -1;
  const int non_null_window_right = -1;

  std::optional<at::Tensor> opt_dQ, opt_dK, opt_dV;
  opt_dQ = dq_;
  opt_dK = dk_;
  opt_dV = dv_;

  if(!cu_seqlens_q.has_value()) {
    auto
      [dQ,
       dK,
       dV,
       softmax_d,
       dBias] =
        mha_bwd_ck(`,
      after: `{
  TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)

  const int non_null_window_left  = -1;
  const int non_null_window_right = -1;

  std::optional<at::Tensor> opt_dQ, opt_dK, opt_dV;
  opt_dQ = dq_;
  opt_dK = dk_;
  opt_dV = dv_;

  if(!cu_seqlens_q.has_value()) {
    auto
      [dQ,
       dK,
       dV,
       softmax_d,
       dBias] =
        mha_bwd_ck(`,
    },
    // local：inference-only 关闭 me_bwd_ck 函数体 #if 0
    {
      name: "me-bwd-ck-close-function-body-if0",
      before: `  return std::make_tuple(at::Tensor{}, at::Tensor{}, at::Tensor{}, at::Tensor{});
}

} // namespace pytorch_flash
#endif // USE_ROCM_CK_SDPA`,
      after: `  return std::make_tuple(at::Tensor{}, at::Tensor{}, at::Tensor{}, at::Tensor{});
#endif
}

} // namespace pytorch_flash
#endif // USE_ROCM_CK_SDPA`,
    },
  ];
}

/**
 * 对 clone 后的 PyTorch 源码应用 gfx120x CK SDPA 全部 patch。
 *
 * 补丁分组：
 * 1. 根 CMakeLists.txt — 启用 Windows CK SDPA（撤销 #182733）、MSVC /Brepro（local）
 * 2. Context.cpp / launch_kernel_pt.hpp — #188114 gfx120x 架构支持
 * 3. ck/CMakeLists.txt — Windows codegen 适配 + CK_TARGETS（buildCkCmakePoints）
 * 4. aten/CMakeLists.txt — #188114 arch whitelist；可选 inference-only（buildInferenceOnlyAtenPoints）
 * 5. bwd *.hip — 可选 inference-only stub（buildMha* / buildMeBwdCkStubPoints）
 * 6. cmake/External/aotriton.cmake — 注入 CMAKE_SUPPRESS_REGENERATION=ON（local）
 */
export function runPatch(options: { ptSrc: string }): void {
  const root = path.resolve(options.ptSrc);
  const ckTargets = requireLockEnv("CK_TARGETS");
  const ckOptDim = requireLockEnv("CK_OPT_DIM");
  const disableBwd = ckFmhaDisableBwd();
  const gpuArchList = parseGpuArchList(requireLockEnv("GPU_ARCHS"));
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
    // local：可复现 wheel PE TimeDateStamp；/Brepro 仅作用于 shared/exe（llvm-lib 静态库不接受）
    {
      name: "msvc-link-brepro-exe-shared-only",
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

  foreach(flag_var CMAKE_SHARED_LINKER_FLAGS)`,
    },
  ]);

  // local：三处 ExternalProject（dlfcn-win32 / xz / aotriton_runtime）在缓存
  // 恢复后续编时不重新 configure，从而保住各子树的 .ninja_log，跳过 ~4110
  // aotriton autotune 对象重编。
  //
  // 根因：cmake --build 每次会 re-run CMake；ExternalProject 的 update step
  // 默认「只要 CMake re-run 就重跑」，重跑后 touch update stamp -> configure
  // stamp 变旧 -> configure 重跑 -> 重写 build.ninja -> .ninja_log 作废 ->
  // 全部重编。UPDATE_DISCONNECTED 跳过 update（Git 源 + 固定 GIT_TAG，本就
  // 无需 update），configure 随即因源码 mtime(已 pin 为 epoch) 不新于 stamp
  // 而跳过。同时向三个子树注入 CMAKE_SUPPRESS_REGENERATION，双保险压掉
  // build 阶段内的 RERUN_CMAKE/VERIFY_GLOBS。
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
        -DCMAKE_INSTALL_PREFIX=\${__DLFCN_WIN32_INSTALL_DIR}`,
    },
    // xz/liblzma：同上
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
        -DCMAKE_INSTALL_PREFIX=\${__XZ_INSTALL_DIR}`,
    },
    // aotriton_runtime：CMAKE_CACHE_ARGS + UPDATE_DISCONNECTED
    {
      name: "aotriton-runtime-update-disconnected",
      before: `      CMAKE_CACHE_ARGS
      -DAOTRITON_TARGET_ARCH:STRING=\${PYTORCH_ROCM_ARCH}
      -DCMAKE_INSTALL_PREFIX:FILEPATH=\${__AOTRITON_INSTALL_DIR}`,
      after: `      UPDATE_DISCONNECTED TRUE
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
  applyPoints(ckCmake, buildCkCmakePoints(ckTargets, ckOptDim, disableBwd));

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
  if (disableBwd) {
    // local：CK_FMHA_DISABLE_BWD=1 时追加 inference-only aten/bwd stub 补丁
    atenPoints.push(...buildInferenceOnlyAtenPoints());
    applyPoints(path.join(ckDir, "mha_bwd_ck.hip"), buildMhaBwdCkStubPoints());
    applyPoints(
      path.join(ckDir, "mha_varlen_bwd_ck.hip"),
      buildMhaVarlenBwdCkStubPoints(),
    );
    applyPoints(path.join(ckDir, "me_bwd_ck.hip"), buildMeBwdCkStubPoints());
  }
  applyPoints(atenCmake, atenPoints);

  console.log(
    `Patched pytorch source at ${root} for gfx120x CK SDPA (GPU_ARCHS=${gpuArchCmake}, CK_TARGETS=${ckTargets}, CK_FMHA_DISABLE_BWD=${disableBwd ? "1" : "0"})`,
  );
}
