
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { run } from "./exec.js";
import { appendGithubPath } from "./github.js";
import { withRetrySync } from "./retry.js";
import { CCACHE_VERSION } from "./windows-toolchain-pins.js";
import { prependProcessPath, refreshWindowsPathFromRegistry } from "./windows-path.js";


// 递归查找首个匹配文件名的绝对路径
export function findFileByName(rootDir: string, fileName: string): string | null {
  for (const entry of readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const nested = findFileByName(fullPath, fileName);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (stat.isFile() && entry === fileName) {
      return fullPath;
    }
  }
  return null;
}

// 下载 URL 到本地文件
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败：${url}（HTTP ${response.status}）`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
}

// choco 安装 ccache；成功返回 true
function tryInstallCcacheViaChoco(): boolean {
  withRetrySync({
    label: "choco install ccache",
    try: 3,
    delayMs: 15_000,
    do: () => {
      run("choco", [
        "install",
        "ccache",
        `--version=${CCACHE_VERSION}`,
        "--no-progress",
        "-y",
      ]);
    },
  });
  return true;
}

// GitHub release zip fallback 安装 ccache
async function installCcacheFromGitHubRelease(runnerTemp: string): Promise<string> {
  console.log(
    `choco 不可用；从 GitHub release 安装 ccache v${CCACHE_VERSION}`,
  );

  const installRoot = path.join(runnerTemp, "ccache-bin");
  mkdirSync(installRoot, { recursive: true });

  const zipUrl =
    `https://github.com/ccache/ccache/releases/download/v${CCACHE_VERSION}/` +
    `ccache-${CCACHE_VERSION}-windows-x86_64.zip`;
  const zipPath = path.join(
    runnerTemp,
    `ccache-${CCACHE_VERSION}-windows-x86_64.zip`,
  );

  await downloadFile(zipUrl, zipPath);
  run("tar", ["-xf", zipPath, "-C", installRoot]);

  const ccacheExe = findFileByName(installRoot, "ccache.exe");
  if (!ccacheExe) {
    throw new Error(
      `ccache.exe not found under ${installRoot} after GitHub release extract`,
    );
  }

  return path.dirname(ccacheExe);
}

// 安装 ccache 并写入 PATH（choco 优先，失败则 GitHub release）
export async function installCcache(runnerTemp: string): Promise<void> {
  let usedChoco = false;

  try {
    usedChoco = tryInstallCcacheViaChoco();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`choco 安装 ccache 失败，改用 GitHub release：${message}`);
    const ccacheDir = await installCcacheFromGitHubRelease(runnerTemp);
    appendGithubPath(ccacheDir);
    prependProcessPath(ccacheDir);
  }

  if (usedChoco) {
    refreshWindowsPathFromRegistry();
  }

  run("ccache", ["--version"]);
}
