import { spawnSync, type ChildProcess } from "node:child_process";
import { appendGithubEnv } from "./github.js";

const WATCHDOG_LIMIT_MS = 5 * 60 * 60 * 1000;
const ABORT_RETRY_INTERVAL_MS = 60_000;
const MAX_ABORT_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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

  // 128 = process not found (often already exited after prior SIGINT)
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

export function createWatchdog(
  child: ChildProcess,
  jobStartMs: number,
): { stop: () => void; wasAborted: () => boolean; whenAbortSettled: () => Promise<void> } {
  let aborted = false;
  let forceKilled = false;
  let swallowSigint = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let abortPromise: Promise<void> = Promise.resolve();

  const onSigint = (): void => {
    if (swallowSigint) {
      console.log("Watchdog: received SIGINT, intercepting (Node stays alive)");
      return;
    }
    process.exit(130);
  };

  process.on("SIGINT", onSigint);

  const abortChild = async (): Promise<void> => {
    swallowSigint = true;
    try {
      for (let attempt = 1; attempt <= MAX_ABORT_ATTEMPTS; attempt++) {
        if (!isChildRunning(child)) {
          return;
        }
        console.log(
          `Watchdog: abort attempt ${attempt}/${MAX_ABORT_ATTEMPTS}, sending SIGINT (child.kill)`,
        );
        if (!sendChildSigint(child)) {
          console.warn(
            `Watchdog: SIGINT attempt ${attempt}/${MAX_ABORT_ATTEMPTS} failed`,
          );
        }
        await sleep(ABORT_RETRY_INTERVAL_MS);
      }
      if (!isChildRunning(child)) {
        return;
      }
      console.log(
        `Watchdog: ${MAX_ABORT_ATTEMPTS} abort attempts exhausted, force killing pid=${child.pid}`,
      );
      forceKilled = true;
      appendGithubEnv({ ABORT_FORCE_KILLED: "true" });
      if (!forceKillProcessTree(child.pid)) {
        console.warn(
          `Watchdog: force kill may have failed; child may still be running (pid=${child.pid})`,
        );
      }
    } finally {
      swallowSigint = false;
    }
  };

  const onDeadline = (): void => {
    deadlineTimer = undefined;
    if (!isChildRunning(child)) {
      return;
    }
    aborted = true;
    appendGithubEnv({
      ABORT_TRIGGERED: "true",
      COMPILE_COMPLETE: "false",
    });
    console.log(
      `Watchdog: job elapsed ${Date.now() - jobStartMs}ms >= ${WATCHDOG_LIMIT_MS}ms, beginning graceful abort`,
    );
    abortPromise = abortChild();
    void abortPromise;
  };

  deadlineTimer = setTimeout(
    onDeadline,
    Math.max(0, jobStartMs + WATCHDOG_LIMIT_MS - Date.now()),
  );

  return {
    stop: () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      swallowSigint = false;
      process.removeListener("SIGINT", onSigint);
    },
    wasAborted: () => aborted || forceKilled,
    whenAbortSettled: () => abortPromise,
  };
}
