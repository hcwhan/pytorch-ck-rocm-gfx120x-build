import { cacheKeyToken } from "./cache-key-token.js";

export const CCACHE_CACHE_PREFIX = "ccache-v2";


export function buildCcacheCacheKey(options: {
  lockHash8: string;
  patchHash8: string;
  msvcVersion: string;
  rocmClangVersion: string;
  ninjaMinor: string;
  cmakeMinor: string;
}): string {
  return [
    CCACHE_CACHE_PREFIX,
    `lock[${options.lockHash8}]`,
    `patch[${options.patchHash8}]`,
    `msvc[${cacheKeyToken(options.msvcVersion)}]`,
    `rocmClang[${cacheKeyToken(options.rocmClangVersion)}]`,
    `ninja[${options.ninjaMinor}]`,
    `cmake[${options.cmakeMinor}]`,
  ].join("-");
}
