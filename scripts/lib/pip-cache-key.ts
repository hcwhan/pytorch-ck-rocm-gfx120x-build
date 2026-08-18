import { createHash } from "node:crypto";

import { cacheKeyToken } from "./cache-key-token.js";

export const PIP_TOOLCHAIN_CACHE_PREFIX = "pt-pip-toolchain-v2";

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
    PIP_TOOLCHAIN_CACHE_PREFIX,
    cacheKeySegment("py", options.pythonVersion),
    cacheKeySegment("rocm", options.rocmVersion),
    cacheKeySegment("idx", indexHash),
  ].join("-");
}
