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

export function runPatch(options: { ptSrc: string }): void {
  const root = path.resolve(options.ptSrc);
  const ckTargets = requireLockEnv("CK_TARGETS");
  const ckOptDim = requireLockEnv("CK_OPT_DIM");
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
      name: "msvc-link-brepro",
      before:
        ' string(APPEND ${flag_var} " /ignore:4049 /ignore:4217 /ignore:4099")',
      after:
        ' string(APPEND ${flag_var} " /ignore:4049 /ignore:4217 /ignore:4099 /Brepro")',
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

  applyPoints(path.join(root, "aten/src/ATen/CMakeLists.txt"), [
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
  ]);

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
  applyPoints(ckCmake, [
    {
      name: "ck-codegen-list-optdim",
      before: `COMMAND \${CK_FMHA_GENERATE} --optdim=${ckOptDim}`,
      after: `COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --optdim=${ckOptDim}`,
      replaceAll: true,
    },
    {
      name: "ck-codegen-list-bwd",
      before: `  COMMAND \${CK_FMHA_GENERATE}
  --api bwd --optdim=${ckOptDim}`,
      after: `  COMMAND \${CK_FMHA_GENERATE} ${ckTargets}
  --api bwd --optdim=${ckOptDim}`,
    },
    {
      name: "ck-codegen-emit-fwd-result",
      before: `execute_process(COMMAND \${CK_FMHA_GENERATE} --api fwd --optdim=${ckOptDim} --receipt 4 --filter "*_lse*ntrload*nsink*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
)

if(ret AND NOT ret EQUAL 0)
 message( FATAL_ERROR "CK Tile FMHA FAILED to generate FWD kernels.")
endif()`,
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api fwd --optdim=${ckOptDim} --receipt 4 --filter "*_lse*ntrload*nsink*" --output_dir \${CMAKE_CURRENT_LIST_DIR}
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
      name: "ck-make-kernel-pt-bwd-python",
      before: `execute_process(
 COMMAND bash -c "\${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.sh \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt"
 RESULT_VARIABLE ret)`,
      after: `execute_process(
 COMMAND \${Python3_EXECUTABLE} \${CMAKE_CURRENT_LIST_DIR}/add_make_kernel_pt.py \${CMAKE_CURRENT_LIST_DIR}/bwd_blob_list.txt
 RESULT_VARIABLE ret)`,
    },
  ]);

  console.log(
    `Patched pytorch source at ${root} for gfx120x CK SDPA (GPU_ARCHS=${gpuArchCmake}, CK_TARGETS=${ckTargets})`,
  );
}
