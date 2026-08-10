import { appendGithubEnv } from "../lib/github.js";
import {
  readVersionLock,
  versionLockEnvRecord,
} from "../lib/version-lock.js";

export function runConfig(options: {
  workspaceRoot: string;
  exportGithubEnv?: boolean;
}): void {
  if (process.env.GITHUB_ENV && !options.exportGithubEnv) {
    throw new Error(
      "01.config must be called with --export-github-env when GITHUB_ENV is set",
    );
  }

  const vars = readVersionLock(options.workspaceRoot);

  if (options.exportGithubEnv) {
    appendGithubEnv(versionLockEnvRecord(vars));
  }
}
