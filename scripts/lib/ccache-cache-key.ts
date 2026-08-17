import { cacheKeyToken } from "./cache-key-token.js";

export const CCACHE_CACHE_PREFIX = "ccache-v3";


export function buildCcacheCacheKey(options: {
  lockHash8: string;
  patchHash8: string;
  msvcVersion: string;
  rocmClangVersion: string;
  ninjaMinor: string;
  cmakeMinor: string;
}): string {
  return "ccache-v3-lock[c0803a4c]-patch[bfb76ba2]-msvc[14.44.35207]-rocmClang[23.0.0git]-ninja[1.13]-cmake[4.4]";
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
