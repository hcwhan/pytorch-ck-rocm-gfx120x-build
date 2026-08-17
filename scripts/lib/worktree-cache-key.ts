import { cacheKeyToken } from "./cache-key-token.js";

export const WORKTREE_CACHE_PREFIX = "worktree-v3";


export function buildWorktreeCacheKey(options: {
  lockHash8: string;
  lockWheelHash8: string;
  patchHash8: string;
  msvcVersion: string;
  rocmClangVersion: string;
  ninjaMinor: string;
  cmakeMinor: string;
}): string {
  return "worktree-v3-lock[c0803a4c]-lockWheel[491aa7f4]-patch[bfb76ba2]-msvc[14.44.35207]-rocmClang[23.0.0git]-ninja[1.13]-cmake[4.4]";
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
