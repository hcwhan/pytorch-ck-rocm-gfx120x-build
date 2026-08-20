import { appendFileSync } from "node:fs";

// Windows PATH/INCLUDE/args JSON 等常含 %ProgramFiles%；换行或 % 需 heredoc 以免 GITHUB_* 解析出错
function formatGithubFileEntry(name: string, value: string): string {
  if (!/[\n\r%]/.test(value)) {
    return `${name}=${value}\n`;
  }
  const delimiter = `GH_FILE_${name}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

function appendGithubFile(
  file: string | undefined,
  fileLabel: string,
  vars: Record<string, string>,
): void {
  if (!file) {
    throw new Error(`${fileLabel} is not set`);
  }
  for (const [name, value] of Object.entries(vars)) {
    appendFileSync(file, formatGithubFileEntry(name, value), "utf8");
  }
}

export function appendGithubEnv(vars: Record<string, string>): void {
  appendGithubFile(process.env.GITHUB_ENV, "GITHUB_ENV", vars);
}

export function appendGithubOutput(vars: Record<string, string>): void {
  appendGithubFile(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT", vars);
}

// 追加 GITHUB_PATH 目录（每行一个 path）
export function appendGithubPath(dirs: string | readonly string[]): void {
  const file = process.env.GITHUB_PATH;
  if (!file) {
    throw new Error("GITHUB_PATH is not set");
  }
  for (const dir of [dirs].flat()) {
    appendFileSync(file, `${dir}\n`, "utf8");
  }
}
