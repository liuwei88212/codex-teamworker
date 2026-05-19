import { join } from "node:path";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { createId, nowIso } from "./ids.js";
import { defaultStateRoot } from "./paths.js";
import { appendJsonl, ensureDir, pathExists, readJson, writeJson } from "./fs-utils.js";
import type { AcceptancePackage, OrchestratorConfig, PlanBundle, RunState, TaskGraph } from "./types.js";
import { orchestratorConfigSchema } from "./types.js";

export class Storage {
  readonly root: string;
  readonly config: OrchestratorConfig;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = orchestratorConfigSchema.parse(config);
    this.root = this.config.stateRoot ?? defaultStateRoot();
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    await this.cleanupOldRuns();
  }

  async createPlanBundle(input: Omit<PlanBundle, "id" | "createdAt"> & { id?: string }): Promise<PlanBundle> {
    await this.init();
    const plan: PlanBundle = { ...input, id: input.id ?? createId("plan"), createdAt: nowIso() };
    await writeJson(this.planPath(plan.id), plan);
    return plan;
  }

  async getPlanBundle(planId: string): Promise<PlanBundle> {
    return readJson<PlanBundle>(this.planPath(planId));
  }

  async saveTaskGraph(input: Omit<TaskGraph, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<TaskGraph> {
    await this.init();
    const graph: TaskGraph = { ...input, id: input.id ?? createId("graph"), createdAt: input.createdAt ?? nowIso() };
    await writeJson(this.graphPath(graph.id), graph);
    return graph;
  }

  async getTaskGraph(graphId: string): Promise<TaskGraph> {
    return readJson<TaskGraph>(this.graphPath(graphId));
  }

  async saveRun(run: RunState): Promise<void> {
    await ensureDir(run.runDir);
    await writeJson(join(run.runDir, "run.json"), run);
  }

  async getRun(runId: string): Promise<RunState> {
    return readJson<RunState>(join(this.runDir(runId), "run.json"));
  }

  async appendRunEvent(run: RunState, event: unknown): Promise<void> {
    await appendJsonl(join(run.runDir, "events.jsonl"), { at: nowIso(), ...event as object });
  }

  async readRunEvents(run: RunState, limit = 50): Promise<unknown[]> {
    try {
      const content = await readFile(join(run.runDir, "events.jsonl"), "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as unknown);
    } catch {
      return [];
    }
  }

  async saveAcceptancePackage(run: RunState, acceptance: AcceptancePackage): Promise<void> {
    await writeJson(join(run.runDir, "acceptance-package.json"), acceptance);
  }

  async existsRun(runId: string): Promise<boolean> {
    return pathExists(join(this.runDir(runId), "run.json"));
  }

  planPath(planId: string): string {
    return join(this.root, "plans", `${planId}.json`);
  }

  graphPath(graphId: string): string {
    return join(this.root, "graphs", `${graphId}.json`);
  }

  runDir(runId: string): string {
    return join(this.root, runId);
  }

  private async cleanupOldRuns(): Promise<void> {
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith("run_")) continue;
      const dir = join(this.root, entry);
      try {
        const info = await stat(dir);
        if (info.isDirectory() && info.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        // Best-effort retention cleanup should never block orchestration.
      }
    }
  }
}
