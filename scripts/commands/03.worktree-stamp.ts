import { readPrepStamp } from "../lib/pt-prep-stamp.js";
import { buildPatchHash8 } from "../lib/pt-patch-hash.js";
import {
  isValidWorktreeTree,
  readWorktreeStamp,
  verifyWorktreeStampAgainstKey,
  writeWorktreeStamp,
} from "../lib/worktree-stamp.js";
import { requireLockEnv } from "../lib/require-env.js";
import {
  versionLockFileHash8,
  wheelLockHash8,
} from "../lib/version-lock.js";

export function runWorktreeStampWrite(options: {
  ptSrc: string;
  workspaceRoot: string;
}): void {
  const prepStamp = readPrepStamp(options.ptSrc);
  if (!prepStamp) {
    throw new Error(
      "worktree-stamp write: missing .pt-prep-stamp.json; run 03.prep first",
    );
  }

  const lockHash8 = versionLockFileHash8(options.workspaceRoot);
  const patchHash8 = buildPatchHash8(options.workspaceRoot);
  const wheelHash = wheelLockHash8(options.workspaceRoot);

  writeWorktreeStamp(options.ptSrc, {
    lock_hash8: lockHash8,
    patch_hash8: patchHash8,
    wheel_hash8: wheelHash,
    repo: prepStamp.repo,
    build_commit: prepStamp.build_commit,
    build_commit_date: prepStamp.build_commit_date,
    resolved_commit: prepStamp.resolved_commit,
  });

  console.log(
    `Wrote worktree stamp at ${options.ptSrc} (lock=${lockHash8} patch=${patchHash8} wheel=${wheelHash})`,
  );
}

export function runWorktreeStampVerify(options: {
  ptSrc: string;
  workspaceRoot: string;
}): void {
  const stamp = readWorktreeStamp(options.ptSrc);
  const lockHash8 = versionLockFileHash8(options.workspaceRoot);
  const patchHash8 = buildPatchHash8(options.workspaceRoot);
  const wheelHash = wheelLockHash8(options.workspaceRoot);

  const expected = {
    lockHash8,
    patchHash8,
    wheelHash8: wheelHash,
    repo: requireLockEnv("PYTORCH_REPO"),
    buildCommit: requireLockEnv("PYTORCH_BUILD_COMMIT"),
    buildCommitDate: requireLockEnv("PYTORCH_BUILD_COMMIT_DATE"),
  };

  if (
    !stamp ||
    !verifyWorktreeStampAgainstKey(stamp, expected) ||
    !isValidWorktreeTree(options.ptSrc)
  ) {
    throw new Error(
      "worktree-stamp verify failed: restored worktree missing stamp, lock/patch/wheel mismatch, or incomplete tree",
    );
  }

  console.log(
    `Worktree stamp valid, using cached tree (commit=${stamp.resolved_commit})`,
  );
}
