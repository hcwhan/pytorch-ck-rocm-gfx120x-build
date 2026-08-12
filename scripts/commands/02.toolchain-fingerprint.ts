import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { runCapture } from "../lib/exec.js";
import { appendGithubEnv } from "../lib/github.js";
import { buildCcacheCacheKey } from "../lib/ccache-cache-key.js";
import { buildPatchHash8 } from "../lib/pt-patch-hash.js";
import { buildWorktreeCacheKey } from "../lib/worktree-cache-key.js";
import {
  parseRocmClangFullVersion,
  resolveCmakeMinorVersion,
  resolveNinjaMinorVersion,
} from "../lib/build-tool-minor.js";
import { getRocmSdkPaths } from "../lib/rocm-sdk-paths.js";
import {
  versionLockFileHash8,
  wheelLockHash8,
} from "../lib/version-lock.js";

function resolveMsvcToolset(): string {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (!programFilesX86) {
    throw new Error(
      "ProgramFiles(x86) env is not set; cannot locate MSVC toolset",
    );
  }

  const vswhere = path.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) {
    throw new Error(`vswhere.exe not found: ${vswhere}`);
  }

  const vcRoot = runCapture(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]).trim();

  const toolsDir = path.join(vcRoot, "VC", "Tools", "MSVC");
  if (!vcRoot || !existsSync(toolsDir)) {
    throw new Error(
      `MSVC tools directory not found under ${vcRoot || "(empty vcRoot)"}`,
    );
  }

  const toolsets = readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => {
      const parse = (value: string) => {
        const parts = value.split(".").map(Number);
        return parts[0]! * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
      };
      try {
        return parse(b) - parse(a);
      } catch {
        return 0;
      }
    });

  const toolset = toolsets[0];
  if (!toolset) {
    throw new Error(`No MSVC toolset directories under ${toolsDir}`);
  }

  return toolset;
}

function resolveRocmClangVersionLine(coreRoot: string): string {
  const clangExe = path.join(coreRoot, "lib", "llvm", "bin", "clang.exe");
  if (!existsSync(clangExe)) {
    throw new Error(`ROCm clang not found: ${clangExe}`);
  }

  const firstLine = runCapture(clangExe, ["--version"])
    .split(/\r?\n/)[0]
    ?.trim();
  if (!firstLine) {
    throw new Error(`ROCm clang --version returned no output from ${clangExe}`);
  }

  return firstLine;
}

export function runToolchainFingerprint(options?: {
  workspaceRoot?: string;
  exportGithubEnv?: boolean;
}): void {
  const msvcVersion = resolveMsvcToolset();
  const { coreRoot } = getRocmSdkPaths();
  const rocmClangLine = resolveRocmClangVersionLine(coreRoot);
  const rocmClangVersion = parseRocmClangFullVersion(rocmClangLine);

  console.log(`MSVC toolset (raw): ${msvcVersion}`);
  console.log(`ROCm clang: ${rocmClangLine}`);
  console.log(`ROCm clang (raw): ${rocmClangVersion}`);

  const ninjaMinor = resolveNinjaMinorVersion();
  const cmakeMinor = resolveCmakeMinorVersion();
  console.log(`ninja minor (cache key): ${ninjaMinor}`);
  console.log(`cmake minor (cache key): ${cmakeMinor}`);

  if (options?.workspaceRoot) {
    const lockHash = versionLockFileHash8(options.workspaceRoot);
    const lockWheelHash = wheelLockHash8(options.workspaceRoot);
    const patchHash = buildPatchHash8(options.workspaceRoot);
    const cacheKey = buildWorktreeCacheKey({
      lockHash8: lockHash,
      lockWheelHash8: lockWheelHash,
      patchHash8: patchHash,
      msvcVersion,
      rocmClangVersion,
      ninjaMinor,
      cmakeMinor,
    });
    const ccacheKey = buildCcacheCacheKey({
      lockHash8: lockHash,
      patchHash8: patchHash,
      msvcVersion,
      rocmClangVersion,
      ninjaMinor,
      cmakeMinor,
    });
    console.log(`Lock toolchain/pytorch/compile fingerprint: ${lockHash}`);
    console.log(`Lock wheel fingerprint: ${lockWheelHash}`);
    console.log(`Patch inputs fingerprint: ${patchHash}`);
    console.log(`Worktree cache key: ${cacheKey}`);
    console.log(`Ccache cache key: ${ccacheKey}`);
    if (options.exportGithubEnv) {
      appendGithubEnv({
        WORKTREE_CACHE_KEY: cacheKey,
        CCACHE_CACHE_KEY: ccacheKey,
      });
    }
    return;
  }

  console.log("Toolchain fingerprint complete (cache-key not requested)");
}
