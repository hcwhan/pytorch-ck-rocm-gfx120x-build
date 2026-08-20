
import { appendGithubEnv } from "./github.js";


// 导出 ccache 目录与压缩开关到 GITHUB_ENV / 当前进程
export function exportCcacheEnv(runnerTemp: string): void {
  const ccacheDir = `${runnerTemp}/ccache`;

  appendGithubEnv({
    CCACHE_DIR: ccacheDir,
    CCACHE_COMPRESS: "true",
  });

  process.env.CCACHE_DIR = ccacheDir;
  process.env.CCACHE_COMPRESS = "true";
}
