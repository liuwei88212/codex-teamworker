import { z } from "zod";

export const adapterSchema = z.enum(["opencode", "claudecode", "mock"]);

export const modelConfigSchema = z.object({
  provider: z.string().default("deepseek"),
  model: z.string(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  apiKey: z.string().optional()
});

export const orchestratorConfigSchema = z.object({
  stateRoot: z.string().optional(),
  retentionDays: z.number().int().positive().default(30),
  maxReworkAttempts: z.number().int().min(0).default(1),
  adapter: adapterSchema.default("opencode"),
  leadModel: modelConfigSchema.default({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY"
  }),
  workerModel: modelConfigSchema.default({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY"
  }),
  leader: modelConfigSchema.optional(),
  worker: modelConfigSchema.optional(),
  adapters: z.object({
    opencode: z.object({
      command: z.string().default("opencode"),
      args: z.array(z.string()).default(["run", "--format", "json", "--model", "{{provider}}/{{model}}"]),
      timeoutMs: z.number().int().positive().default(180000)
    }).default({ command: "opencode", args: ["run", "--format", "json", "--model", "{{provider}}/{{model}}"], timeoutMs: 180000 }),
    claudecode: z.object({
      command: z.string().default("claude"),
      args: z.array(z.string()).default(["-p", "--output-format", "stream-json", "--verbose", "--model", "{{model}}", "--max-turns", "20", "--permission-mode", "bypassPermissions"]),
      timeoutMs: z.number().int().positive().default(180000)
    }).default({ command: "claude", args: ["-p", "--output-format", "stream-json", "--verbose", "--model", "{{model}}", "--max-turns", "20", "--permission-mode", "bypassPermissions"], timeoutMs: 180000 })
  }).default({})
});

export const planBundleSchema = z.object({
  id: z.string().optional(),
  projectRoot: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  modules: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    paths: z.array(z.string()).default([]),
    dependsOn: z.array(z.string()).default([]),
    acceptance: z.array(z.string()).default([])
  })).default([]),
  acceptance: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([]),
  config: orchestratorConfigSchema.partial().optional()
});

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  adapter: adapterSchema.default("opencode"),
  model: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  validation: z.array(z.string()).default([])
});

export const taskGraphSchema = z.object({
  id: z.string().optional(),
  planId: z.string().min(1),
  projectRoot: z.string().min(1),
  status: z.enum(["draft", "approved"]).default("draft"),
  tasks: z.array(taskSchema).min(1),
  checks: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  reviewSummary: z.string().optional()
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type PlanBundle = z.infer<typeof planBundleSchema> & { id: string; createdAt: string };
export type Task = z.infer<typeof taskSchema>;
export type TaskGraph = z.infer<typeof taskGraphSchema> & { id: string; createdAt: string; approvedAt?: string };

export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export type RunStatus = "created" | "running" | "cancel_requested" | "canceled" | "passed" | "failed" | "published" | "rolled_back";
export type LeaderRecommendation = "publish" | "rework" | "manual_review" | "ask_codex";

export interface WorkerResult {
  taskId: string;
  adapter: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  changedFiles: string[];
  checks: CheckResult[];
  summary: string;
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export interface RunState {
  id: string;
  planId: string;
  graphId: string;
  projectRoot: string;
  sandboxRoot: string;
  runDir: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  publishedAt?: string;
  rolledBackAt?: string;
  taskStatuses: Record<string, TaskStatus>;
  workerResults: WorkerResult[];
  checks: CheckResult[];
  leaderReviews: LeaderReview[];
  acceptancePackage?: AcceptancePackage;
  publishManifestPath?: string;
}

export interface LeaderReview {
  id: string;
  runId: string;
  attempt: number;
  status: "passed" | "needs_rework" | "needs_codex_review" | "failed";
  summary: string;
  taskAssessments: Array<{
    taskId: string;
    status: "satisfied" | "unsatisfied" | "skipped";
    evidence: string[];
    gaps: string[];
  }>;
  reworkTasks: string[];
  recommendation: LeaderRecommendation;
  nextTool: "orchestrator_publish_run" | "orchestrator_start_run" | "orchestrator_tail_run" | "orchestrator_get_acceptance_package";
  createdAt: string;
}

export interface AcceptancePackage {
  runId: string;
  status: "passed" | "failed" | "needs_review";
  summary: string;
  projectRoot: string;
  runDir: string;
  sandboxRoot: string;
  readmePath?: string;
  readmeContent?: string;
  runInstructions: string[];
  changedFiles: string[];
  taskResults: Array<{
    taskId: string;
    adapter: string;
    status: "passed" | "failed";
    summary: string;
    changedFiles: string[];
  }>;
  checks: CheckResult[];
  leaderReview?: LeaderReview;
  recommendation: LeaderRecommendation;
  nextTool: string;
  risks: string[];
  createdAt: string;
}

export interface PublishManifest {
  id: string;
  runId: string;
  projectRoot: string;
  sandboxRoot: string;
  backupRoot: string;
  createdAt: string;
  publishedAt?: string;
  rolledBackAt?: string;
  entries: PublishEntry[];
}

export interface PublishEntry {
  path: string;
  action: "add" | "modify" | "delete";
  backupPath?: string;
  sandboxPath?: string;
}
