import { runCapture } from "./exec.js";

/** 从 `clang --version` 首行提取完整版本 token（如 19.0.0git）。 */
export function parseRocmClangFullVersion(raw: string): string {
  const match = raw.match(/clang version (\S+)/i);
  if (!match?.[1]) {
    throw new Error(`Cannot parse ROCm clang full version from: ${raw}`);
  }
  return match[1];
}

export function parseMinorVersion(raw: string, tool: string): string {
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Cannot parse ${tool} minor version from: ${raw}`);
  }
  return `${match[1]}.${match[2]}`;
}

export function resolveNinjaMinorVersion(): string {
  const raw = runCapture("ninja", ["--version"]).trim();
  return parseMinorVersion(raw, "ninja");
}

export function resolveCmakeMinorVersion(): string {
  const raw =
    runCapture("cmake", ["--version"]).split(/\r?\n/)[0]?.trim() ?? "";
  return parseMinorVersion(raw, "cmake");
}
