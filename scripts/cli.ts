#!/usr/bin/env node
import { Command } from "commander";
import { runInstallWindowsDeps } from "./commands/00.install-windows-deps.js";
import { runConfig } from "./commands/01.config.js";
import { runToolchainFingerprint } from "./commands/02.toolchain-fingerprint.js";
import { runPrep } from "./commands/03.prep.js";
import { runPatch } from "./commands/04.patch.js";
import { runHipify } from "./commands/05.hipify.js";
import { runVerifyBootstrap } from "./commands/06.verify-bootstrap.js";
import { runPinMtimes } from "./commands/07.pin-mtimes.js";
import { runPrepareBuild } from "./commands/08.prepare.js";
import { runWheel } from "./commands/09.wheel.js";
import { runVerify } from "./commands/10.verify.js";
import { runPublish } from "./commands/11.publish.js";

const program = new Command();

program.name("pt-build").description("PyTorch CK SDPA gfx120x 构建 CLI");

program
  .command("00.install-windows-deps")
  .description("安装 ccache + libuv，并导出 CCACHE_* env（Windows CI bootstrap）")
  .action(async () => {
    await runInstallWindowsDeps();
  });

program
  .command("01.config")
  .description("读取并校验 VERSION.lock.json；可选导出 CI env")
  .requiredOption("-w, --workspace-root <path>")
  .option("--export-github-env", "将 lock 变量追加到 GITHUB_ENV")
  .action((opts) => {
    runConfig({
      workspaceRoot: opts.workspaceRoot,
      exportGithubEnv: Boolean(opts.exportGithubEnv),
    });
  });

program
  .command("02.toolchain-fingerprint")
  .description(
    "MSVC/clang + ninja/cmake 指纹；带 -w 时输出 worktree / ccache key（worktree 含 lockWheel，ccache 不含）",
  )
  .option("-w, --workspace-root <path>", "仓库根目录（输出 cache-key）")
  .option(
    "--export-github-env",
    "将 WORKTREE_CACHE_KEY / CCACHE_CACHE_KEY 追加到 GITHUB_ENV",
  )
  .action((opts) => {
    runToolchainFingerprint({
      workspaceRoot: opts.workspaceRoot,
      exportGithubEnv: Boolean(opts.exportGithubEnv),
    });
  });

program
  .command("03.prep")
  .description("blob-less 浅 clone PyTorch + 浅 submodule + strip .git")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPrep({ ptSrc: opts.ptSrc });
  });

program
  .command("04.patch")
  .description("为 Windows CK SDPA + gfx120x 打补丁")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPatch({ ptSrc: opts.ptSrc });
  });

program
  .command("05.hipify")
  .description("运行 build_amd.py（CUDA → HIP 源码生成）")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runHipify({ ptSrc: opts.ptSrc });
  });

program
  .command("06.verify-bootstrap")
  .description("校验 restore 后的 worktree hipify 探针路径")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runVerifyBootstrap({ ptSrc: opts.ptSrc });
  });

program
  .command("07.pin-mtimes")
  .description(
    "将 PT 工作树 + ROCm SDK 外部路径 mtime 固定为 SOURCE_DATE_EPOCH（满足 ninja cache restore 后三条 dirty 检查）",
  )
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPinMtimes({ ptSrc: opts.ptSrc });
  });

program
  .command("08.prepare")
  .description(
    "初始化编译 env 并输出 command/args（供 watchdog/run spawn；--worktree-cache-used=true 且 build.ninja 存在时 ninja -C，否则 setup.py build）",
  )
  .requiredOption("--pt-src <path>")
  .requiredOption(
    "--worktree-cache-used <bool>",
    "true when bootstrap restored worktree cache (A00 worktree-cache-used output)",
  )
  .option(
    "--export-github-env",
    "将 initBuildEnv 编译变量（含 ccache/MSVC 路径）追加到 GITHUB_ENV",
  )
  .action((opts) => {
    const worktreeCacheUsed = opts.worktreeCacheUsed;
    if (worktreeCacheUsed !== "true" && worktreeCacheUsed !== "false") {
      throw new Error(
        `--worktree-cache-used must be 'true' or 'false', got ${worktreeCacheUsed}`,
      );
    }
    runPrepareBuild({
      ptSrc: opts.ptSrc,
      exportGithubEnv: Boolean(opts.exportGithubEnv),
      worktreeCacheUsed: worktreeCacheUsed === "true",
    });
  });

program
  .command("09.wheel")
  .description("打包 torch wheel（setup.py bdist_wheel）并复制到 dist-dir")
  .requiredOption("--pt-src <path>")
  .requiredOption("--dist-dir <path>")
  .action((opts) => {
    runWheel({
      ptSrc: opts.ptSrc,
      distDir: opts.distDir,
    });
  });

program
  .command("10.verify")
  .description(
    "CPU wheel 校验（结构/CK fwd 符号/SHA256/manifest）+ pip 安装冒烟 + is_ck_sdpa_available()",
  )
  .requiredOption("--dist-dir <path>")
  .requiredOption(
    "--build-meta <path>",
    "compile-success-meta.json 等编译缓存元数据文件",
  )
  .action((opts) => {
    runVerify({
      distDir: opts.distDir,
      buildMeta: opts.buildMeta,
    });
  });

program
  .command("11.publish")
  .description("准备 GitHub Release 元数据")
  .requiredOption("--dist-dir <path>")
  .requiredOption("--workflow-name <name>")
  .action((opts) => {
    runPublish({
      distDir: opts.distDir,
      workflowName: opts.workflowName,
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
