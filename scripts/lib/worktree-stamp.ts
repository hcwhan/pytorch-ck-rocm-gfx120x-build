import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const WORKTREE_STAMP_FILE = ".worktree-stamp.json";

const worktreeStampSchema = z.object({
  lock_hash8: z.string().length(8),
  patch_hash8: z.string().length(8),
  wheel_hash8: z.string().length(8),
  repo: z.string().min(1),
  build_commit: z.string().min(1),
  build_commit_date: z.string().min(1),
  resolved_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-character git commit SHA"),
});

type WorktreeStamp = z.infer<typeof worktreeStampSchema>;

const REQUIRED_PATHS = [
  "version.txt",
  "c10/hip/impl/hip_cmake_macros.h.in",
  "aten/src/THH",
  "build/build.ninja",
] as const;

function worktreeStampPath(ptSrc: string): string {
  return path.join(path.resolve(ptSrc), WORKTREE_STAMP_FILE);
}

export function writeWorktreeStamp(ptSrc: string, stamp: WorktreeStamp): void {
  writeFileSync(
    worktreeStampPath(ptSrc),
    `${JSON.stringify(stamp, null, 2)}\n`,
    "utf8",
  );
}

export function readWorktreeStamp(ptSrc: string): WorktreeStamp | null {
  const stampPath = worktreeStampPath(ptSrc);
  if (!existsSync(stampPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }

  const result = worktreeStampSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function isValidWorktreeTree(ptSrc: string): boolean {
  const root = path.resolve(ptSrc);
  for (const rel of REQUIRED_PATHS) {
    try {
      statSync(path.join(root, rel));
    } catch {
      return false;
    }
  }
  return true;
}

export function verifyWorktreeStampAgainstKey(
  stamp: WorktreeStamp,
  expected: {
    lockHash8: string;
    patchHash8: string;
    wheelHash8: string;
    repo: string;
    buildCommit: string;
    buildCommitDate: string;
  },
): boolean {
  return (
    stamp.lock_hash8 === expected.lockHash8 &&
    stamp.patch_hash8 === expected.patchHash8 &&
    stamp.wheel_hash8 === expected.wheelHash8 &&
    stamp.repo === expected.repo &&
    stamp.build_commit === expected.buildCommit &&
    stamp.build_commit_date === expected.buildCommitDate
  );
}
