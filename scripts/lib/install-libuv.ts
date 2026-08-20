
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { run } from "./exec.js";
import { appendGithubEnv, appendGithubPath } from "./github.js";
import { withRetrySync } from "./retry.js";
import { LIBUV_DOWNLOAD_URL } from "./windows-toolchain-pins.js";
import { prependProcessPath } from "./windows-path.js";


// 解析 libuv 解压后的根目录（含 Library 子目录时取其路径）
function resolveLibuvRoot(installRoot: string): string {
  const libraryRoot = path.join(installRoot, "Library");
  return existsSync(libraryRoot) ? libraryRoot : installRoot;
}

// 校验 libuv 必需文件存在
function assertLibuvLayout(libuvRoot: string): void {
  const uvDll = path.join(libuvRoot, "bin", "uv.dll");
  const uvLib = path.join(libuvRoot, "lib", "uv.lib");
  const uvHeader = path.join(libuvRoot, "include", "uv.h");

  if (!existsSync(uvDll) || !existsSync(uvLib) || !existsSync(uvHeader)) {
    throw new Error(`libuv components missing in ${libuvRoot}`);
  }
}

// 下载并解压 libuv 预编译包，写入 env / PATH
export function installLibuv(runnerTemp: string): void {
  const installRoot = path.join(runnerTemp, "libuv");
  mkdirSync(installRoot, { recursive: true });

  const archivePath = path.join(runnerTemp, "libuv.tar.bz2");
  const tarPath = path.join(runnerTemp, "libuv.tar");

  withRetrySync({
    label: "curl libuv",
    try: 3,
    delayMs: 5_000,
    do: () => {
      console.log("Downloading libuv…");
      run("curl.exe", ["-fsSL", "-k", LIBUV_DOWNLOAD_URL, "-o", archivePath]);
      if (!existsSync(archivePath)) {
        throw new Error(`libuv archive missing after download: ${archivePath}`);
      }
    },
  });

  run("7z.exe", ["x", "-aoa", archivePath, `-o${runnerTemp}`]);
  run("tar.exe", ["-xf", tarPath, "-C", installRoot]);

  const libuvRoot = resolveLibuvRoot(installRoot);
  assertLibuvLayout(libuvRoot);

  const libuvBin = path.join(libuvRoot, "bin");
  console.log(`OK libuv ready at ${libuvRoot}`);

  appendGithubEnv({
    libuv_ROOT: libuvRoot,
    LIBUV_ROOT: libuvRoot,
  });
  appendGithubPath(libuvBin);

  process.env.libuv_ROOT = libuvRoot;
  process.env.LIBUV_ROOT = libuvRoot;
  prependProcessPath(libuvBin);
}
