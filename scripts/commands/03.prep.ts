import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { run, runCapture } from "../lib/exec.js";
import { appendGithubOutput } from "../lib/github.js";
import {
  isPreparedSourceTree,
  readPrepStamp,
  verifyPrepStampAgainstLock,
  writePrepStamp,
} from "../lib/pt-prep-stamp.js";
import { requireLockEnv } from "../lib/require-env.js";

function configureGitFetchParallelism(): void {
  run("git", ["config", "--global", "fetch.parallel", "0"]);
  run("git", ["config", "--global", "submodule.fetchJobs", "0"]);
}

function maybeAppendPrepOutput(cloned: boolean): void {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  appendGithubOutput({ cloned: cloned ? "true" : "false" });
}

export function runPrep(options: { ptSrc: string; useCache?: boolean }): void {
  const pytorchRepo = requireLockEnv("PYTORCH_REPO");
  const pytorchBuildCommit = requireLockEnv("PYTORCH_BUILD_COMMIT");
  const pytorchBuildCommitDate = requireLockEnv("PYTORCH_BUILD_COMMIT_DATE");
  const root = path.resolve(options.ptSrc);

  console.log(`Using pytorch repo: ${pytorchRepo}`);
  console.log(`Using pytorch build ref: ${pytorchBuildCommit}`);

  if (options.useCache) {
    const stamp = readPrepStamp(root);
    if (
      stamp &&
      verifyPrepStampAgainstLock(stamp, {
        repo: pytorchRepo,
        buildCommit: pytorchBuildCommit,
        buildCommitDate: pytorchBuildCommitDate,
      }) &&
      isPreparedSourceTree(root)
    ) {
      console.log(
        `Prep stamp valid, skipping clone (commit=${stamp.resolved_commit})`,
      );
      maybeAppendPrepOutput(false);
      return;
    }
    if (stamp) {
      console.log(
        "Prep stamp invalid or lock mismatch; re-cloning pytorch source",
      );
    }
  }

  configureGitFetchParallelism();

  const parent = path.dirname(root);
  mkdirSync(parent, { recursive: true });
  rmSync(root, { recursive: true, force: true });

  run("git", [
    "-c",
    "core.longpaths=true",
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    pytorchRepo,
    root,
  ]);
  run("git", [
    "-c",
    "core.longpaths=true",
    "-C",
    root,
    "fetch",
    "--depth",
    "1",
    "origin",
    pytorchBuildCommit,
  ]);
  run("git", ["-C", root, "config", "core.longpaths", "true"]);
  run("git", [
    "-c",
    "core.longpaths=true",
    "-C",
    root,
    "checkout",
    "FETCH_HEAD",
  ]);

  run("git", [
    "-c",
    "core.longpaths=true",
    "-C",
    root,
    "submodule",
    "update",
    "--init",
    "--recursive",
    "--depth",
    "1",
    "--filter=blob:none",
  ]);

  const resolvedCommit = runCapture("git", [
    "-C",
    root,
    "rev-parse",
    "HEAD",
  ]).trim();
  if (!resolvedCommit) {
    throw new Error(
      `prep: failed to resolve HEAD after checkout of ${pytorchBuildCommit}`,
    );
  }

  const gitAuthorDate = runCapture("git", [
    "-C",
    root,
    "log",
    "-1",
    "--format=%aI",
  ]).trim();
  if (!gitAuthorDate) {
    throw new Error(
      `prep: failed to read author date for ref ${pytorchBuildCommit} (${resolvedCommit})`,
    );
  }

  const gitAuthorMs = Date.parse(gitAuthorDate);
  const lockCommitMs = Date.parse(pytorchBuildCommitDate);
  if (Number.isNaN(gitAuthorMs) || Number.isNaN(lockCommitMs)) {
    throw new Error(
      `prep: failed to parse commit author date '${gitAuthorDate}' or lock date '${pytorchBuildCommitDate}'`,
    );
  }
  if (gitAuthorMs !== lockCommitMs) {
    throw new Error(
      [
        `pytorch.build_commit_date mismatch for ref ${pytorchBuildCommit} (${resolvedCommit}).`,
        ` lock=${pytorchBuildCommitDate} git author=${gitAuthorDate}`,
        " Update VERSION.lock.json when bumping pytorch.build_commit.",
      ].join(""),
    );
  }

  console.log(
    `Commit author date OK: ${gitAuthorDate} (lock=${pytorchBuildCommitDate})`,
  );

  writePrepStamp(root, {
    repo: pytorchRepo,
    build_commit: pytorchBuildCommit,
    build_commit_date: pytorchBuildCommitDate,
    resolved_commit: resolvedCommit,
  });

  rmSync(path.join(root, ".git"), { recursive: true, force: true });

  console.log(
    `Prepared pytorch at ${root} (ref=${pytorchBuildCommit}, commit=${resolvedCommit})`,
  );
  maybeAppendPrepOutput(true);
}
