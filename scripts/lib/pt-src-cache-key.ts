import { createHash } from "node:crypto";

export function buildPtSrcCacheKey(repo: string, buildCommit: string): string {
  const digest = createHash("sha256")
    .update(`${repo}\0${buildCommit}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `pt-src-v2-${digest}`;
}
