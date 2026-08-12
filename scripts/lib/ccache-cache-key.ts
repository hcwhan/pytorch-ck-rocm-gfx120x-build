import { cacheKeyToken } from "./cache-key-token.js";

export function buildCcacheCacheKey(options: {
  lockHash8: string;
  patchHash8: string;
  msvcVersion: string;
  rocmClangVersion: string;
  ninjaMinor: string;
  cmakeMinor: string;
}): string {
  return [
    "ccache-v2",
    `lock[${options.lockHash8}]`,
    `patch[${options.patchHash8}]`,
    `msvc[${cacheKeyToken(options.msvcVersion)}]`,
    `rocmClang[${cacheKeyToken(options.rocmClangVersion)}]`,
    `ninja[${options.ninjaMinor}]`,
    `cmake[${options.cmakeMinor}]`,
  ].join("-");
}
