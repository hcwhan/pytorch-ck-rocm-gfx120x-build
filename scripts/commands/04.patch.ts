import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  const ckTargets = "--targets gfx9,gfx950,gfx12";
  const ckOptDim = requireLockEnv("CK_OPT_DIM");

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
      after: '"gfx942", "gfx950", "gfx1200", "gfx1201",',
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
          "#if (defined(__gfx90a__) || defined(__gfx942__) || defined(__gfx950__) || \\\n defined(__gfx1200__) || defined(__gfx1201__))",
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
      foreach(ARCH gfx942 gfx950 gfx1200 gfx1201)`,
    },
    {
      name: "aten-ck-sdpa-hip-arches-foreach",
      before: `    foreach(ARCH gfx942 gfx950)
      if("\${ARCH}" IN_LIST PYTORCH_ROCM_ARCH)
        list(APPEND _ck_sdpa_hip_arches \${ARCH})`,
      after: `    foreach(ARCH gfx942 gfx950 gfx1200 gfx1201)
      if("\${ARCH}" IN_LIST PYTORCH_ROCM_ARCH)
        list(APPEND _ck_sdpa_hip_arches \${ARCH})`,
    },
  ]);

  const ckCmake = path.join(
    root,
    "aten/src/ATen/native/transformers/hip/flash_attn/ck/CMakeLists.txt",
  );
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
      name: "ck-codegen-emit-api",
      before: 'execute_process(COMMAND ${CK_FMHA_GENERATE} --api',
      after: `execute_process(COMMAND \${CK_FMHA_GENERATE} ${ckTargets} --api`,
      replaceAll: true,
    },
  ]);

  console.log(`Patched pytorch source at ${root} for gfx1201 CK SDPA`);
}
