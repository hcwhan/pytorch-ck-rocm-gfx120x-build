import { createHash } from "node:crypto";

import { cacheKeyToken } from "./cache-key-token.js";

export const PIP_TOOLCHAIN_CACHE_FAMILY = "pt-pip-toolchain";
const PIP_TOOLCHAIN_CACHE_VERSION = "v2";

function cacheKeySegment(label: string, value: string): string {
  return `${label}[${cacheKeyToken(value)}]`;
}

export function buildPipToolchainCacheKey(options: {
  pythonVersion: string;
  rocmVersion: string;
  rocmIndex: string;
}): string {
  const indexHash = createHash("sha256")
    .update(options.rocmIndex, "utf8")
    .digest("hex")
    .slice(0, 8);

  return [
    PIP_TOOLCHAIN_CACHE_FAMILY,
    PIP_TOOLCHAIN_CACHE_VERSION,
    cacheKeySegment("py", options.pythonVersion),
    cacheKeySegment("rocm", options.rocmVersion),
    cacheKeySegment("idx", indexHash),
  ].join("-");
}
