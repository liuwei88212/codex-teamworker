import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diffSnapshots, snapshotDirectory, writeJson } from "./fs-utils.js";
import { nowIso } from "./ids.js";
import type { CheckResult, OrchestratorConfig, Task, WorkerResult } from "./types.js";

export interface WorkerContext {
  sandboxRoot: string;
  runDir: string;
  config: OrchestratorConfig;
  signal?: AbortSignal;
  appendEvent?: (event: unknown) => Promise<void>;
}

export interface WorkerAdapter {
  readonly name: string;
  run(task: Task, context: WorkerContext): Promise<WorkerResult>;
}

export interface CliOutput {
  summary: string;
  sessionId?: string;
  exportOk?: boolean;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function createAdapter(name: string, config: OrchestratorConfig): WorkerAdapter {
  if (name === "opencode") return new CliWorkerAdapter("opencode", config.adapters.opencode.command, config.adapters.opencode.args, config.adapters.opencode.timeoutMs);
  if (name === "claudecode") return new CliWorkerAdapter("claudecode", config.adapters.claudecode.command, config.adapters.claudecode.args, config.adapters.claudecode.timeoutMs);
  if (name === "mock") return new MockWorkerAdapter();
  throw new Error(`Unknown worker adapter: ${name}`);
}

export class CliWorkerAdapter implements WorkerAdapter {
  constructor(readonly name: string, private readonly command: string, private readonly baseArgs: string[], private readonly timeoutMs: number) {}

  async run(task: Task, context: WorkerContext): Promise<WorkerResult> {
    const startedAt = nowIso();
    const before = await snapshotDirectory(context.sandboxRoot);
    const model = context.config.workerModel;
    const prompt = buildPrompt(task, `${model.provider}/${task.model ?? model.model}`);
    const usesStdinPrompt = this.name === "claudecode";
    const args = renderArgs(this.baseArgs, {
      provider: model.provider,
      model: task.model ?? model.model,
      modelRef: `${model.provider}/${task.model ?? model.model}`,
      prompt
    }, !usesStdinPrompt);
    const env = buildEnv(model);
    const eventWrites: Array<Promise<void>> = [];
    const commandResult = await runCommand(this.command, args, context.sandboxRoot, env, this.timeoutMs, (line) => {
      const event = parseProgressEvent(this.name, task.id, line);
      if (event && context.appendEvent) eventWrites.push(context.appendEvent(event));
    }, usesStdinPrompt ? prompt : undefined, context.signal);
    await Promise.allSettled(eventWrites);
    const parsed = await parseCliOutput(this.name, commandResult.stdout, context.sandboxRoot, this.command, env);
    const after = await snapshotDirectory(context.sandboxRoot);
    const changedFiles = diffSnapshots(before, after);
    const checks = await runChecks(task.validation, context.sandboxRoot, context.signal);
    const status = determineWorkerStatus(this.name, commandResult, parsed, changedFiles, checks, task);
    const result: WorkerResult = {
      taskId: task.id,
      adapter: this.name,
      status,
      startedAt,
      finishedAt: nowIso(),
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      changedFiles,
      checks,
      summary: status === "passed"
        ? parsed.summary || `Task ${task.id} completed with ${this.name}.`
        : parsed.summary || `Task ${task.id} failed with ${this.name}.`
    };
    await writeJson(join(context.runDir, "tasks", `${task.id}.json`), result);
    return result;
  }
}

export class MockWorkerAdapter implements WorkerAdapter {
  readonly name = "mock";

  async run(task: Task, context: WorkerContext): Promise<WorkerResult> {
    const startedAt = nowIso();
    const checks = await runChecks(task.validation, context.sandboxRoot, context.signal);
    const result: WorkerResult = {
      taskId: task.id,
      adapter: this.name,
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      startedAt,
      finishedAt: nowIso(),
      exitCode: 0,
      stdout: "",
      stderr: "",
      changedFiles: [],
      checks,
      summary: `Mock task ${task.id} completed.`
    };
    await writeJson(join(context.runDir, "tasks", `${task.id}.json`), result);
    return result;
  }
}

export async function runChecks(commands: string[], cwd: string, signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const result = await runShell(command, cwd, signal);
    results.push({
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      passed: result.exitCode === 0
    });
  }
  return results;
}

function buildPrompt(task: Task, model: string): string {
  return [
    "You are a worker in an orchestrated coding team.",
    `Model preference: ${model}`,
    `Task: ${task.title}`,
    task.description,
    task.allowedPaths.length > 0 ? `Allowed paths: ${task.allowedPaths.join(", ")}` : "Allowed paths: keep changes focused.",
    task.inputs.length > 0 ? `Inputs: ${task.inputs.join("\n")}` : "",
    task.expectedOutputs.length > 0 ? `Expected outputs: ${task.expectedOutputs.join("\n")}` : "",
    "Return after making the requested code changes and running relevant checks."
  ].filter(Boolean).join("\n\n");
}

function renderArgs(args: string[], values: Record<string, string>, appendPrompt = true): string[] {
  const cliValues: Record<string, string> = {
    ...values,
    prompt: values.prompt.replace(/\s+/g, " ").trim()
  };
  const rendered = args.map((arg) => arg
    .replaceAll("{{provider}}", cliValues.provider)
    .replaceAll("{{model}}", cliValues.model)
    .replaceAll("{{modelRef}}", cliValues.modelRef)
    .replaceAll("{{prompt}}", cliValues.prompt));
  return appendPrompt && !args.some((arg) => arg.includes("{{prompt}}")) ? [...rendered, cliValues.prompt] : rendered;
}

function buildEnv(model: { provider: string; apiKeyEnv: string; baseUrl?: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    env.PYTHONUTF8 = env.PYTHONUTF8 ?? "1";
    env.PYTHONIOENCODING = env.PYTHONIOENCODING ?? "utf-8";
  }
  const providerKey = `${model.provider.toUpperCase()}_API_KEY`;
  if (model.apiKeyEnv && process.env[model.apiKeyEnv] && !env[providerKey]) {
    env[providerKey] = process.env[model.apiKeyEnv];
  }
  if (model.baseUrl) {
    env.OPENAI_API_BASE = model.baseUrl;
    env.OPENAI_BASE_URL = model.baseUrl;
    env.ANTHROPIC_BASE_URL = model.baseUrl;
  }
  return env;
}

export async function parseCliOutput(
  adapter: string,
  stdout: string,
  cwd: string,
  command = "opencode",
  env: NodeJS.ProcessEnv = process.env
): Promise<CliOutput> {
  if (adapter === "opencode") return parseOpenCodeOutput(stdout, cwd, command, env);
  if (adapter === "claudecode") return { summary: parseClaudeCodeOutput(stdout) };
  return { summary: "" };
}

export function determineWorkerStatus(
  adapter: string,
  commandResult: CommandResult,
  parsed: CliOutput,
  changedFiles: string[],
  checks: CheckResult[],
  task: Pick<Task, "expectedOutputs">
): "passed" | "failed" {
  if (!checks.every((check) => check.passed)) return "failed";
  if (task.expectedOutputs.length > 0 && changedFiles.length === 0) return "failed";
  if (commandResult.exitCode === 0) return "passed";
  if (adapter !== "opencode") return "failed";
  if (!parsed.sessionId) return "failed";
  if (parsed.exportOk === false) return "failed";
  return parsed.summary.trim() && changedFiles.length > 0 ? "passed" : "failed";
}

export async function parseOpenCodeAnswer(
  stdout: string,
  cwd: string,
  command = "opencode",
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return (await parseOpenCodeOutput(stdout, cwd, command, env)).summary;
}

export async function parseOpenCodeOutput(
  stdout: string,
  cwd: string,
  command = "opencode",
  env: NodeJS.ProcessEnv = process.env
): Promise<CliOutput> {
  const sessionId = findOpenCodeSessionId(stdout);
  if (sessionId) {
    const exported = await runCommand(command, ["export", sessionId], cwd, env, 60000);
    if (exported.exitCode === 0) {
      const exportedText = parseOpenCodeExport(exported.stdout);
      if (exportedText) return { summary: exportedText, sessionId, exportOk: true };
      return { summary: parseInlineOpenCodeText(stdout), sessionId, exportOk: true };
    }
    return { summary: parseInlineOpenCodeText(stdout), sessionId, exportOk: false };
  }

  return { summary: parseInlineOpenCodeText(stdout) };
}

function parseInlineOpenCodeText(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
        if (event.type === "text" && event.part?.text) return event.part.text;
      } catch {
        return "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function findOpenCodeSessionId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { sessionID?: string; part?: { sessionID?: string } };
      const id = event.sessionID ?? event.part?.sessionID;
      if (id) return id;
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return null;
}

export function parseOpenCodeExport(stdout: string): string {
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) return "";
  try {
    const exported = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as {
      messages?: Array<{
        info?: { role?: string };
        parts?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const messages = exported.messages ?? [];
    const assistant = [...messages].reverse().find((message) => message.info?.role === "assistant");
    return cleanupCliText((assistant?.parts ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n"));
  } catch {
    return "";
  }
}

export function parseClaudeCodeOutput(stdout: string): string {
  let result = "";
  const assistantTexts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        result?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (event.type === "result" && typeof event.result === "string") result = event.result;
      for (const part of event.message?.content ?? []) {
        if (part.type === "text" && part.text) assistantTexts.push(part.text);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return cleanupCliText(result || assistantTexts.join("\n"));
}

function parseProgressEvent(adapter: string, taskId: string, line: string): unknown | null {
  if (!line.trim()) return null;
  if (adapter === "opencode") return parseOpenCodeProgressEvent(taskId, line);
  if (adapter === "claudecode") return parseClaudeCodeProgressEvent(taskId, line);
  return { type: "worker_output", taskId, adapter, message: line.slice(0, 500) };
}

function parseOpenCodeProgressEvent(taskId: string, line: string): unknown | null {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      sessionID?: string;
      part?: { type?: string; tool?: string; text?: string; state?: { title?: string; status?: string } };
    };
    if (event.type === "step_start") return { type: "worker_step_started", taskId, adapter: "opencode", sessionId: event.sessionID };
    if (event.type === "step_finish") return { type: "worker_step_finished", taskId, adapter: "opencode", sessionId: event.sessionID };
    if (event.type === "tool_use") {
      return {
        type: "worker_tool_used",
        taskId,
        adapter: "opencode",
        tool: event.part?.tool,
        status: event.part?.state?.status,
        title: event.part?.state?.title
      };
    }
    if (event.type === "text" && event.part?.text) {
      return { type: "worker_message", taskId, adapter: "opencode", message: event.part.text.slice(0, 1000) };
    }
  } catch {
    return null;
  }
  return null;
}

function parseClaudeCodeProgressEvent(taskId: string, line: string): unknown | null {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      session_id?: string;
      result?: string;
      is_error?: boolean;
      message?: { content?: Array<{ type?: string; name?: string; text?: string }> };
    };
    if (event.type === "system" && event.subtype === "init") {
      return { type: "worker_session_started", taskId, adapter: "claudecode", sessionId: event.session_id };
    }
    if (event.type === "result") {
      return {
        type: "worker_session_finished",
        taskId,
        adapter: "claudecode",
        sessionId: event.session_id,
        isError: event.is_error,
        message: typeof event.result === "string" ? event.result.slice(0, 1000) : ""
      };
    }
    for (const part of event.message?.content ?? []) {
      if (part.type === "text" && part.text) return { type: "worker_message", taskId, adapter: "claudecode", message: part.text.slice(0, 1000) };
      if (part.type === "tool_use") return { type: "worker_tool_used", taskId, adapter: "claudecode", tool: part.name };
    }
  } catch {
    return null;
  }
  return null;
}

function cleanupCliText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  return runCommand(process.platform === "win32" ? "powershell.exe" : "sh", process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command], cwd, process.env, 120000, undefined, undefined, signal);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 180000,
  onStdoutLine?: (line: string) => void,
  stdinText?: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "Command canceled before start." });
      return;
    }
    const invocation = resolveInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, { cwd, shell: invocation.shell, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abortChild);
    };
    // Stop is cooperative at the orchestrator level, but external CLIs still
    // need an OS signal. SIGTERM gives them a moment to flush logs before the
    // fallback SIGKILL below.
    const abortChild = () => {
      stderr += "\nCommand canceled by orchestrator_stop_run.";
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000);
      forceKillTimer.unref();
    };
    signal?.addEventListener("abort", abortChild, { once: true });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText, "utf8");
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdoutLine) return;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      stderr += `\nCommand timed out after ${timeoutMs}ms.`;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000);
      forceKillTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onStdoutLine && stdoutLineBuffer.trim()) onStdoutLine(stdoutLineBuffer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function resolveInvocation(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command, args, shell: false };
  const resolved = resolveWindowsCommand(command);
  const lower = resolved.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args], shell: false };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { command: resolved, args, shell: true };
  }
  return { command: resolved, args, shell: false };
}

function resolveWindowsCommand(command: string): string {
  if (/[\\/]/.test(command)) return command;
  try {
    const output = execFileSync("where.exe", [command], { encoding: "utf8" });
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executable = candidates.find((item) => /\.(cmd|bat|ps1|exe)$/i.test(item));
    if (executable) return executable;
    const first = candidates[0];
    if (!first) return command;
    for (const ext of [".cmd", ".ps1", ".exe", ".bat"]) {
      const withExt = `${first}${ext}`;
      if (existsSync(withExt)) return withExt;
    }
    return first;
  } catch {
    return command;
  }
}
