import { readdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";

/** Skip VCS and the cmake build tree; pinning build/ mtimes corrupts CMake's
 *  timestamp bookkeeping and forces Re-running CMake / mass recompile on
 *  cache resume. build/ is re-generated, so its mtimes need not be pinned. */
const SKIP_DIR_NAMES = new Set([".git", "build"]);

function collectPaths(root: string): { files: string[]; directories: string[] } {
  const files: string[] = [];
  const directories: string[] = [];

  function walk(dir: string): void {
    directories.push(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  return { files, directories };
}

function directoryDepth(dirPath: string, root: string): number {
  const relative = path.relative(root, dirPath);
  if (!relative) {
    return 0;
  }
  return relative.split(path.sep).length;
}

export function pinMtimes(options: {
  ptSrc: string;
  epochSeconds: number;
}): { files: number; directories: number } {
  const root = path.resolve(options.ptSrc);
  statSync(root);

  if (!Number.isFinite(options.epochSeconds) || options.epochSeconds < 1) {
    throw new Error(
      `Invalid epochSeconds for worktree mtime pin: ${options.epochSeconds}`,
    );
  }

  const mtime = new Date(options.epochSeconds * 1000);
  const { files, directories } = collectPaths(root);

  for (const filePath of files) {
    utimesSync(filePath, mtime, mtime);
  }

  const sortedDirectories = [...directories].sort(
    (left, right) =>
      directoryDepth(right, root) - directoryDepth(left, root),
  );
  for (const dirPath of sortedDirectories) {
    utimesSync(dirPath, mtime, mtime);
  }

  return { files: files.length, directories: directories.length };
}
