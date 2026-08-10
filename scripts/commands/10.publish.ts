import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendGithubOutput } from "../lib/github.js";
import {
  requireGithubActionsEnv,
  requireLockEnv,
} from "../lib/require-env.js";

const RELEASE_TITLE_TIME_ZONE = "Asia/Shanghai";

function formatReleaseTitleTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: RELEASE_TITLE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function runPublish(options: {
  distDir: string;
  workflowName: string;
}): void {
  const releaseTagPrefix = requireLockEnv("RELEASE_TAG_PREFIX");
  const releaseTitlePrefix = requireLockEnv("RELEASE_TITLE_PREFIX");
  const runNumber = requireGithubActionsEnv("GITHUB_RUN_NUMBER");
  const runnerTemp = requireGithubActionsEnv("RUNNER_TEMP");
  const githubSha = requireGithubActionsEnv("GITHUB_SHA");

  const distDir = path.resolve(options.distDir);
  const whls = readdirSync(distDir)
    .filter((name) => name.endsWith(".whl"))
    .map((name) => path.join(distDir, name));

  if (whls.length !== 1) {
    throw new Error(
      `Expected exactly one wheel in ${distDir} for release, found ${whls.length}`,
    );
  }

  const whlName = path.basename(whls[0]!);
  const releaseTag = `${releaseTagPrefix}-serial-build${runNumber}`;
  const releaseTimestamp = formatReleaseTitleTimestamp(new Date());
  const releaseTitle = `${releaseTitlePrefix} ${releaseTimestamp}`;
  const bodyPath = path.join(runnerTemp, "release-body.md");

  const manifestPath = path.join(distDir, "wheel.manifest.json");
  const manifestJson = readFileSync(manifestPath, "utf8").trimEnd();
  const manifestBlock = `\n\n### wheel.manifest.json\n\n\`\`\`json\n${manifestJson}\n\`\`\`\n`;

  const body = [
    `## ${releaseTitlePrefix}`,
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Workflow | ${options.workflowName} |`,
    `| Build variant | serial |`,
    `| Release time | ${releaseTimestamp} (${RELEASE_TITLE_TIME_ZONE}) |`,
    `| Run | ${runNumber} |`,
    `| Repository commit | ${githubSha} |`,
    `| Wheel | ${whlName} |`,
    manifestBlock,
  ].join("\n");

  writeFileSync(bodyPath, body, "utf8");

  appendGithubOutput({
    "release-tag": releaseTag,
    "body-path": bodyPath,
    "release-title": releaseTitle,
  });

  console.log(`Release tag: ${releaseTag}`);
  console.log(`Release title: ${releaseTitle}`);
  console.log(`Release body: ${bodyPath}`);
}
