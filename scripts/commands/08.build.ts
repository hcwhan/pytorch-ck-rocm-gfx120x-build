import { appendFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { run, spawnAsync } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";
import { createWatchdog } from "../lib/watchdog.js";

const PYTHON = "python";

function appendGithubEnv(key: string, value: string): void {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`, "utf8");
  }
}

/**
 * Run `ninja -d explain -n` and log dirty reasons.
 * ninja writes explain reasons ("ninja explain: ...") to stderr,
 * planned edges ([N/M]) to stdout. We capture both and categorize.
 */
function explainNinja(buildDir: string, label: string): void {
  const result = spawnSync("ninja", [
    "-d", "explain", "-n", "-C", buildDir, "install",
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error) {
    console.log(`ninja -d explain -n (${label}) failed (non-fatal): ${result.error}`);
    return;
  }

  const stderr = result.stderr ?? "";
  const reasons = stderr.split("\n").filter((l) => l.startsWith("ninja explain:"));
  const stdout = result.stdout ?? "";
  const edges = stdout.split("\n").filter((l) => l.startsWith("["));

  const reasonCounts: Record<string, number> = {};
  for (const r of reasons) {
    let category = "other";
    if (r.includes("older than most recent input")) category = "output_older_than_input";
    else if (r.includes("recorded mtime") && r.includes("older than most recent input")) category = "log_mtime_older_than_input";
    else if (r.includes("command line changed")) category = "command_hash_changed";
    else if (r.includes("command line not found in log")) category = "no_log_entry";
    else if (r.includes("doesn't exist")) category = "output_missing";
    else if (r.includes("stored deps info out of date")) category = "deps_out_of_date";
    reasonCounts[category] = (reasonCounts[category] ?? 0) + 1;
  }

  console.log(`=== ninja -d explain -n ${label} ===`);
  console.log(`Planned edges: ${edges.length}`);
  console.log(`Explain reasons: ${reasons.length}`);
  console.log("Reason breakdown:");
  for (const [cat, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  const showReasons = 30;
  console.log(`First ${Math.min(showReasons, reasons.length)} reasons:`);
  for (const r of reasons.slice(0, showReasons)) {
    console.log(`  ${r}`);
  }
  if (reasons.length > showReasons) {
    console.log(`  ... (${reasons.length - showReasons} more)`);
  }
  console.log("=== end explain ===");
}

export async function runBuild(options: { ptSrc: string }): Promise<void> {
  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  initBuildEnv({ ptSrc });

  const buildDir = path.join(ptSrc, "build");
  const buildNinja = path.join(buildDir, "build.ninja");
  const cacheHit = process.env.WORKTREE_CACHE_USED === "true";
  const maxJobs = requireMaxJobs();

  const jobStartRaw = Number(process.env.JOB_START_TIME);
  const jobStartMs = Number.isFinite(jobStartRaw) ? jobStartRaw : Date.now();
  if (!Number.isFinite(jobStartRaw)) {
    console.warn("JOB_START_TIME not set; using current time as job start");
  }

  let buildHandle: ReturnType<typeof spawnAsync>;
  if (cacheHit && existsSync(buildNinja)) {
    explainNinja(buildDir, "before-build");
    console.log(
      `Worktree cache hit: ninja -C ${buildDir} install (-j ${maxJobs})`,
    );
    buildHandle = spawnAsync("ninja", [
      "-C",
      buildDir,
      "install",
      "-j",
      String(maxJobs),
    ]);
  } else {
    console.log("Running setup.py build (configure if needed, then cmake build)");
    const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
    buildHandle = spawnAsync(PYTHON, [
      buildScript,
      "--step",
      "build",
      "--pt-src",
      ptSrc,
      "-v",
    ]);
  }

  const watchdog = createWatchdog(buildHandle.child, jobStartMs);

  let exitCode: number | null;
  try {
    ({ exitCode } = await buildHandle.completed);
  } finally {
    await watchdog.whenAbortSettled();
    watchdog.stop();
  }

  if (exitCode === 0) {
    appendGithubEnv("COMPILE_COMPLETE", "true");
    if (process.env.CCACHE_DIR?.trim()) {
      run("ccache", ["--show-stats"]);
    }
    console.log("PyTorch build step complete");
    return;
  }

  if (watchdog.wasAborted()) {
    throw new Error("Build interrupted by watchdog");
  }

  throw new Error(`build failed (exit ${exitCode})`);
}
