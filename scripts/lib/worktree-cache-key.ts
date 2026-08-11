export function buildWorktreeCacheKey(options: {
  lockHash8: string;
  patchHash8: string;
  wheelHash8: string;
  msvcHash: string;
  rocmClangHash: string;
  pipToolchainHash: string;
}): string {
  const toolchain = `msvc${options.msvcHash}-rocmClang${options.rocmClangHash}-pipToolchain${options.pipToolchainHash}`;
  return `worktree-v1-${options.lockHash8}-${options.patchHash8}-${options.wheelHash8}-${toolchain}`;
}
