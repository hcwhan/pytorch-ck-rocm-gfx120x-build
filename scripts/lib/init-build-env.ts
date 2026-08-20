import { readFileSync } from "node:fs";
import path from "node:path";

import { run } from "./exec.js";
import { appendGithubEnv } from "./github.js";
import { CMAKE_CONFIGURE_QUIET_FLAGS } from "./cmake-configure-quiet-flags.js";
import { requireMaxJobs } from "./max-jobs.js";
import { getRocmSdkPaths } from "./rocm-sdk-paths.js";
import { requireLockEnv } from "./require-env.js";
import { WINDOWS_CLANG_WARNING_SUPPRESS_FLAGS } from "./windows-clang-warning-flags.js";

const PYTHON = "python";

// initBuildEnv 写入或覆盖的 env 键（供 export 至 GITHUB_ENV）
const BUILD_ENV_VAR_NAMES = [
  "MAX_JOBS",
  "USE_ROCM",
  "USE_KINETO",
  "USE_DISTRIBUTED",
  "USE_ROCM_CK_SDPA",
  "PYTORCH_ROCM_ARCH",
  "DISTUTILS_USE_SDK",
  "BUILD_TEST",
  "USE_CUDA",
  "USE_FLASH_ATTENTION",
  "USE_MEM_EFF_ATTENTION",
  "SOURCE_DATE_EPOCH",
  "TORCH_CUDA_ARCH_LIST",
  "CMAKE_BUILD_TYPE",
  "CMAKE_SUPPRESS_REGENERATION",
  "CMAKE_ARGS",
  "PYTORCH_BUILD_VERSION",
  "PYTORCH_BUILD_NUMBER",
  "ROCM_HOME",
  "ROCM_PATH",
  "HIP_PATH",
  "HIP_INCLUDE_PATH",
  "HIP_DEVICE_LIB_PATH",
  "DEVICE_LIB_PATH",
  "CPATH",
  "INCLUDE",
  "PATH",
  "libuv_ROOT",
  "LIBUV_ROOT",
  "LIB",
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "CMAKE_C_COMPILER_LAUNCHER",
  "CMAKE_CXX_COMPILER_LAUNCHER",
  "CCACHE_DIR",
  "CCACHE_COMPRESS",
  "CCACHE_BASEDIR",
  "CCACHE_SLOPPINESS",
  "CCACHE_MAXSIZE",
] as const;

// setup-msvc-dev / vcvarsall 写入、compile/wheel 需跨 step 继承的 MSVC/SDK 变量（仅 export 已存在项）
const PASSTHROUGH_MSVC_ENV_VAR_NAMES = [
  "CL",
  "_CL_",
  "LINK",
  "_LINK_",
  "ExternalIncludePath",
  "VCToolsInstallDir",
  "VCToolsRedistDir",
  "VCToolsVersion",
  "VCINSTALLDIR",
  "VSINSTALLDIR",
  "LIBPATH",
  "UniversalCRTSdkDir",
  "UCRTVersion",
  "WindowsLibPath",
  "WindowsSdkBinPath",
  "WindowsSdkDir",
  "WindowsSDKLibVersion",
  "WindowsSDKVersion",
] as const;

function normalizePathListEntry(entry: string): string {
  return entry.toLowerCase().replace(/\\/g, "/");
}

function assertMsvcSdkPathListEnv(name: string, value: string): void {
  const normalized = normalizePathListEntry(value);
  const hasMsvcSdk =
    normalized.includes("microsoft visual studio") ||
    normalized.includes("windows kits") ||
    normalized.includes("/vc/tools/");
  if (!hasMsvcSdk) {
    throw new Error(
      `exportGithubEnv: ${name} must include MSVC/SDK paths from setup-msvc-dev (bootstrap); check A00 Setup MSVC ran before 08.prepare`,
    );
  }
}

function assertPathListContainsDir(name: string, dir: string): void {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `exportGithubEnv: ${name} must be set when libuv is configured (initBuildEnv prepend)`,
    );
  }
  const normalizedDir = normalizePathListEntry(dir);
  if (
    !value
      .split(";")
      .map((entry) => normalizePathListEntry(entry.trim()))
      .some((entry) => entry === normalizedDir || entry.startsWith(`${normalizedDir}/`))
  ) {
    throw new Error(
      `exportGithubEnv: ${name} must include libuv path ${dir}`,
    );
  }
}

function prependPathListEnv(name: string, prefix: string): void {
  const current = process.env[name];
  process.env[name] = current ? `${prefix};${current}` : prefix;
}

function assertBuildEnvExportComplete(): void {
  for (const name of BUILD_ENV_VAR_NAMES) {
    if (process.env[name] === undefined) {
      throw new Error(
        `exportGithubEnv: ${name} must be set by initBuildEnv before export`,
      );
    }
  }
}

// 将编译 env 追加至 GITHUB_ENV（供后续 watchdog/run spawn 继承）
function exportBuildEnvToGithub(): void {
  const ccacheDir = process.env.CCACHE_DIR?.trim();
  if (!ccacheDir) {
    throw new Error(
      "CCACHE_DIR must be set before exportGithubEnv (00.install-windows-deps / exportCcacheEnv in A00 bootstrap)",
    );
  }
  if (!process.env.CCACHE_COMPRESS?.trim()) {
    throw new Error(
      "CCACHE_COMPRESS must be set before exportGithubEnv (00.install-windows-deps / exportCcacheEnv in A00 bootstrap)",
    );
  }

  const include = process.env.INCLUDE?.trim();
  const lib = process.env.LIB?.trim();
  if (!include || !lib) {
    throw new Error(
      "INCLUDE and LIB must be set before exportGithubEnv (setup-msvc-dev in bootstrap)",
    );
  }
  assertMsvcSdkPathListEnv("INCLUDE", include);
  assertMsvcSdkPathListEnv("LIB", lib);

  const libuvRoot = (
    process.env.libuv_ROOT ||
    process.env.LIBUV_ROOT ||
    ""
  ).trim();
  if (libuvRoot) {
    const libuvLib = path.join(libuvRoot, "lib");
    assertPathListContainsDir("LIB", libuvLib);
    assertPathListContainsDir("LIBPATH", libuvLib);
  }

  assertBuildEnvExportComplete();

  const vars: Record<string, string> = {};
  for (const name of [
    ...BUILD_ENV_VAR_NAMES,
    ...PASSTHROUGH_MSVC_ENV_VAR_NAMES,
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      vars[name] = value;
    }
  }
  appendGithubEnv(vars);
}

function applyCcacheEnv(ptSrc: string): void {
  const ccacheDir = process.env.CCACHE_DIR?.trim();
  if (!ccacheDir) {
    return;
  }

  process.env.CMAKE_C_COMPILER_LAUNCHER = "ccache";
  process.env.CMAKE_CXX_COMPILER_LAUNCHER = "ccache";
  process.env.CMAKE_ARGS = `${process.env.CMAKE_ARGS} -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache`;
  process.env.CCACHE_BASEDIR = ptSrc;
  process.env.CCACHE_SLOPPINESS ??=
    "time_macros,include_file_mtime,pch_defines,random_seed";
  process.env.CCACHE_MAXSIZE ??= "3G";

  console.log(`CCACHE_DIR=${ccacheDir}`);
  console.log(`CCACHE_BASEDIR=${process.env.CCACHE_BASEDIR}`);
  run("ccache", ["--zero-stats"], { quiet: true });
}

export function initBuildEnv(options: {
  ptSrc: string;
  installRequirements?: boolean;
  exportGithubEnv?: boolean;
}): void {
  const maxJobs = requireMaxJobs();
  const ptSrc = path.resolve(options.ptSrc);
  const gpuArchs = requireLockEnv("GPU_ARCHS");
  const sourceDateEpoch = requireLockEnv("SOURCE_DATE_EPOCH");
  const wheelLocalVersion = requireLockEnv("WHEEL_LOCAL_VERSION");
  const { coreRoot, develRoot } = getRocmSdkPaths();

  const llvmBin = path.join(coreRoot, "lib", "llvm", "bin");
  const rocmBin = path.join(develRoot, "bin");
  const rocmInclude = path.join(develRoot, "include");
  const deviceLibPath = path.join(coreRoot, "lib", "llvm", "amdgcn", "bitcode");

  process.env.MAX_JOBS = String(maxJobs);
  process.env.USE_ROCM = "1";
  process.env.USE_KINETO = "0";
  process.env.USE_DISTRIBUTED = "1";
  process.env.USE_ROCM_CK_SDPA = "1";
  process.env.PYTORCH_ROCM_ARCH = gpuArchs;
  process.env.DISTUTILS_USE_SDK = "1";
  process.env.BUILD_TEST = "0";
  process.env.USE_CUDA = "0";
  process.env.USE_FLASH_ATTENTION = "ON";
  process.env.USE_MEM_EFF_ATTENTION = "ON";
  process.env.SOURCE_DATE_EPOCH = sourceDateEpoch;
  process.env.TORCH_CUDA_ARCH_LIST = "";
  process.env.CMAKE_BUILD_TYPE = "Release";
  process.env.CMAKE_SUPPRESS_REGENERATION = "ON";
  process.env.CMAKE_ARGS =
    `-DUSE_ROCM_CK_SDPA=ON -DUSE_ROCM_CK_GEMM=OFF -DBUILD_TEST=OFF -DUSE_KINETO=OFF -DUSE_DISTRIBUTED=ON ${CMAKE_CONFIGURE_QUIET_FLAGS}`;

  const versionFile = path.join(ptSrc, "version.txt");
  const baseVersion = readFileSync(versionFile, "utf8").trim();
  if (!baseVersion) {
    throw new Error(`PyTorch base version missing in ${versionFile}`);
  }
  process.env.PYTORCH_BUILD_VERSION = `${baseVersion}+${wheelLocalVersion}`;
  process.env.PYTORCH_BUILD_NUMBER = "1";

  process.env.ROCM_HOME = develRoot;
  process.env.ROCM_PATH = develRoot;
  process.env.HIP_PATH = develRoot;
  process.env.HIP_INCLUDE_PATH = rocmInclude;
  process.env.HIP_DEVICE_LIB_PATH = deviceLibPath;
  process.env.DEVICE_LIB_PATH = deviceLibPath;
  process.env.CPATH = process.env.CPATH
    ? `${rocmInclude};${process.env.CPATH}`
    : rocmInclude;
  process.env.INCLUDE = process.env.INCLUDE
    ? `${rocmInclude};${process.env.INCLUDE}`
    : rocmInclude;
  process.env.PATH = `${llvmBin};${rocmBin};${process.env.PATH ?? ""}`;

  const libuvRoot = (
    process.env.libuv_ROOT ||
    process.env.LIBUV_ROOT ||
    ""
  ).trim();
  if (libuvRoot) {
    process.env.libuv_ROOT = libuvRoot;
    process.env.LIBUV_ROOT = libuvRoot;
    const libuvInclude = path.join(libuvRoot, "include");
    const libuvLib = path.join(libuvRoot, "lib");
    const libuvBin = path.join(libuvRoot, "bin");
    process.env.INCLUDE = process.env.INCLUDE
      ? `${libuvInclude};${process.env.INCLUDE}`
      : libuvInclude;
    process.env.CPATH = process.env.CPATH
      ? `${libuvInclude};${process.env.CPATH}`
      : libuvInclude;
    prependPathListEnv("LIB", libuvLib);
    prependPathListEnv("LIBPATH", libuvLib);
    process.env.PATH = `${libuvBin};${process.env.PATH}`;
  }

  process.env.CC = "clang-cl";
  process.env.CXX = "clang-cl";

  const clangClFlags = `/Brepro ${WINDOWS_CLANG_WARNING_SUPPRESS_FLAGS}`;
  process.env.CFLAGS = process.env.CFLAGS
    ? `${process.env.CFLAGS} ${clangClFlags}`
    : clangClFlags;
  process.env.CXXFLAGS = process.env.CXXFLAGS
    ? `${process.env.CXXFLAGS} ${clangClFlags}`
    : clangClFlags;

  applyCcacheEnv(ptSrc);

  console.log(`MAX_JOBS=${maxJobs}`);
  console.log(`PYTORCH_ROCM_ARCH=${process.env.PYTORCH_ROCM_ARCH}`);
  console.log(`PYTORCH_BUILD_VERSION=${process.env.PYTORCH_BUILD_VERSION}`);
  console.log(`CMAKE_ARGS=${process.env.CMAKE_ARGS}`);

  if (options.installRequirements !== false) {
    run(
      PYTHON,
      [
        "-m",
        "pip",
        "install",
        "-q",
        "-r",
        path.join(ptSrc, "requirements.txt"),
      ],
      { quiet: true },
    );
  }

  if (options.exportGithubEnv) {
    exportBuildEnvToGithub();
  }

  console.log("Build env ready");
}
