#!/usr/bin/env node
import { Command } from "commander";
import { runConfig } from "./commands/01.config.js";
import { runPrep } from "./commands/03.prep.js";
import { runPatch } from "./commands/04.patch.js";
import { runToolchainFingerprint } from "./commands/05.toolchain-fingerprint.js";
import { runBuild } from "./commands/06.build.js";
import { runWheel } from "./commands/08.wheel.js";
import { runVerify } from "./commands/09.verify.js";
import { runPublish } from "./commands/10.publish.js";

const program = new Command();

program.name("pt-build").description("PyTorch CK SDPA gfx1201 build CLI");

program
  .command("01.config")
  .description("Read VERSION.lock.json")
  .requiredOption("-w, --workspace-root <path>")
  .option("--export-github-env", "Append lock vars to GITHUB_ENV")
  .action((opts) => {
    runConfig({
      workspaceRoot: opts.workspaceRoot,
      exportGithubEnv: Boolean(opts.exportGithubEnv),
    });
  });

program
  .command("03.prep")
  .description("Clone pytorch at pinned commit")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPrep({ ptSrc: opts.ptSrc });
  });

program
  .command("04.patch")
  .description("Patch pytorch for Windows CK SDPA + gfx1201")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runPatch({ ptSrc: opts.ptSrc });
  });

program
  .command("05.toolchain-fingerprint")
  .description("Emit MSVC/clang and pip toolchain cache fingerprints")
  .option("-w, --workspace-root <path>", "repo root (emit cache-key output)")
  .action((opts) => {
    runToolchainFingerprint({
      workspaceRoot: opts.workspaceRoot,
    });
  });

program
  .command("06.build")
  .description("Compile PyTorch (setup.py build)")
  .requiredOption("--pt-src <path>")
  .action((opts) => {
    runBuild({ ptSrc: opts.ptSrc });
  });

program
  .command("08.wheel")
  .description("Package torch wheel (setup.py bdist_wheel)")
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
  .description("CPU wheel smoke test")
  .requiredOption("--dist-dir <path>")
  .requiredOption(
    "--build-caches <path>",
    "JSON array file of compile cache metadata",
  )
  .action((opts) => {
    runVerify({
      distDir: opts.distDir,
      buildCaches: opts.buildCaches,
    });
  });

program
  .command("10.publish")
  .description("Prepare GitHub Release metadata")
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
