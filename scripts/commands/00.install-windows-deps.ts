
import { exportCcacheEnv } from "../lib/export-ccache-env.js";
import { installCcache } from "../lib/install-ccache.js";
import { installLibuv } from "../lib/install-libuv.js";
import { requireGithubActionsEnv } from "../lib/require-env.js";


// 安装 ccache + libuv，并导出 CCACHE_* env（Windows CI bootstrap）
export async function runInstallWindowsDeps(): Promise<void> {
  const runnerTemp = requireGithubActionsEnv("RUNNER_TEMP");

  await installCcache(runnerTemp);
  exportCcacheEnv(runnerTemp);
  installLibuv(runnerTemp);
}
