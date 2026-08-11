import { assertBootstrapCompleteWorktree } from "../lib/worktree-bootstrap.js";

export function runVerifyBootstrap(options: { ptSrc: string }): void {
  assertBootstrapCompleteWorktree(options.ptSrc);
  console.log("Worktree bootstrap valid (prep + patch + hipify)");
}
