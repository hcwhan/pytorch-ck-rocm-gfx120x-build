import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { run } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";

const PYTHON = "python";

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

  // Categorize dirty reasons
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

export function runBuild(options: { ptSrc: string }): void {
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

  if (cacheHit && existsSync(buildNinja)) {
    // Worktree 命中且 build.ninja 存在 → 跳过 CMake 直接 ninja -C，
    // 避免 cmake --build 触发 CMake 检查导致 .ninja_log 作废。
    // pin-external-headers 已在 07.pin-mtimes 中将系统头文件钉到
    // SOURCE_DATE_EPOCH，使 cached .obj 比所有 input 新，ninja 跳过已编译对象。

    // Diagnostic: dry-run explain to verify dirty edge count.
    explainNinja(buildDir, "before-build");

    console.log(
      `Worktree cache hit: ninja -C ${buildDir} install (-j ${maxJobs})`,
    );
    run("ninja", ["-C", buildDir, "install", "-j", String(maxJobs)]);
  } else {
    console.log("Running setup.py build (configure if needed, then cmake build)");
    const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
    run(PYTHON, [buildScript, "--step", "build", "--pt-src", ptSrc, "-v"]);
  }

  if (process.env.CCACHE_DIR?.trim()) {
    run("ccache", ["--show-stats"]);
  }

  console.log("PyTorch build step complete");
}
