import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { runCapture } from "../lib/exec.js";
import { appendGithubOutput } from "../lib/github.js";
import { buildNinjaCacheKey } from "../lib/ninja-cache-key.js";
import { getRocmSdkPaths } from "../lib/rocm-sdk-paths.js";
import { versionLockFileHash8 } from "../lib/version-lock.js";

const PYTHON = "python";

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

function resolveRocmClangVersion(develRoot: string): string {
  const clangExe = path.join(develRoot, "lib", "llvm", "bin", "clang.exe");
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

function fingerprintHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}

export function runToolchainFingerprint(options?: {
  workspaceRoot?: string;
}): void {
  const toolset = resolveMsvcToolset();
  const { coreRoot } = getRocmSdkPaths();
  const rocmClangVersion = resolveRocmClangVersion(coreRoot);

  const msvcHash = fingerprintHash(toolset);
  const rocmClangHash = fingerprintHash(rocmClangVersion);
  console.log(`MSVC toolset: ${toolset} (fingerprint ${msvcHash})`);
  console.log(`ROCm clang: ${rocmClangVersion} (fingerprint ${rocmClangHash})`);

  const pipPkgs = ["pip", "setuptools", "wheel", "ninja", "packaging", "psutil"];
  const pipFreeze = runCapture(PYTHON, ["-m", "pip", "list", "--format=freeze"]);
  const pipVersions = pipPkgs.map((pkg) => {
    const line = pipFreeze
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${pkg}==`));
    if (!line) {
      throw new Error(`pip toolchain package not found: ${pkg}`);
    }
    return line;
  });

  const pipToolchainHash = fingerprintHash(pipVersions.sort().join(";"));
  console.log(
    `pip toolchain: ${pipVersions.join(";")} (fingerprint ${pipToolchainHash})`,
  );

  if (options?.workspaceRoot) {
    const lockHash = versionLockFileHash8(options.workspaceRoot);
    const cacheKey = buildNinjaCacheKey({
      lockHash,
      msvcHash,
      rocmClangHash,
      pipToolchainHash,
    });
    console.log(`VERSION.lock.json fingerprint: ${lockHash}`);
    console.log(`Ninja cache key: ${cacheKey}`);
    appendGithubOutput({ "cache-key": cacheKey });
    return;
  }

  console.log("Toolchain fingerprint complete (cache-key not requested)");
}
