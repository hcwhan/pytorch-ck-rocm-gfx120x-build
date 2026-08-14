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
    // Worktree 命中且 build.ninja 存在 → 先 stamp 预构建对象再 ninja -C。
    // stamp 将 .obj mtime 与 .ninja_log entry mtime 统一设为未来值，
    // 使 ninja 的两条 dirty 检查（obj.mtime >= input, log.mtime >= input）
    // 同时通过，实现真正的续编而非重编。
    const stampScript = path.join(resolveBuildDir(), "stamp-prebuilt.py");
    console.log("Stamping prebuilt objects before ninja resume...");
    run(PYTHON, [stampScript, "--pt-src", ptSrc]);

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
