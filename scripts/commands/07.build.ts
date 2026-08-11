import { statSync } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";
import { requireGithubActionsEnv } from "../lib/require-env.js";

const PYTHON = "python";

function resolveWorktreeCacheUsed(): boolean {
  const used = requireGithubActionsEnv("WORKTREE_CACHE_USED");
  if (used !== "true" && used !== "false") {
    throw new Error(
      `WORKTREE_CACHE_USED must be 'true' or 'false', got ${used}`,
    );
  }
  return used === "true";
}

export function runBuild(options: { ptSrc: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  initBuildEnv({ ptSrc });

  const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
  const ninjaInstall = resolveWorktreeCacheUsed();

  if (ninjaInstall) {
    const maxJobs = requireMaxJobs();
    console.log(
      `WORKTREE_CACHE_USED=true: ninja-install (skip setup.py build) -j ${maxJobs}`,
    );
    run(PYTHON, [
      buildScript,
      "--step",
      "ninja-install",
      "--pt-src",
      ptSrc,
      "-j",
      String(maxJobs),
      "-v",
    ]);
  } else {
    console.log("WORKTREE_CACHE_USED=false: setup.py build");
    run(PYTHON, [buildScript, "--step", "build", "--pt-src", ptSrc, "-v"]);
  }

  if (process.env.CCACHE_DIR?.trim()) {
    run("ccache", ["--show-stats"]);
  }

  console.log("PyTorch build step complete");
}
