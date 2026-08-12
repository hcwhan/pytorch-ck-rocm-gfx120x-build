import { statSync } from "node:fs";
import path from "node:path";

/** hipify 关键探针路径（prep 后 version.txt 存在；hipify 后其余路径存在；不含 build/）。 */
const BOOTSTRAP_REQUIRED_PATHS = [
  "version.txt",
  "c10/hip/impl/hip_cmake_macros.h.in",
  "aten/src/ATen/hip/HIPConfig.h.in",
  "aten/src/THH",
] as const;

function isBootstrapCompleteWorktree(ptSrc: string): boolean {
  const root = path.resolve(ptSrc);
  for (const rel of BOOTSTRAP_REQUIRED_PATHS) {
    try {
      statSync(path.join(root, rel));
    } catch {
      return false;
    }
  }
  return true;
}

export function assertBootstrapCompleteWorktree(ptSrc: string): void {
  if (!isBootstrapCompleteWorktree(ptSrc)) {
    throw new Error(
      "worktree bootstrap verify failed: missing hipify probe artifacts",
    );
  }
}
