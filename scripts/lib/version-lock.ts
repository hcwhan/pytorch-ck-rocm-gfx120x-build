import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatCkTargetsFlag } from "./gpu-archs.js";
import { buildPipToolchainCacheKey } from "./pip-cache-key.js";

const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "must be a 40-character git commit SHA");

const versionLockSchema = z.object({
  toolchain: z.object({
    python: z.string().min(1),
    rocm_index: z.string().min(1),
    rocm: z.string().min(1),
  }),
  pytorch: z.object({
    repo: z.string().min(1),
    build_commit: gitShaSchema,
    build_commit_date: z.string().min(1),
  }),
  compile: z.object({
    gpu_archs: z.string().min(1),
    ck_opt_dim: z.string().min(1),
  }),
  wheel: z.object({
    wheel_local_version: z.string().min(1),
    wheel_artifact_name: z.string().min(1),
  }),
  release: z.object({
    release_tag_prefix: z.string().min(1),
    release_title_prefix: z.string().min(1),
  }),
});

export type VersionLockVars = {
  PYTHON_VERSION: string;
  ROCM_INDEX: string;
  ROCM_VERSION: string;
  PIP_TOOLCHAIN_CACHE_KEY: string;
  GPU_ARCHS: string;
  CK_TARGETS: string;
  CK_OPT_DIM: string;
  PYTORCH_REPO: string;
  PYTORCH_BUILD_COMMIT: string;
  PYTORCH_BUILD_COMMIT_DATE: string;
  SOURCE_DATE_EPOCH: string;
  WHEEL_ARTIFACT_NAME: string;
  EXPECTED_WHEEL_PATTERN: string;
  WHEEL_LOCAL_VERSION: string;
  RELEASE_TAG_PREFIX: string;
  RELEASE_TITLE_PREFIX: string;
};

function pythonWheelTag(python: string): string {
  const [major, minor = ""] = python.split(".");
  if (!major || !/^\d+$/.test(major) || (minor && !/^\d+$/.test(minor))) {
    throw new Error(
      `VERSION.lock.json toolchain.python must look like major.minor (e.g. 3.12), got ${python}`,
    );
  }
  return `cp${major}${minor}`;
}

export function expectedWheelPattern(
  localVersion: string,
  python: string,
): string {
  const tag = pythonWheelTag(python);
  return `torch-*+${localVersion}*-${tag}-${tag}-win_amd64.whl`;
}

export function versionLockFileHash8(workspaceRoot: string): string {
  const lockPath = path.join(workspaceRoot, "VERSION.lock.json");
  let contents: Buffer;
  try {
    contents = readFileSync(lockPath);
  } catch {
    throw new Error(`VERSION.lock.json not found: ${lockPath}`);
  }
  return createHash("sha256").update(contents).digest("hex").slice(0, 8);
}

function normalizeCommitDate(raw: string): {
  isoUtc: string;
  epochSeconds: number;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      "VERSION.lock.json pytorch.build_commit_date is missing",
    );
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `VERSION.lock.json pytorch.build_commit_date is not valid ISO 8601: ${raw}`,
    );
  }

  const epochSeconds = Math.floor(date.getTime() / 1000);
  if (epochSeconds < 1) {
    throw new Error(
      "VERSION.lock.json pytorch.build_commit_date must map to a positive Unix epoch",
    );
  }

  const isoUtc = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { isoUtc, epochSeconds };
}

export function readVersionLock(workspaceRoot: string): VersionLockVars {
  const lockPath = path.join(workspaceRoot, "VERSION.lock.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error(`VERSION.lock.json not found or invalid JSON: ${lockPath}`);
  }

  const lock = versionLockSchema.parse(parsed);
  const { isoUtc, epochSeconds } = normalizeCommitDate(
    lock.pytorch.build_commit_date,
  );

  const vars: VersionLockVars = {
    PYTHON_VERSION: lock.toolchain.python,
    ROCM_INDEX: lock.toolchain.rocm_index,
    ROCM_VERSION: lock.toolchain.rocm,
    PIP_TOOLCHAIN_CACHE_KEY: buildPipToolchainCacheKey({
      pythonVersion: lock.toolchain.python,
      rocmVersion: lock.toolchain.rocm,
      rocmIndex: lock.toolchain.rocm_index,
    }),
    GPU_ARCHS: lock.compile.gpu_archs,
    CK_TARGETS: formatCkTargetsFlag(lock.compile.gpu_archs),
    CK_OPT_DIM: lock.compile.ck_opt_dim,
    PYTORCH_REPO: lock.pytorch.repo,
    PYTORCH_BUILD_COMMIT: lock.pytorch.build_commit,
    PYTORCH_BUILD_COMMIT_DATE: isoUtc,
    SOURCE_DATE_EPOCH: String(epochSeconds),
    WHEEL_ARTIFACT_NAME: lock.wheel.wheel_artifact_name,
    EXPECTED_WHEEL_PATTERN: expectedWheelPattern(
      lock.wheel.wheel_local_version,
      lock.toolchain.python,
    ),
    WHEEL_LOCAL_VERSION: lock.wheel.wheel_local_version,
    RELEASE_TAG_PREFIX: lock.release.release_tag_prefix,
    RELEASE_TITLE_PREFIX: lock.release.release_title_prefix,
  };

  console.log(
    `VERSION.lock: python=${vars.PYTHON_VERSION} rocm=${vars.ROCM_VERSION} gpu=${vars.GPU_ARCHS} ck_targets=${vars.CK_TARGETS} ck_opt_dim=${vars.CK_OPT_DIM}`,
  );

  return vars;
}

export function versionLockEnvRecord(
  vars: VersionLockVars,
): Record<string, string> {
  return { ...vars };
}
