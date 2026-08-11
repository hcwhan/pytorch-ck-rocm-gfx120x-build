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

type PatchPoint = {
  name: string;
  before: string;
  after: string;
  replaceAll?: boolean;
};

function readNormalized(filePath: string): { content: string; eol: "\n" | "\r\n" } {
  const raw = readFileSync(filePath, "utf8");
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  return { content: raw.replace(/\r\n/g, "\n"), eol };
}

function writeNormalized(
  filePath: string,
  content: string,
  eol: "\n" | "\r\n",
): void {
  const out = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
  writeFileSync(filePath, out, "utf8");
}

function applyPoints(filePath: string, points: PatchPoint[]): void {
  let { content, eol } = readNormalized(filePath);

  for (const point of points) {
    const count = point.replaceAll
      ? content.split(point.before).length - 1
      : content.includes(point.before)
        ? 1
        : 0;
    if (count < 1) {
      throw new Error(`patch: before-state not found for '${point.name}' in ${filePath}`);
    }
    console.log(`  OK ${point.name}: before-state found (${count})`);
  }

  for (const point of points) {
    content = point.replaceAll
      ? content.replaceAll(point.before, point.after)
      : content.replace(point.before, point.after);
    console.log(`  OK ${point.name}: patched`);
  }

  writeNormalized(filePath, content, eol);
}

function ckFmhaDisableBwd(): boolean {
  return requireLockEnv("CK_FMHA_DISABLE_BWD") === "1";
}

function buildCkCmakePoints(ckTargets: string, ckOptDim: string, disableBwd: boolean): PatchPoint[] {
  const common: PatchPoint[] = [
    {
      name: "ck-fmha-generate-python3-executable",
      before: `set(CK_FMHA_GENERATE python3 \${CMAKE_CURRENT_LIST_DIR}/generate_compat.py
    \${CMAKE_SOURCE_DIR}/third_party/composable_kernel/example/ck_tile/01_fmha/generate.py)`,
      after: `set(CK_FMHA_GENERATE \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/generate_compat.py
    \${CMAKE_SOURCE_DIR}/third_party/composable_kernel/example/ck_tile/01_fmha/generate.py)`,
    },
    {
      name: "ck-codegen-list-optdim",
      before: `COMMAND \${CK_FMHA_GENERATE} --optdim=${ckOptDim}`,
      after: `COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --optdim=${ckOptDim}`,
      replaceAll: true,
    },
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
    {
      name: "ck-make-kernel-pt-fwd-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    {
      name: "ck-make-kernel-pt-fwd-splitkv-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_splitkv_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_splitkv_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
    {
      name: "ck-make-kernel-pt-fwd-appendkv-python",
      before: `execute_process(
  COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/fwd_appendkv_blob_list.txt"
  RESULT_VARIABLE ret)`,
      after: `execute_process(
  COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/fwd_appendkv_blob_list.txt
  RESULT_VARIABLE ret)`,
    },
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
      {
        name: "ck-codegen-list-bwd",
        before: `  COMMAND \${CK_FMHA_GENERATE}
  --api bwd --optdim=${ckOptDim}`,
        after: `  COMMAND \${CK_FMHA_GENERATE} ${ckTargets}
  --api bwd --optdim=${ckOptDim}`,
      },
      ...common.slice(2, 5),
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

function buildInferenceOnlyAtenPoints(): PatchPoint[] {
  return [
    {
      name: "aten-ck-sdpa-disable-backward-def",
      before: `        __GCC_HAVE_DWARF2_CFI_ASM=1
        USE_ROCM_CK_SDPA)`,
      after: `        __GCC_HAVE_DWARF2_CFI_ASM=1
        FLASHATTENTION_DISABLE_BACKWARD
        USE_ROCM_CK_SDPA)`,
    },
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

function buildMhaBwdCkStubPoints(): PatchPoint[] {
  return [
    {
      name: "mha-bwd-ck-omit-helper-preamble",
      before: `#include <mha_bwd.h>
#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` vs older CK (see mha_fwd_ck.hip).`,
      after: `namespace pytorch_flash {

#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` vs older CK (see mha_fwd_ck.hip).`,
    },
    {
      name: "mha-bwd-ck-close-helper-if0",
      before: `    args.drop_seed_offset       = drop_seed_offset;
    return args;
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_bwd_ck(const at::Tensor &dout,                   // batch_size x seqlen_q x num_heads, x head_size_og`,
      after: `    args.drop_seed_offset       = drop_seed_offset;
    return args;
}
#endif

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_bwd_ck(const at::Tensor &dout,                   // batch_size x seqlen_q x num_heads, x head_size_og`,
    },
    {
      name: "mha-bwd-ck-omit-function-body",
      before: `#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
      after: `#endif
    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    },
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

function buildMhaVarlenBwdCkStubPoints(): PatchPoint[] {
  return [
    {
      name: "mha-varlen-bwd-ck-omit-helper-preamble",
      before: `#include <fmha_bwd.hpp>
#include <mask.hpp>

#include <type_traits>

namespace pytorch_flash {

// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` layout vs older CK revisions.`,
      after: `namespace pytorch_flash {

#if 0 // CK FMHA bwd helpers omitted (CK_FMHA_DISABLE_BWD=1)
// SFINAE for newer composable_kernel \`fmha_bwd.hpp\` layout vs older CK revisions.`,
    },
    {
      name: "mha-varlen-bwd-ck-close-helper-if0",
      before: `    args.drop_seed_offset        = drop_seed_offset;
    return args;
}

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_varlen_bwd_ck(const at::Tensor &dout,                   // total_q x num_heads x head_size`,
      after: `    args.drop_seed_offset        = drop_seed_offset;
    return args;
}
#endif

std::tuple<at::Tensor, at::Tensor, at::Tensor, at::Tensor, at::Tensor>
mha_varlen_bwd_ck(const at::Tensor &dout,                   // total_q x num_heads x head_size`,
    },
    {
      name: "mha-varlen-bwd-ck-omit-function-body",
      before: `#endif
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
      after: `#endif
    TORCH_CHECK(false, "${BWD_DISABLED_MSG}");
#if 0 // upstream CK FMHA bwd body omitted (CK_FMHA_DISABLE_BWD=1)
    if (is_causal) { window_size_right = 0; }

    bool is_dropout = p_dropout > 0.0;
    auto stream = at::cuda::getCurrentCUDAStream().stream();`,
    },
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

function buildMeBwdCkStubPoints(): PatchPoint[] {
  return [
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
    {
      name: "enable-windows-ck-sdpa",
      before:
        'cmake_dependent_option(USE_ROCM_CK_SDPA "Use ROCm Composable Kernel for SDPA" ON "USE_ROCM;NOT WIN32" OFF)',
      after:
        'cmake_dependent_option(USE_ROCM_CK_SDPA "Use ROCm Composable Kernel for SDPA" ON "USE_ROCM" OFF)',
    },
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

  applyPoints(path.join(root, "aten/src/ATen/Context.cpp"), [
    {
      name: "ck-sdpa-gfx12-arch-list",
      before: '"gfx942", "gfx950",',
      after: `"gfx942", "gfx950", ${gpuArchCpp},`,
    },
  ]);

  applyPoints(
    path.join(root, "aten/src/ATen/native/transformers/hip/flash_attn/ck/launch_kernel_pt.hpp"),
    [
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
  copyFileSync(addMakeKernelPtSrc, addMakeKernelPtDst);
  console.log(`  OK ck-add-make-kernel-pt-py: copied to ${addMakeKernelPtDst}`);

  const ckCmake = path.join(ckDir, "CMakeLists.txt");
  applyPoints(ckCmake, buildCkCmakePoints(ckTargets, ckOptDim, disableBwd));

  const atenCmake = path.join(root, "aten/src/ATen/CMakeLists.txt");
  const atenPoints: PatchPoint[] = [
    {
      name: "aten-ck-sdpa-arch-detect-foreach",
      before: `      set(_have_ck_sdpa_arch FALSE)
      foreach(ARCH gfx942 gfx950)`,
      after: `      set(_have_ck_sdpa_arch FALSE)
      foreach(ARCH gfx942 gfx950 ${gpuArchCmake})`,
    },
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
