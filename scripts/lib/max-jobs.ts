const MAX_JOBS_MIN = 1;
const MAX_JOBS_MAX = 16;

export function requireMaxJobs(): number {
  const raw = process.env.MAX_JOBS?.trim();
  if (!raw) {
    throw new Error("MAX_JOBS env must be set (workflow ninja_workers input)");
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < MAX_JOBS_MIN || value > MAX_JOBS_MAX) {
    throw new Error(
      `MAX_JOBS must be an integer from ${MAX_JOBS_MIN} to ${MAX_JOBS_MAX}, got ${raw}`,
    );
  }

  return value;
}
