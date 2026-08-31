import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const scriptArgs = process.argv.slice(2);

async function resolveBunBin() {
  const explicit = process.env.STEP_BUN_BIN;
  if (explicit) {
    return explicit;
  }

  const candidates = [
    "bun",
    path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "bun", "bun.exe"),
  ];

  for (const candidate of candidates) {
    const ok = await checkCommand(candidate);
    if (ok) {
      return candidate;
    }
  }

  return process.execPath;
}

async function checkCommand(command) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ["--version"], {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.once("error", () => {
      resolve(false);
    });

    child.once("close", (code) => {
      resolve(code === 0 && stdout.trim().length > 0);
    });
  });
}

const require = createRequire(import.meta.url);

try {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`step-cli wrapper error: ${message}\n`);
  process.exit(1);
}

async function main() {
  let staleOnly = true;
  if (scriptArgs[0] === "--full") {
    staleOnly = false;
    scriptArgs.shift();
  } else if (scriptArgs[0] === "--stale-only") {
    scriptArgs.shift();
  }

  if (scriptArgs[0] === "--") {
    scriptArgs.shift();
  }

  const buildExitCode = await runCommand(process.execPath, [
    path.join(repoRoot, "scripts", "build-packages.mjs"),
    ...(staleOnly ? ["--stale-only"] : []),
  ]);
  if (buildExitCode !== 0) {
    return buildExitCode;
  }

  await runCommand(process.execPath, [
    path.join(repoRoot, "scripts", "patch-opentui-core.mjs"),
  ]).catch(() => {});

  const entrypoint = path.join(repoRoot, "src", "index.ts");
  const bunBin = await resolveBunBin();
  const isNode = bunBin === process.execPath || /(^|[/\\])node(\.exe)?$/.test(bunBin);
  if (!isNode) {
    return runCommand(bunBin, [entrypoint, ...scriptArgs]);
  }

  return runCommand(process.execPath, [
    "--import",
    pathToFileURL(require.resolve("tsx")).href,
    entrypoint,
    ...scriptArgs,
  ]);
}

async function runCommand(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      resolve(code ?? 1);
    });
  });
}
