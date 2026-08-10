import path from "node:path";
import { requireGithubActionsEnv } from "./require-env.js";

export function resolveBuildDir(): string {
  return path.join(requireGithubActionsEnv("GITHUB_WORKSPACE"), "build");
}
