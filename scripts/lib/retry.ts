
// 同步 sleep（bootstrap 重试用）
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 同步重试：失败抛最后一次错误
export function withRetrySync<T>(options: {
  label: string;
  try: number;
  delayMs: number;
  do: () => T;
}): T {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.try; attempt++) {
    try {
      return options.do();
    } catch (error) {
      lastError = error;
      if (attempt < options.try) {
        console.log(
          `${options.label} 失败（第 ${attempt}/${options.try} 次），${options.delayMs}ms 后重试…`,
        );
        sleepSync(options.delayMs);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.label} 失败：${String(lastError)}`);
}
