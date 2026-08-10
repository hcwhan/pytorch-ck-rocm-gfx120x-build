import { spawnSync } from "node:child_process";

export interface RunOptions {
  quiet?: boolean;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): void {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: options.quiet ? "pipe" : "inherit",
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function runCapture(
  command: string,
  args: readonly string[],
): string {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "pipe",
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
  }

  return result.stdout ?? "";
}
