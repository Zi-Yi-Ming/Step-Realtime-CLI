#!/usr/bin/env node
// Regression eval runner: executes T1-T5 tasks through the recording proxy.
// Usage: node evals/run-regression.mjs [task-id] [run-name] [extra exec args...]
//   task-id: t1|t2|t3|t4a|t4b|t5 (default: all)
//   run-name: output directory name (default: regression-<timestamp>)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TASKS = {
  t1: {
    name: "T1 只读总结+resume",
    prompt: "Please summarize the contents of the README.md file in this workspace, then resume the conversation by telling me what you found.",
    args: [],
    timeout: 120,
  },
  t2: {
    name: "T2 定位检索",
    prompt: "Find all files that contain the string 'step-cli' in this workspace and show me the first match from each file.",
    args: [],
    timeout: 180,
  },
  t3: {
    name: "T3 精确编辑",
    prompt: "Read the file AGENTS.md, find the section about 'Windows 语音模式', and add a new bullet point after it saying 'Use BrowserAudioDriver for all Windows voice operations.'",
    args: [],
    timeout: 120,
  },
  t4a: {
    name: "T4a 调用不存在工具",
    prompt: "Use the read_file tool to read the file /nonexistent/path.txt",
    args: [],
    timeout: 60,
  },
  t4b: {
    name: "T4b 读取不存在文件",
    prompt: "Try to read a file that does not exist in this workspace.",
    args: [],
    timeout: 60,
  },
  t5: {
    name: "T5 plan模式code review",
    prompt: "Review the packages/core/src/agent/agent-loop.ts file for potential issues with tool error handling.",
    args: ["--mode", "plan"],
    timeout: 300,
  },
};

const taskId = process.argv[2];
const runName = process.argv[3] || `regression-${Date.now()}`;
const extraArgs = process.argv.slice(4);

if (taskId && !TASKS[taskId.toLowerCase()]) {
  console.error(`Unknown task: ${taskId}`);
  console.error(`Available tasks: ${Object.keys(TASKS).join(", ")}`);
  process.exit(2);
}

const tasksToRun = taskId ? [taskId.toLowerCase()] : Object.keys(TASKS);
const outputDir = join(root, "evals", runName);
mkdirSync(outputDir, { recursive: true });

const results = [];
for (const tid of tasksToRun) {
  const task = TASKS[tid];
  console.log(`\n=== Running ${task.name} ===`);

  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [
      join(root, "dist", "index.js"),
      "exec",
      "--json",
      "--non-interactive-approval",
      "allow",
      ...task.args,
      ...extraArgs,
      task.prompt,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        STEP_BASE_URL:
          process.env.STEP_BASE_URL ?? "http://127.0.0.1:47190/step_plan/v1",
      },
      encoding: "utf8",
      timeout: (task.timeout ?? 120) * 1000,
      maxBuffer: 128 * 1024 * 1024,
    },
  );

  const elapsed = Date.now() - started;
  const stdoutFile = join(outputDir, `${tid}.stdout`);
  const stderrFile = join(outputDir, `${tid}.stderr`);

  writeFileSync(stdoutFile, res.stdout ?? "");
  writeFileSync(stderrFile, res.stderr ?? "");

  const result = {
    task: tid,
    name: task.name,
    exit: res.status,
    elapsed_ms: elapsed,
    stdout: stdoutFile,
    stderr: stderrFile,
  };
  results.push(result);

  console.log(`${tid} exit=${res.status} elapsed_ms=${elapsed}`);
  if (res.error) {
    console.error(`spawn error: ${res.error}`);
  }
}

const summaryFile = join(outputDir, "summary.json");
writeFileSync(
  summaryFile,
  JSON.stringify(
    {
      run: runName,
      timestamp: new Date().toISOString(),
      tasks: results,
    },
    null,
    2,
  ),
);
console.log(`\nSummary written to ${summaryFile}`);
