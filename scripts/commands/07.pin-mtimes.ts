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

  // Pin ROCm SDK external headers and import libraries (.lib). Headers and libs
  // are installed via pip toolchain cache and can have mtime newer than cached
  // .obj / .dll outputs, causing ninja mass recompile
  // ("output older than most recent input amdhip64.lib").
  const { coreRoot, develRoot } = getRocmSdkPaths();
  const clangIncludeCore = path.join(coreRoot, "lib", "llvm", "lib", "clang");
  const clangIncludeDevel = path.join(develRoot, "lib", "llvm", "lib", "clang");
  const rocmInclude = path.join(develRoot, "include");
  const rocmLibCore = path.join(coreRoot, "lib");
  const rocmLibDevel = path.join(develRoot, "lib");
  const externalDirs = [
    clangIncludeCore,
    clangIncludeDevel,
    rocmInclude,
    rocmLibCore,
    rocmLibDevel,
  ];

  const libuvRoot = (
    process.env.libuv_ROOT ||
    process.env.LIBUV_ROOT ||
    ""
  ).trim();
  if (libuvRoot) {
    const libuvInclude = path.join(libuvRoot, "include");
    const libuvLib = path.join(libuvRoot, "lib");
    externalDirs.push(libuvInclude, libuvLib);
  }

  console.log(`Pinning external toolchain paths: ${externalDirs.join(", ")}`);

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
