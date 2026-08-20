import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { appendGithubOutput } from "../lib/github.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";

const PYTHON = "python";

// 运行 ninja -d explain -n 并记录 dirty 原因（cache-hit 路径诊断）
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

// 决定 compile 命令并写入 GITHUB_OUTPUT（command + args JSON）
export function runPrepareBuild(options: {
  ptSrc: string;
  exportGithubEnv?: boolean;
  worktreeCacheUsed: boolean;
}): void {
  const exportGithubEnv = options.exportGithubEnv ?? false;
  if (process.env.GITHUB_ENV && !exportGithubEnv) {
    throw new Error(
      "08.prepare must be called with --export-github-env when GITHUB_ENV is set",
    );
  }

  const ptSrc = path.resolve(options.ptSrc);
  try {
    statSync(ptSrc);
  } catch {
    throw new Error(`pytorch source not found: ${ptSrc}`);
  }

  initBuildEnv({ ptSrc, exportGithubEnv });

  const buildDir = path.join(ptSrc, "build");
  const buildNinja = path.join(buildDir, "build.ninja");
  const cacheHit = options.worktreeCacheUsed;
  const maxJobs = requireMaxJobs();

  if (cacheHit && existsSync(buildNinja)) {
    explainNinja(buildDir, "before-build");
    console.log(
      `Worktree cache hit: ninja -C ${buildDir} install (-j ${maxJobs})`,
    );
    appendGithubOutput({
      command: "ninja",
      args: JSON.stringify([
        "-C",
        buildDir,
        "install",
        "-j",
        String(maxJobs),
      ]),
    });
    return;
  }

  console.log("Running setup.py build (configure if needed, then cmake build)");
  const buildScript = path.join(resolveBuildDir(), "build-pytorch-steps.py");
  appendGithubOutput({
    command: PYTHON,
    args: JSON.stringify([
      buildScript,
      "--step",
      "build",
      "--pt-src",
      ptSrc,
      "-v",
    ]),
  });
}
