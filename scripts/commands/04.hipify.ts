import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";

const PYTHON = "python";

const HIPIFY_OUTPUTS = [
  "c10/hip/impl/hip_cmake_macros.h.in",
  "aten/src/ATen/hip/HIPConfig.h.in",
  "aten/src/THH",
] as const;

export function runHipify(options: { ptSrc: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  const buildAmd = path.join(ptSrc, "tools", "amd_build", "build_amd.py");
  if (!existsSync(buildAmd)) {
    throw new Error(`build_amd.py not found: ${buildAmd}`);
  }

  console.log(`Running HIPIFY (build_amd.py) in ${ptSrc}`);
  run(PYTHON, [buildAmd], { quiet: false });

  for (const rel of HIPIFY_OUTPUTS) {
    const abs = path.join(ptSrc, rel);
    if (!existsSync(abs)) {
      throw new Error(`hipify: expected output missing after build_amd.py: ${rel}`);
    }
    console.log(`  OK hipify output: ${rel}`);
  }

  console.log(`HIPIFY complete at ${ptSrc}`);
}
