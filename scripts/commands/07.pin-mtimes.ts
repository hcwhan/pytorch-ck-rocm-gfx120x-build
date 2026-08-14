import { statSync } from "node:fs";
import path from "node:path";
import { pinMtimes } from "../lib/pin-mtimes.js";
import { getRocmSdkPaths } from "../lib/rocm-sdk-paths.js";
import { requireLockEnv } from "../lib/require-env.js";

export function runPinMtimes(options: { ptSrc: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  const commitDate = requireLockEnv("PYTORCH_BUILD_COMMIT_DATE");
  const epochSeconds = Number(requireLockEnv("SOURCE_DATE_EPOCH"));
  console.log(
    `Pinning worktree mtimes under ${ptSrc} to SOURCE_DATE_EPOCH=${epochSeconds} (${commitDate})`,
  );

  // Pin ROCm SDK external headers (clang internal headers, ROCm/HIP headers).
  // These are installed via pip toolchain cache and have mtime newer than the
  // cached .obj files, causing ninja to mark all edges dirty
  // ("output older than most recent input yvals_core.h").
  // Pinning them to SOURCE_DATE_EPOCH makes .obj (from cache, ~build time)
  // newer than all inputs, satisfying ninja's dirty check 1.
  const { coreRoot, develRoot } = getRocmSdkPaths();
  const clangInclude = path.join(coreRoot, "lib", "llvm", "lib", "clang");
  const rocmInclude = path.join(develRoot, "include");
  const externalDirs = [clangInclude, rocmInclude];

  console.log(`Pinning external headers: ${externalDirs.join(", ")}`);

  const startedAt = Date.now();
  const { files, directories } = pinMtimes({
    ptSrc,
    epochSeconds,
    externalDirs,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `Worktree mtime pin complete: ${files} files, ${directories} directories (${elapsedSec}s)`,
  );
}
