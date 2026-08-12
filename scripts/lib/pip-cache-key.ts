import { createHash } from "node:crypto";

function cacheKeyToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

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
    "pt-pip-toolchain-v2",
    cacheKeySegment("py", options.pythonVersion),
    cacheKeySegment("rocm", options.rocmVersion),
    cacheKeySegment("idx", indexHash),
  ].join("-");
}
