import { spawnSync } from "node:child_process";
import { requireGithubActionsEnv } from "../lib/require-env.js";

const WORKFLOW_FILE = "build-pytorch-ck-gfx120x-serial.yml";
const MAX_RETRY_COUNT = 8;
const DISPATCH_ATTEMPTS = 3;
const DISPATCH_RETRY_INTERVAL_MS = 60_000;
const CANCEL_WAIT_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env must be set`);
  }
  return value;
}

function dispatchRetryWorkflow(nextRetryCount: number): boolean {
  const repo = requireGithubActionsEnv("GITHUB_REPOSITORY");
  const ref = requireGithubActionsEnv("GITHUB_REF_NAME");
  const maxJobs = requireEnv("MAX_JOBS").trim();
  const useCache = requireEnv("USE_CACHE") === "true";
  const publishRelease = requireEnv("PUBLISH_RELEASE") === "true";

  // gh -F coerces numeric-looking values to numbers; string workflow inputs need -f.
  const result = spawnSync(
    "gh",
    [
      "api",
      `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      "-f",
      `ref=${ref}`,
      "-f",
      `inputs[ninja_workers]=${maxJobs}`,
      "-F",
      `inputs[use_cache]=${useCache}`,
      "-F",
      `inputs[publish_release]=${publishRelease}`,
      "-f",
      `inputs[retry_count]=${String(nextRetryCount)}`,
    ],
    {
      env: process.env,
      stdio: "inherit",
      shell: false,
      encoding: "utf8",
    },
  );

  if (result.error) {
    console.warn(`gh api dispatch spawn failed: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

export async function runWatchdogRetry(): Promise<void> {
  if (requireEnv("USE_CACHE") !== "true") {
    throw new Error("Watchdog abort with use_cache=false; cannot retry");
  }

  const retryCountRaw = requireEnv("RETRY_COUNT");
  const retryCount = Number.parseInt(retryCountRaw, 10);
  if (!Number.isFinite(retryCount)) {
    throw new Error(`Invalid RETRY_COUNT: ${retryCountRaw}`);
  }
  if (retryCount >= MAX_RETRY_COUNT) {
    throw new Error(
      `Watchdog abort: retry_count=${retryCount} >= ${MAX_RETRY_COUNT}; giving up`,
    );
  }

  const nextRetry = retryCount + 1;
  let dispatched = false;

  for (let attempt = 1; attempt <= DISPATCH_ATTEMPTS; attempt++) {
    if (dispatchRetryWorkflow(nextRetry)) {
      dispatched = true;
      console.log(
        `Triggered retry run with retry_count=${nextRetry} (dispatch attempt ${attempt}/${DISPATCH_ATTEMPTS})`,
      );
      break;
    }
    console.warn(
      `gh api dispatch attempt ${attempt}/${DISPATCH_ATTEMPTS} failed`,
    );
    if (attempt < DISPATCH_ATTEMPTS) {
      await sleep(DISPATCH_RETRY_INTERVAL_MS);
    }
  }

  if (!dispatched) {
    throw new Error(
      `Failed to dispatch retry workflow after ${DISPATCH_ATTEMPTS} attempts`,
    );
  }

  console.log(
    `Waiting ${CANCEL_WAIT_MS / 1000}s for retry run to cancel this run via concurrency...`,
  );
  await sleep(CANCEL_WAIT_MS);
  throw new Error(
    `Retry run did not cancel this run within ${CANCEL_WAIT_MS / 1000}s`,
  );
}
