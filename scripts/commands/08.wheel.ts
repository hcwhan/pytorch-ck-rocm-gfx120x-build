import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { resolveBuildDir } from "../lib/paths.js";

const PYTHON = "python";

export function runWheel(options: { ptSrc: string; distDir: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  const distDir = path.resolve(options.distDir);

  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  mkdirSync(distDir, { recursive: true });
  initBuildEnv({ ptSrc, installRequirements: false });

  const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
  run(PYTHON, [buildScript, "--step", "wheel", "--pt-src", ptSrc, "-v"]);

  const wheelDir = path.join(ptSrc, "dist");
  const whls = readdirSync(wheelDir).filter((name) => name.endsWith(".whl"));
  if (whls.length !== 1) {
    throw new Error(`Expected exactly one wheel in ${wheelDir}, found ${whls.length}`);
  }

  const src = path.join(wheelDir, whls[0]!);
  const dst = path.join(distDir, whls[0]!);
  copyFileSync(src, dst);
  console.log(`Wheel copied to ${dst}`);
}
