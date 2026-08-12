import { cacheKeyToken } from "./cache-key-token.js";

export function buildWorktreeCacheKey(options: {
  lockHash8: string;
  lockWheelHash8: string;
  patchHash8: string;
  msvcVersion: string;
  rocmClangVersion: string;
  ninjaMinor: string;
  cmakeMinor: string;
}): string {
  return [
    "worktree-v2",
    `lock[${options.lockHash8}]`,
    `lockWheel[${options.lockWheelHash8}]`,
    `patch[${options.patchHash8}]`,
    `msvc[${cacheKeyToken(options.msvcVersion)}]`,
    `rocmClang[${cacheKeyToken(options.rocmClangVersion)}]`,
    `ninja[${options.ninjaMinor}]`,
    `cmake[${options.cmakeMinor}]`,
  ].join("-");
}
