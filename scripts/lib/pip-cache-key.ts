import { createHash } from "node:crypto";

function cacheKeyToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
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
    "pt-pip-toolchain-v1",
    `py${cacheKeyToken(options.pythonVersion)}`,
    `rocm${cacheKeyToken(options.rocmVersion)}`,
    `idx${indexHash}`,
  ].join("-");
}
