import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { run, runCapture } from "../lib/exec.js";
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

    // Diagnostic: dry-run explain to see why edges are dirty (or clean).
    // Non-fatal: if ninja explain fails, we still proceed to the real build.
    try {
      const explain = runCapture("ninja", [
        "-d", "explain", "-n", "-C", buildDir, "install",
      ]);
      const lines = explain.split("\n");
      console.log(
        `=== ninja -d explain -n (${lines.length} lines, showing first 50) ===`,
      );
      for (const line of lines.slice(0, 50)) {
        console.log(line);
      }
      if (lines.length > 50) {
        console.log(`... (${lines.length - 50} more lines)`);
      }
      console.log("=== end explain ===");
    } catch (e) {
      console.log(`ninja -d explain -n failed (non-fatal): ${e}`);
    }
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
