#!/usr/bin/env node
import { Command } from "commander";
import { runConfig } from "./commands/01.config.js";
import { runPrep } from "./commands/03.prep.js";
import { runPatch } from "./commands/04.patch.js";
import { runHipify } from "./commands/04.hipify.js";
import { runToolchainFingerprint } from "./commands/05.toolchain-fingerprint.js";
import { runBuild } from "./commands/06.build.js";
import { runWheel } from "./commands/08.wheel.js";
import { runVerify } from "./commands/09.verify.js";
import { runPublish } from "./commands/10.publish.js";

const program = new Command();

program.name("pt-build").description("PyTorch CK SDPA gfx120x 构建 CLI");

program
  .command("01.config")
  .description("读取 VERSION.lock.json")
  .requiredOption("-w, --workspace-root <path>")
  .option("--export-github-env", "将 lock 变量追加到 GITHUB_ENV")
  .action((opts) => {
    runConfig({
      workspaceRoot: opts.workspaceRoot,
      exportGithubEnv: Boolean(opts.exportGithubEnv),
    });
  });

program
  .command("03.prep")
  .description("按 pin 的 SHA 或 tag clone PyTorch 源码")
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
  .command("04.hipify")
  .description("运行 build_amd.py（CUDA → HIP 源码生成）")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runHipify({ ptSrc: opts.ptSrc });
  });

program
  .command("05.toolchain-fingerprint")
  .description("输出 MSVC/clang 与 pip 工具链缓存指纹")
  .option("-w, --workspace-root <path>", "仓库根目录（输出 cache-key）")
  .action((opts) => {
    runToolchainFingerprint({
      workspaceRoot: opts.workspaceRoot,
    });
  });

program
  .command("06.build")
  .description("编译 PyTorch（setup.py build）")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runBuild({ ptSrc: opts.ptSrc });
  });

program
  .command("08.wheel")
  .description("打包 torch wheel（setup.py bdist_wheel）")
  .requiredOption("--pt-src <path>")
  .requiredOption("--dist-dir <path>")
  .action((opts) => {
    runWheel({
      ptSrc: opts.ptSrc,
      distDir: opts.distDir,
    });
  });

program
  .command("09.verify")
  .description("CPU wheel 冒烟测试")
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
  .command("10.publish")
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
