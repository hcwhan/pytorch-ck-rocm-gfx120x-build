export function buildCcacheCacheKey(options: {
  lockHash8: string;
  patchHash8: string;
  msvcHash: string;
  rocmClangHash: string;
  pipToolchainHash: string;
}): string {
  const toolchain = `msvc${options.msvcHash}-rocmClang${options.rocmClangHash}-pipToolchain${options.pipToolchainHash}`;
  return `ccache-v1-${options.lockHash8}-${options.patchHash8}-${toolchain}`;
}
