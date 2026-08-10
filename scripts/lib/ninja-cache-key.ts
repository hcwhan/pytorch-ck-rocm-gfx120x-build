export function buildNinjaCacheKey(options: {
  lockHash: string;
  msvcHash: string;
  rocmClangHash: string;
  pipToolchainHash: string;
}): string {
  const toolchain = `msvc${options.msvcHash}-rocmClang${options.rocmClangHash}-pipToolchain${options.pipToolchainHash}`;
  return `torch-ck-gfx120x-serial-v2-${options.lockHash}-${toolchain}`;
}
