import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const buildCacheEntrySchema = z.object({
  opt_dim: z.string().min(1),
  key: z.string().min(1),
  hit: z.boolean(),
});

export type BuildCacheEntry = z.infer<typeof buildCacheEntrySchema>;

export function readBuildCaches(inputPath: string): BuildCacheEntry[] {
  const resolved = path.resolve(inputPath);
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  return z.array(buildCacheEntrySchema).min(1).parse(raw);
}

export function validateBuildCachesForVariant(options: {
  buildCaches: BuildCacheEntry[];
  ckOptDim: string;
}): BuildCacheEntry[] {
  if (options.buildCaches.length !== 1) {
    throw new Error(
      `serial build expects exactly one build cache entry, got ${options.buildCaches.length}`,
    );
  }
  const entry = options.buildCaches[0]!;
  if (entry.opt_dim !== options.ckOptDim) {
    throw new Error(
      `build cache opt_dim mismatch: ${entry.opt_dim} != ${options.ckOptDim}`,
    );
  }
  return options.buildCaches;
}
