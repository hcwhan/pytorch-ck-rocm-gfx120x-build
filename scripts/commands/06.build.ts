import { statSync } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
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

  const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
  run(PYTHON, [buildScript, "--step", "build", "--pt-src", ptSrc, "-v"]);
  console.log("PyTorch build step complete");
}
