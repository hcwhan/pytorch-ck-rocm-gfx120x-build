import { cacheKeyToken } from "./cache-key-token.js";

export const WORKTREE_CACHE_PREFIX = "worktree-v2";


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
    WORKTREE_CACHE_PREFIX,
    `lock[${options.lockHash8}]`,
    `lockWheel[${options.lockWheelHash8}]`,
    `patch[${options.patchHash8}]`,
    `msvc[${cacheKeyToken(options.msvcVersion)}]`,
    `rocmClang[${cacheKeyToken(options.rocmClangVersion)}]`,
    `ninja[${options.ninjaMinor}]`,
    `cmake[${options.cmakeMinor}]`,
  ].join("-");
}
