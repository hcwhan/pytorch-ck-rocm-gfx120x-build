function requireEnvVar(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env must be set (${hint})`);
  }
  return value;
}

export function requireLockEnv(name: string): string {
  return requireEnvVar(
    name,
    "run 01.config --export-github-env in the same job first",
  );
}

export function requireGithubActionsEnv(name: string): string {
  return requireEnvVar(name, "GitHub Actions runner env missing");
}
