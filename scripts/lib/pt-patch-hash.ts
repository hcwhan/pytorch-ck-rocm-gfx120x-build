import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** patch / hipify / codegen 输入变更会使 worktree cache 与 ccache 失效。 */
const PATCH_INPUT_PATHS = [
  "scripts/commands/04.patch.ts",
  "scripts/lib/windows-clang-warning-flags.ts",
  "scripts/commands/05.hipify.ts",
  "scripts/lib/gpu-archs.ts",
  "build/add-make-kernel-pt.py",
] as const;

export function buildPatchHash8(workspaceRoot: string): string {
  const hash = createHash("sha256");
  for (const rel of PATCH_INPUT_PATHS) {
    const abs = path.join(workspaceRoot, rel);
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(abs));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 8);
}
