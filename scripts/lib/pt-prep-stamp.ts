import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const PREP_STAMP_FILE = ".pt-prep-stamp.json";

const prepStampSchema = z.object({
  repo: z.string().min(1),
  build_commit: z.string().min(1),
  build_commit_date: z.string().min(1),
  resolved_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-character git commit SHA"),
});

export type PrepStamp = z.infer<typeof prepStampSchema>;

const REQUIRED_PATHS = [
  "version.txt",
  "third_party/composable_kernel/include",
  "third_party/pybind11",
] as const;

export function prepStampPath(ptSrc: string): string {
  return path.join(path.resolve(ptSrc), PREP_STAMP_FILE);
}

export function writePrepStamp(ptSrc: string, stamp: PrepStamp): void {
  writeFileSync(
    prepStampPath(ptSrc),
    `${JSON.stringify(stamp, null, 2)}\n`,
    "utf8",
  );
}

export function readPrepStamp(ptSrc: string): PrepStamp | null {
  const stampPath = prepStampPath(ptSrc);
  if (!existsSync(stampPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }

  const result = prepStampSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function isPreparedSourceTree(ptSrc: string): boolean {
  const root = path.resolve(ptSrc);
  for (const rel of REQUIRED_PATHS) {
    try {
      statSync(path.join(root, rel));
    } catch {
      return false;
    }
  }
  return true;
}

export function verifyPrepStampAgainstLock(
  stamp: PrepStamp,
  lock: {
    repo: string;
    buildCommit: string;
    buildCommitDate: string;
  },
): boolean {
  return (
    stamp.repo === lock.repo &&
    stamp.build_commit === lock.buildCommit &&
    stamp.build_commit_date === lock.buildCommitDate
  );
}
