import { appendFileSync } from "node:fs";

export function appendGithubEnv(vars: Record<string, string>): void {
  const file = process.env.GITHUB_ENV;
  if (!file) {
    throw new Error("GITHUB_ENV is not set");
  }
  for (const [name, value] of Object.entries(vars)) {
    appendFileSync(file, `${name}=${value}\n`, "utf8");
  }
}

export function appendGithubOutput(vars: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    throw new Error("GITHUB_OUTPUT is not set");
  }
  for (const [name, value] of Object.entries(vars)) {
    appendFileSync(file, `${name}=${value}\n`, "utf8");
  }
}
