
import { runCapture } from "./exec.js";


// 将目录 prepend 到当前进程 PATH
export function prependProcessPath(dir: string): void {
  const current = process.env.Path ?? process.env.PATH ?? "";
  process.env.Path = `${dir};${current}`;
  process.env.PATH = process.env.Path;
}

// choco 安装后从 Machine + User 重载 PATH 到当前进程
export function refreshWindowsPathFromRegistry(): void {
  const merged = runCapture("powershell", [
    "-NoProfile",
    "-Command",
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
  ]).trim();

  if (!merged) {
    throw new Error("refreshWindowsPathFromRegistry: 无法读取 Machine/User Path");
  }

  process.env.Path = merged;
  process.env.PATH = merged;
}
