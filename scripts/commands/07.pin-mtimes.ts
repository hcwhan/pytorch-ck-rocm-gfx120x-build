import { statSync } from "node:fs";
import path from "node:path";
import { pinMtimes } from "../lib/pin-mtimes.js";
import { requireLockEnv } from "../lib/require-env.js";

export function runPinMtimes(options: { ptSrc: string }): void {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  const commitDate = requireLockEnv("PYTORCH_BUILD_COMMIT_DATE");
  const epochSeconds = Number(requireLockEnv("SOURCE_DATE_EPOCH"));
  console.log(
    `Pinning worktree mtimes under ${ptSrc} to pytorch.build_commit_date=${commitDate}`,
  );

  const startedAt = Date.now();
  const { files, directories } = pinMtimes({
    ptSrc,
    epochSeconds,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `Worktree mtime pin complete: ${files} files, ${directories} directories (${elapsedSec}s)`,
  );
}
