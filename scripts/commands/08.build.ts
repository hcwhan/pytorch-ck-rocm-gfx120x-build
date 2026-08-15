import { appendFileSync, existsSync, statSync } from "node:fs";
import { spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { run, spawnAsync } from "../lib/exec.js";
import { initBuildEnv } from "../lib/init-build-env.js";
import { requireMaxJobs } from "../lib/max-jobs.js";
import { resolveBuildDir } from "../lib/paths.js";

const PYTHON = "python";

// const WATCHDOG_LIMIT_MS = 5 * 60 * 60 * 1000;
const WATCHDOG_LIMIT_MS = 40 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;
const ABORT_RETRY_INTERVAL_MS = 60_000;
const MAX_ABORT_ATTEMPTS = 10;
const SIMPLE_SIGINT_ATTEMPTS = 2;

function appendGithubEnv(key: string, value: string): void {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`, "utf8");
  }
}

function sendChildSigint(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    console.warn("Watchdog: sendChildSigint skipped (child has no pid)");
    return false;
  }

  try {
    return child.kill("SIGINT");
  } catch (err) {
    console.warn(
      `Watchdog: child.kill(SIGINT) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function sendConsoleCtrlC(targetPid: number | undefined): boolean {
  if (targetPid === undefined) {
    console.warn("Watchdog: sendConsoleCtrlC skipped (child has no pid)");
    return false;
  }

  // AttachConsole(target) so GenerateConsoleCtrlEvent reaches ninja's console even
  // when this helper process does not share stdio/console with the build child.
  const psScript = [
    `$targetPid = ${targetPid}`,
    `$sig = @'`,
    `[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);`,
    `[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);`,
    `[DllImport("kernel32.dll")] public static extern bool FreeConsole();`,
    `[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);`,
    `'@`,
    `$type = Add-Type -MemberDefinition $sig -Name Win32 -Namespace Kernel32 -PassThru`,
    `[void]$type::FreeConsole()`,
    `if (-not $type::AttachConsole($targetPid)) { exit 1 }`,
    `[void]$type::SetConsoleCtrlHandler([IntPtr]::Zero, $true)`,
    `$ok = $type::GenerateConsoleCtrlEvent(0, 0)`,
    `[void]$type::FreeConsole()`,
    `[void]$type::AttachConsole([uint32]::MaxValue)`,
    `[void]$type::SetConsoleCtrlHandler([IntPtr]::Zero, $false)`,
    `if (-not $ok) { exit 1 }`,
  ].join("\n");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", psScript],
    { shell: false, stdio: "pipe", encoding: "utf8" },
  );

  if (result.error) {
    console.warn(
      `Watchdog: GenerateConsoleCtrlEvent spawn failed: ${result.error.message}`,
    );
    return false;
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim();
    console.warn(
      `Watchdog: GenerateConsoleCtrlEvent failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
    return false;
  }
  return true;
}

function forceKillProcessTree(pid: number | undefined): boolean {
  if (pid === undefined) {
    console.warn("Watchdog: forceKillProcessTree skipped (child has no pid)");
    return false;
  }

  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    console.warn(
      `Watchdog: taskkill spawn failed (pid=${pid}): ${result.error.message}`,
    );
    return false;
  }

  // 128 = process not found (often already exited after prior CTRL_C)
  if (result.status === 0 || result.status === 128) {
    if (result.status === 128) {
      console.log(
        `Watchdog: taskkill pid=${pid} — process not found (already exited)`,
      );
    }
    return true;
  }

  const detail = (result.stderr ?? result.stdout ?? "").trim();
  console.warn(
    `Watchdog: taskkill failed (pid=${pid}, exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
  );
  return false;
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

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function createWatchdog(
  child: ChildProcess,
  jobStartMs: number,
): { stop: () => void; wasAborted: () => boolean } {
  let abortTriggered = false;
  let abortAttempts = 0;
  let abortTimer: NodeJS.Timeout | undefined;
  let forceKilled = false;
  let swallowSigint = false;

  const onSigint = (): void => {
    if (swallowSigint) {
      console.log("Watchdog: received SIGINT, intercepting (Node stays alive)");
      return;
    }
    process.exit(130);
  };

  process.on("SIGINT", onSigint);

  const endAbortSwallow = (): void => {
    swallowSigint = false;
  };

  const clearAbortTimer = (): void => {
    if (abortTimer !== undefined) {
      clearTimeout(abortTimer);
      abortTimer = undefined;
    }
  };

  const scheduleNextAbort = (): void => {
    if (!isChildRunning(child)) {
      clearAbortTimer();
      endAbortSwallow();
      return;
    }
    if (abortAttempts >= MAX_ABORT_ATTEMPTS) {
      console.log(
        `Watchdog: ${MAX_ABORT_ATTEMPTS} abort attempts exhausted, force killing pid=${child.pid}`,
      );
      forceKilled = true;
      if (!forceKillProcessTree(child.pid)) {
        console.warn(
          `Watchdog: force kill may have failed; child may still be running (pid=${child.pid})`,
        );
      }
      clearAbortTimer();
      endAbortSwallow();
      return;
    }
    abortAttempts += 1;
    const useSimplePath = abortAttempts <= SIMPLE_SIGINT_ATTEMPTS;
    const signalLabel = useSimplePath ? "SIGINT (child.kill)" : "CTRL_C_EVENT";
    console.log(
      `Watchdog: abort attempt ${abortAttempts}/${MAX_ABORT_ATTEMPTS}, sending ${signalLabel}`,
    );
    const sent = useSimplePath
      ? sendChildSigint(child)
      : sendConsoleCtrlC(child.pid);
    if (!sent) {
      console.warn(
        `Watchdog: ${signalLabel} attempt ${abortAttempts}/${MAX_ABORT_ATTEMPTS} failed`,
      );
    }
    abortTimer = setTimeout(scheduleNextAbort, ABORT_RETRY_INTERVAL_MS);
  };

  const beginAbort = (): void => {
    if (abortTriggered || !isChildRunning(child)) {
      return;
    }
    abortTriggered = true;
    clearInterval(pollTimer);
    appendGithubEnv("ABORT_TRIGGERED", "true");
    appendGithubEnv("COMPILE_COMPLETE", "false");
    console.log(
      `Watchdog: job elapsed ${Date.now() - jobStartMs}ms >= ${WATCHDOG_LIMIT_MS}ms, beginning graceful abort`,
    );
    swallowSigint = true;
    scheduleNextAbort();
  };

  const pollTimer = setInterval(() => {
    const elapsed = Date.now() - jobStartMs;
    if (elapsed >= WATCHDOG_LIMIT_MS) {
      beginAbort();
    }
  }, POLL_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(pollTimer);
      clearAbortTimer();
      endAbortSwallow();
      process.removeListener("SIGINT", onSigint);
    },
    wasAborted: () => abortTriggered || forceKilled,
  };
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
