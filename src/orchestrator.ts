import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadOrchestratorConfig, normalizeConfig } from "./config.js";
import { createId, nowIso } from "./ids.js";
import { topologicalTasks, validateTaskGraph } from "./graph.js";
import { normalizePath } from "./paths.js";
import { Publisher } from "./publisher.js";
import { SandboxManager, type Sandbox } from "./sandbox.js";
import { Storage } from "./storage.js";
import { createAdapter, runChecks } from "./workers.js";
import {
  adapterSchema,
  orchestratorConfigSchema,
  planBundleSchema,
  taskGraphSchema,
  type AcceptancePackage,
  type CheckResult,
  type LeaderReview,
  type OrchestratorConfig,
  type PlanBundle,
  type RunState,
  type Task,
  type TaskGraph
} from "./types.js";

type AdapterName = ReturnType<typeof adapterSchema.parse>;

export class Orchestrator {
  readonly config: OrchestratorConfig;
  readonly storage: Storage;
  private readonly publisher = new Publisher();
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = loadOrchestratorConfig(config);
    this.storage = new Storage(this.config);
  }

  async createPlanBundle(input: unknown): Promise<PlanBundle> {
    const parsed = planBundleSchema.parse(input);
    return this.storage.createPlanBundle({
      ...parsed,
      projectRoot: normalizePath(parsed.projectRoot),
      config: parsed.config
    });
  }

  async refineTaskGraph(input: { planId: string; adapter?: AdapterName; tasks?: unknown[] }): Promise<TaskGraph> {
    const plan = await this.storage.getPlanBundle(input.planId);
    const effectiveConfig = plan.config ? normalizeConfig({ ...this.config, ...plan.config }) : this.config;
    const adapter = input.adapter ?? effectiveConfig.adapter;
    const tasks: Task[] = input.tasks
      ? taskGraphSchema.shape.tasks.parse(input.tasks)
      : plan.modules.length > 0
        ? plan.modules.map((module, index) => ({
          id: slug(module.name, `task_${index + 1}`),
          title: module.name,
          description: module.description,
          adapter,
          model: effectiveConfig.workerModel.model,
          dependsOn: module.dependsOn.map((dep) => slug(dep, dep)),
          allowedPaths: module.paths,
          inputs: plan.constraints,
          expectedOutputs: module.acceptance,
          validation: module.acceptance.length > 0 ? [] : []
        }))
        : [{
          id: "task_1",
          title: plan.title,
          description: plan.goal,
          adapter,
          model: effectiveConfig.workerModel.model,
          dependsOn: [],
          allowedPaths: [],
          inputs: plan.constraints,
          expectedOutputs: plan.acceptance,
          validation: []
        }];

    const draft = {
      planId: plan.id,
      projectRoot: plan.projectRoot,
      status: "draft",
      tasks,
      checks: plan.checks,
      notes: [
        `Default adapter: ${adapter}`,
        `Lead model: ${effectiveConfig.leadModel.provider}/${effectiveConfig.leadModel.model}`,
        `Worker model: ${effectiveConfig.workerModel.provider}/${effectiveConfig.workerModel.model}`
      ],
      reviewSummary: buildTaskGraphReviewSummary(tasks, plan.checks, effectiveConfig)
    } satisfies Omit<TaskGraph, "id" | "createdAt">;
    const graph = await this.storage.saveTaskGraph(draft);
    validateTaskGraph(graph);
    return graph;
  }

  async approveTaskGraph(input: { graphId: string }): Promise<TaskGraph> {
    const graph = await this.storage.getTaskGraph(input.graphId);
    const approved: TaskGraph = { ...graph, status: "approved", approvedAt: nowIso() };
    validateTaskGraph(approved);
    await this.storage.saveTaskGraph(approved);
    return approved;
  }

  async startRun(input: { graphId: string }): Promise<RunState> {
    const { run, graph, sandbox } = await this.createRun(input.graphId);
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    try {
      return await this.executeRun(run, graph, sandbox, controller.signal);
    } catch (error) {
      if (isRunCanceledError(error)) return this.markRunCanceled(run, error.message);
      throw error;
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  async startRunDetached(input: { graphId: string }): Promise<RunState> {
    const { run, graph, sandbox } = await this.createRun(input.graphId);
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    void this.executeRun(run, graph, sandbox, controller.signal)
      .catch(async (error: unknown) => {
        if (isRunCanceledError(error)) {
          await this.markRunCanceled(run, error.message);
          return;
        }
        run.status = "failed";
        run.finishedAt = nowIso();
        await this.storage.appendRunEvent(run, { type: "run_error", message: error instanceof Error ? error.message : String(error) });
        await this.storage.saveRun(run);
      })
      .finally(() => {
        this.activeRuns.delete(run.id);
      });
    return run;
  }

  async stopRun(input: { runId: string; reason?: string }): Promise<RunState> {
    const run = await this.storage.getRun(input.runId);
    if (!["running", "cancel_requested"].includes(run.status)) {
      await this.storage.appendRunEvent(run, { type: "run_stop_ignored", status: run.status, reason: input.reason });
      return run;
    }

    run.status = "cancel_requested";
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, {
      type: "run_cancel_requested",
      reason: input.reason ?? "Stopped by Codex/user."
    });

    const controller = this.activeRuns.get(run.id);
    if (controller) {
      controller.abort(input.reason ?? "Stopped by Codex/user.");
      return run;
    }

    // If this MCP process no longer owns the child process, we still persist a
    // terminal state so Codex does not keep waiting on a stale active run.
    return this.markRunCanceled(run, "Stop requested, but no active process handle was available.");
  }

  private async createRun(graphId: string): Promise<{ run: RunState; graph: TaskGraph; sandbox: Sandbox }> {
    const graph = await this.storage.getTaskGraph(graphId);
    if (graph.status !== "approved") {
      throw new Error(`Task graph ${graph.id} is not approved.`);
    }
    validateTaskGraph(graph);
    const runId = createId("run");
    const runDir = this.storage.runDir(runId);
    const sandboxManager = new SandboxManager(this.storage.root);
    const sandbox = await sandboxManager.create(graph.projectRoot, runId);
    const run: RunState = {
      id: runId,
      planId: graph.planId,
      graphId: graph.id,
      projectRoot: graph.projectRoot,
      sandboxRoot: sandbox.sandboxRoot,
      runDir,
      status: "running",
      createdAt: nowIso(),
      startedAt: nowIso(),
      taskStatuses: Object.fromEntries(graph.tasks.map((task) => [task.id, "pending"])),
      workerResults: [],
      checks: [],
      leaderReviews: []
    };
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, { type: "run_started", runId });
    return { run, graph, sandbox };
  }

  private async executeRun(run: RunState, graph: TaskGraph, sandbox: Sandbox, signal?: AbortSignal): Promise<RunState> {
    const sandboxManager = new SandboxManager(this.storage.root);
    assertNotCanceled(signal);
    await this.executeTaskBatch(run, graph, topologicalTasks(graph.tasks), "initial", signal);
    assertNotCanceled(signal);
    run.checks = await this.runRunChecks(run, graph.checks, signal);
    let review = await this.performLeaderReview(run, graph, 0);

    // The leader owns the "did the team actually satisfy the request?" loop.
    // Codex only approved the task graph; after that the leader can spend a
    // bounded rework budget before returning a final report for Codex review.
    for (let attempt = 1; review.status === "needs_rework" && attempt <= this.config.maxReworkAttempts; attempt += 1) {
      await this.storage.appendRunEvent(run, { type: "leader_rework_started", attempt, taskIds: review.reworkTasks });
      const reworkTasks = graph.tasks
        .filter((task) => review.reworkTasks.includes(task.id))
        .map((task) => buildReworkTask(task, review, attempt));
      await this.executeTaskBatch(run, graph, reworkTasks, `rework_${attempt}`, signal);
      assertNotCanceled(signal);
      run.checks = await this.runRunChecks(run, graph.checks, signal);
      review = await this.performLeaderReview(run, graph, attempt);
    }

    const changedFiles = await sandboxManager.changedFiles(sandbox);
    run.status = review.status === "passed" ? "passed" : "failed";
    run.finishedAt = nowIso();
    run.acceptancePackage = await buildAcceptancePackage(run, changedFiles, latestLeaderReview(run));
    await this.storage.saveAcceptancePackage(run, run.acceptancePackage);
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, { type: "run_finished", status: run.status });
    return run;
  }

  private async executeTaskBatch(run: RunState, graph: TaskGraph, tasks: Task[], phase: string, signal?: AbortSignal): Promise<void> {
    for (const task of tasks) {
      assertNotCanceled(signal);
      const failedDependency = task.dependsOn.find((dep) => run.taskStatuses[dep] !== "passed");
      if (failedDependency) {
        run.taskStatuses[task.id] = "skipped";
        await this.storage.appendRunEvent(run, { type: "task_skipped", taskId: task.id, failedDependency, phase });
        continue;
      }
      run.taskStatuses[task.id] = "running";
      await this.storage.saveRun(run);
      await this.storage.appendRunEvent(run, { type: "task_started", taskId: task.id, adapter: task.adapter, phase });
      const adapter = createAdapter(task.adapter, this.config);
      const result = await adapter.run(task, {
        sandboxRoot: run.sandboxRoot,
        runDir: run.runDir,
        config: this.config,
        signal,
        appendEvent: (event) => this.storage.appendRunEvent(run, event)
      });
      assertNotCanceled(signal);
      run.workerResults.push(result);
      run.taskStatuses[task.id] = result.status;
      await this.storage.appendRunEvent(run, { type: "task_finished", taskId: task.id, status: result.status, phase });
      await this.storage.saveRun(run);
      if (result.status === "failed" && phase === "initial") break;
    }
    validateTaskGraph(graph);
  }

  private async runRunChecks(run: RunState, checks: string[], signal?: AbortSignal): Promise<CheckResult[]> {
    assertNotCanceled(signal);
    await this.storage.appendRunEvent(run, { type: "leader_check_started", checks });
    const results = await runChecks(checks, run.sandboxRoot, signal);
    assertNotCanceled(signal);
    await this.storage.appendRunEvent(run, {
      type: "leader_check_finished",
      passed: results.every((check) => check.passed)
    });
    return results;
  }

  private async markRunCanceled(run: RunState, reason: string): Promise<RunState> {
    run.status = "canceled";
    run.finishedAt = nowIso();
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, { type: "run_canceled", reason });
    return run;
  }

  private async performLeaderReview(run: RunState, graph: TaskGraph, attempt: number): Promise<LeaderReview> {
    await this.storage.appendRunEvent(run, { type: "leader_review_started", attempt });
    const review = buildLeaderReview(run, graph, attempt, this.config.maxReworkAttempts);
    run.leaderReviews.push(review);
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, {
      type: "leader_review_finished",
      attempt,
      status: review.status,
      recommendation: review.recommendation,
      reworkTasks: review.reworkTasks,
      nextTool: review.nextTool
    });
    return review;
  }

  async getRun(input: { runId: string }): Promise<RunState> {
    return this.storage.getRun(input.runId);
  }

  async tailRun(input: { runId: string; limit?: number }): Promise<Pick<RunState, "id" | "status" | "taskStatuses" | "checks" | "acceptancePackage"> & { events: unknown[] }> {
    const run = await this.storage.getRun(input.runId);
    return {
      id: run.id,
      status: run.status,
      taskStatuses: run.taskStatuses,
      checks: run.checks,
      acceptancePackage: run.acceptancePackage,
      events: await this.storage.readRunEvents(run, input.limit ?? 50)
    };
  }

  async getAcceptancePackage(input: { runId: string }): Promise<AcceptancePackage> {
    const run = await this.storage.getRun(input.runId);
    if (!run.acceptancePackage) throw new Error(`Run ${run.id} has no acceptance package yet.`);
    return run.acceptancePackage;
  }

  async publishRun(input: { runId: string }): Promise<{ run: RunState; manifestPath: string }> {
    const run = await this.storage.getRun(input.runId);
    if (run.status !== "passed") throw new Error(`Run ${run.id} is not passed; refusing publish.`);
    const manifest = await this.publisher.publish(run);
    run.status = "published";
    run.publishedAt = nowIso();
    run.publishManifestPath = join(run.runDir, "publish-manifest.json");
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, { type: "run_published", manifestId: manifest.id });
    return { run, manifestPath: run.publishManifestPath };
  }

  async rollbackPublish(input: { runId?: string; manifestPath?: string }): Promise<{ run?: RunState; manifestPath: string }> {
    const manifestPath = input.manifestPath ?? (input.runId ? (await this.storage.getRun(input.runId)).publishManifestPath : undefined);
    if (!manifestPath) throw new Error("rollback requires runId with publishManifestPath or explicit manifestPath.");
    const manifest = await this.publisher.rollback(manifestPath);
    if (!input.runId) return { manifestPath };
    const run = await this.storage.getRun(input.runId);
    run.status = "rolled_back";
    run.rolledBackAt = nowIso();
    await this.storage.saveRun(run);
    await this.storage.appendRunEvent(run, { type: "run_rolled_back", manifestId: manifest.id });
    return { run, manifestPath };
  }
}

async function buildAcceptancePackage(run: RunState, changedFiles: string[], leaderReview?: LeaderReview): Promise<AcceptancePackage> {
  const readmePath = join(run.sandboxRoot, "README.md");
  const readmeContent = await readTextIfExists(readmePath);
  const recommendation = leaderReview?.recommendation ?? (run.status === "passed" ? "publish" : "manual_review");
  const nextTool = leaderReview?.nextTool ?? (run.status === "passed" ? "orchestrator_publish_run" : "orchestrator_get_acceptance_package");
  return {
    runId: run.id,
    status: run.status === "passed" ? "passed" : "failed",
    summary: run.status === "passed"
      ? `Run ${run.id} passed with ${changedFiles.length} changed file(s).`
      : `Run ${run.id} failed. Review task results and checks.`,
    projectRoot: run.projectRoot,
    runDir: run.runDir,
    sandboxRoot: run.sandboxRoot,
    readmePath: readmeContent ? readmePath : undefined,
    readmeContent: readmeContent || undefined,
    runInstructions: buildRunInstructions(run, changedFiles, readmeContent),
    changedFiles,
    taskResults: run.workerResults.map((result) => ({
      taskId: result.taskId,
      adapter: result.adapter,
      status: result.status,
      summary: result.summary,
      changedFiles: result.changedFiles
    })),
    checks: run.checks,
    leaderReview,
    recommendation,
    nextTool,
    risks: run.status === "passed" ? [] : ["One or more tasks or checks failed."],
    createdAt: nowIso()
  };
}

function buildLeaderReview(run: RunState, graph: TaskGraph, attempt: number, maxReworkAttempts: number): LeaderReview {
  // This v1 leader review is intentionally deterministic. A model-backed
  // leader can replace this function later, while keeping the same report
  // contract for Codex and the same rework orchestration around it.
  const taskAssessments = graph.tasks.map((task) => {
    const latestResult = latestResultForTask(run, task.id);
    const gaps: string[] = [];
    const evidence: string[] = [];
    if (!latestResult) {
      gaps.push("Task did not produce a worker result.");
    } else {
      evidence.push(`Worker status: ${latestResult.status}`);
      if (latestResult.changedFiles.length > 0) evidence.push(`Changed files: ${latestResult.changedFiles.join(", ")}`);
      if (latestResult.summary) evidence.push(`Worker summary: ${latestResult.summary}`);
      if (latestResult.status !== "passed") gaps.push(`Worker task failed with exit code ${latestResult.exitCode ?? "unknown"}.`);
      for (const check of latestResult.checks.filter((item) => !item.passed)) {
        gaps.push(`Task check failed: ${check.command}`);
      }
    }
    if (run.taskStatuses[task.id] === "skipped") gaps.push("Task was skipped because a dependency failed.");
    return {
      taskId: task.id,
      status: gaps.length === 0 ? "satisfied" as const : run.taskStatuses[task.id] === "skipped" ? "skipped" as const : "unsatisfied" as const,
      evidence,
      gaps
    };
  });

  const runCheckGaps = run.checks
    .filter((check) => !check.passed)
    .map((check) => `Run-level check failed: ${check.command}`);
  const unsatisfiedTaskIds = taskAssessments
    .filter((assessment) => assessment.status !== "satisfied")
    .map((assessment) => assessment.taskId);
  const reworkTasks = unsatisfiedTaskIds.length > 0
    ? unsatisfiedTaskIds
    : runCheckGaps.length > 0
      ? graph.tasks.map((task) => task.id)
      : [];
  const canRework = reworkTasks.length > 0 && attempt < maxReworkAttempts;
  const passed = reworkTasks.length === 0 && runCheckGaps.length === 0;

  return {
    id: createId("review"),
    runId: run.id,
    attempt,
    status: passed ? "passed" : canRework ? "needs_rework" : "needs_codex_review",
    summary: passed
      ? "Leader review passed: all tasks and run-level checks satisfy the approved task graph."
      : canRework
        ? `Leader review found gaps and will rework ${reworkTasks.join(", ")}.`
        : "Leader review found remaining gaps after the rework budget was exhausted.",
    taskAssessments,
    reworkTasks: canRework ? reworkTasks : [],
    recommendation: passed ? "publish" : canRework ? "rework" : "manual_review",
    nextTool: passed ? "orchestrator_publish_run" : canRework ? "orchestrator_tail_run" : "orchestrator_get_acceptance_package",
    createdAt: nowIso()
  };
}

function buildReworkTask(task: Task, review: LeaderReview, attempt: number): Task {
  const assessment = review.taskAssessments.find((item) => item.taskId === task.id);
  const gaps = assessment?.gaps.length ? assessment.gaps : ["Run-level checks failed after this task completed."];
  // Rework keeps the same task id so dependency tracking and final status stay
  // attached to the original assignment, just like a developer revising their
  // own ticket after code review.
  return {
    ...task,
    title: `${task.title} rework ${attempt}`,
    description: [
      task.description,
      "",
      "Leader review requires a focused rework pass.",
      "Fix these gaps:",
      ...gaps.map((gap) => `- ${gap}`),
      "Keep changes scoped to the original task responsibility."
    ].join("\n")
  };
}

function latestResultForTask(run: RunState, taskId: string) {
  return [...run.workerResults].reverse().find((result) => result.taskId === taskId);
}

function latestLeaderReview(run: RunState): LeaderReview | undefined {
  return run.leaderReviews.at(-1);
}

class RunCanceledError extends Error {
  constructor(reason?: unknown) {
    super(typeof reason === "string" && reason ? reason : "Run canceled by orchestrator_stop_run.");
  }
}

function assertNotCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCanceledError(signal.reason);
}

function isRunCanceledError(error: unknown): error is RunCanceledError {
  return error instanceof RunCanceledError;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function buildRunInstructions(run: RunState, changedFiles: string[], readmeContent: string): string[] {
  const instructions = [
    `Sandbox project path: ${run.sandboxRoot}`,
    `Original project path: ${run.projectRoot}`
  ];
  if (changedFiles.includes("index.html")) {
    instructions.push(`Open ${join(run.sandboxRoot, "index.html")} directly in a browser.`);
  }
  if (changedFiles.includes("package.json")) {
    instructions.push(`If package.json defines scripts, run them from ${run.sandboxRoot}.`);
  }
  if (readmeContent.trim()) {
    instructions.push("See README.md content included in this acceptance package.");
  }
  return instructions;
}

function buildTaskGraphReviewSummary(tasks: Task[], checks: string[], config: OrchestratorConfig): string {
  const lines = [
    "Task allocation pending Codex approval",
    "",
    `Worker model: ${config.workerModel.provider}/${config.workerModel.model}`,
    ""
  ];
  for (const [index, task] of tasks.entries()) {
    lines.push(`${index + 1}. ${task.title}`);
    lines.push(`   taskId: ${task.id}`);
    lines.push(`   adapter: ${task.adapter}`);
    lines.push(`   model: ${config.workerModel.provider}/${task.model ?? config.workerModel.model}`);
    lines.push(`   dependsOn: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}`);
    lines.push(`   allowedPaths: ${task.allowedPaths.length > 0 ? task.allowedPaths.join(", ") : "not restricted"}`);
    lines.push("   acceptance:");
    for (const output of task.expectedOutputs.length > 0 ? task.expectedOutputs : ["No task-level acceptance criteria specified."]) {
      lines.push(`   - ${output}`);
    }
    lines.push("");
  }
  lines.push("Run-level checks:");
  for (const check of checks.length > 0 ? checks : ["No run-level checks specified."]) {
    lines.push(`- ${check}`);
  }
  lines.push("");
  lines.push("Call orchestrator_approve_task_graph to approve; orchestrator_start_run rejects draft graphs.");
  return lines.join("\n");
}

function slug(value: string, fallback: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return out || fallback;
}
