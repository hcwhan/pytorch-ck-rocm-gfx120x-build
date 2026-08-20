import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const buildMetaEntrySchema = z.object({
  opt_dim: z.string().min(1),
  "worktree-cache-key": z.string().min(1),
  "worktree-cache-exists": z.boolean(),
  "worktree-cache-used": z.boolean(),
  "ccache-cache-key": z.string().min(1),
  "ccache-cache-exists": z.boolean(),
  "ccache-cache-used": z.boolean(),
});

type BuildMetaEntry = z.infer<typeof buildMetaEntrySchema>;

export function readBuildMeta(inputPath: string): BuildMetaEntry[] {
  const resolved = path.resolve(inputPath);
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  return z.array(buildMetaEntrySchema).min(1).parse(raw);
}

export function validateBuildMetaForVariant(options: {
  buildMeta: BuildMetaEntry[];
  ckOptDim: string;
}): BuildMetaEntry[] {
  if (options.buildMeta.length !== 1) {
    throw new Error(
      `serial build expects exactly one build meta entry, got ${options.buildMeta.length}`,
    );
  }
  const entry = options.buildMeta[0]!;
  if (entry.opt_dim !== options.ckOptDim) {
    throw new Error(
      `build meta opt_dim mismatch: ${entry.opt_dim} != ${options.ckOptDim}`,
    );
  }
  return options.buildMeta;
}
