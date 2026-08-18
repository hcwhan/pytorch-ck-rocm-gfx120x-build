#!/usr/bin/env node
import { Command } from "commander";
import { runConfig } from "./commands/01.config.js";
import { runToolchainFingerprint } from "./commands/02.toolchain-fingerprint.js";
import { runPrep } from "./commands/03.prep.js";
import { runPatch } from "./commands/04.patch.js";
import { runPatchTmp } from "./commands/04.patch-tmp.js";
import { runHipify } from "./commands/05.hipify.js";
import { runVerifyBootstrap } from "./commands/06.verify-bootstrap.js";
import { runPinMtimes } from "./commands/07.pin-mtimes.js";
import { runBuild } from "./commands/08.build.js";
import { runWatchdogRetry } from "./commands/09-retry.js";
import { runWheel } from "./commands/10.wheel.js";
import { runVerify } from "./commands/11.verify.js";
import { runPublish } from "./commands/12.publish.js";

const program = new Command();

program.name("pt-build").description("PyTorch CK SDPA gfx120x 构建 CLI");

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
  .command("04.patch-tmp")
  .description(
    "worktree cache hit 增量 B1-v3：对齐 mha_varlen_bwd_ck 直调 fmha_bwd；支持 v1/v2 缓存升级（不进 patch hash）",
  )
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPatchTmp({ ptSrc: opts.ptSrc });
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
  .command("08.build")
  .description(
    "编译 PyTorch：cache-hit 时 ninja -C build install；cache-miss 时 setup.py build（经 build-pytorch-steps.py）",
  )
  .requiredOption("--pt-src <path>")
  .action(async (opts) => {
    await runBuild({ ptSrc: opts.ptSrc });
  });

program
  .command("09-retry")
  .description(
    "看门狗中断后 dispatch retry workflow（A01.1 save 完成后由 workflow 条件触发）",
  )
  .action(async () => {
    await runWatchdogRetry();
  });

program
  .command("10.wheel")
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
  .command("11.verify")
  .description(
    "CPU wheel 校验（结构/CK 符号/SHA256/manifest）+ pip 安装冒烟 + is_ck_sdpa_available()",
  )
  .requiredOption("--dist-dir <path>")
  .requiredOption(
    "--build-caches <path>",
    "编译缓存元数据的 JSON 数组文件",
  )
  .action((opts) => {
    runVerify({
      distDir: opts.distDir,
      buildCaches: opts.buildCaches,
    });
  });

program
  .command("12.publish")
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
