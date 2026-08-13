import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";

const PYTHON = "python";

export function runBuild(options: { ptSrc: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  initBuildEnv({ ptSrc });

  const buildDir = path.join(ptSrc, "build");
  const buildNinja = path.join(buildDir, "build.ninja");
  const cacheHit = process.env.WORKTREE_CACHE_USED === "true";
  const maxJobs = requireMaxJobs();

  if (cacheHit && existsSync(buildNinja)) {
    // Worktree 命中且 build.ninja 存在 → 跳过 CMake 直接 ninja -C，
    // 避免 cmake --build 触发 CMake 检查导致 .ninja_log 作废。这样 ninja
    // 靠 mtime + .ninja_log 跳过已编译对象，实现真正的续编而非重编。
    console.log(
      `Worktree cache hit: ninja -C ${buildDir} install (-j ${maxJobs})`,
    );
    run("ninja", ["-C", buildDir, "install", "-j", String(maxJobs)]);
  } else {
    console.log("Running setup.py build (configure if needed, then cmake build)");
    const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
    run(PYTHON, [buildScript, "--step", "build", "--pt-src", ptSrc, "-v"]);
  }

  if (process.env.CCACHE_DIR?.trim()) {
    run("ccache", ["--show-stats"]);
  }

  console.log("PyTorch build step complete");
}
