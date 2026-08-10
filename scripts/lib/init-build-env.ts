import path from "node:path";
import { run } from "./exec.js";
import { requireMaxJobs } from "./max-jobs.js";
import { getRocmSdkPaths } from "./rocm-sdk-paths.js";
import { requireLockEnv } from "./require-env.js";

const PYTHON = "python";

export function initBuildEnv(options: {
  ptSrc: string;
  installRequirements?: boolean;
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
  process.env.CMAKE_ARGS =
    "-DUSE_ROCM_CK_SDPA=ON -DUSE_ROCM_CK_GEMM=OFF -DBUILD_TEST=OFF";
  process.env.PYTORCH_BUILD_VERSION = wheelLocalVersion;

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
  process.env.CC = "clang-cl";
  process.env.CXX = "clang-cl";

  console.log(`MAX_JOBS=${maxJobs}`);
  console.log(`PYTORCH_ROCM_ARCH=${process.env.PYTORCH_ROCM_ARCH}`);
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

  console.log("Build env ready");
}
