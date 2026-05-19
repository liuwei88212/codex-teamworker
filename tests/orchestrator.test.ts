import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ensureDir } from "../src/fs-utils.js";
import { Orchestrator } from "../src/orchestrator.js";

describe("orchestrator", () => {
  it("rejects starting an unapproved graph", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state") });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Test",
      goal: "Run mock worker.",
      modules: [{ name: "Mock", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: []
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id, adapter: "mock" });
    await expect(orchestrator.startRun({ graphId: graph.id })).rejects.toThrow(/not approved/);
  });

  it("runs a full mock flow and creates an acceptance package", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state") });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Test",
      goal: "Run mock worker.",
      modules: [{ name: "Mock", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: []
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id, adapter: "mock" });
    await orchestrator.approveTaskGraph({ graphId: graph.id });
    const run = await orchestrator.startRun({ graphId: graph.id });
    expect(run.status).toBe("passed");
    expect(run.acceptancePackage?.status).toBe("passed");
    expect(run.acceptancePackage?.projectRoot).toBe(fixture.projectRoot);
    expect(run.acceptancePackage?.sandboxRoot).toContain(run.id);
    expect(run.acceptancePackage?.runInstructions.some((item) => item.includes("Sandbox project path"))).toBe(true);
    expect(run.acceptancePackage?.readmeContent).toContain("# fixture");
    expect(run.acceptancePackage?.leaderReview?.status).toBe("passed");
    expect(run.acceptancePackage?.recommendation).toBe("publish");
    expect(run.acceptancePackage?.nextTool).toBe("orchestrator_publish_run");
    expect(run.taskStatuses.mock).toBe("passed");
  });

  it("uses configured default adapter when refine input omits adapter", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state"), adapter: "mock" });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Test",
      goal: "Run configured adapter.",
      modules: [{ name: "Configured", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: []
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id });
    expect(graph.tasks[0]?.adapter).toBe("mock");
    expect(graph.reviewSummary).toContain("Task allocation pending Codex approval");
    expect(graph.reviewSummary).toContain("orchestrator_approve_task_graph");
  });

  it("starts a detached run and exposes events through tail", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state"), adapter: "mock" });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Detached",
      goal: "Run mock worker in the background.",
      modules: [{ name: "Detached mock", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: []
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id });
    await orchestrator.approveTaskGraph({ graphId: graph.id });
    const run = await orchestrator.startRunDetached({ graphId: graph.id });
    expect(run.status).toBe("running");

    let tail = await orchestrator.tailRun({ runId: run.id, limit: 20 });
    for (let attempt = 0; attempt < 20 && (tail.status === "running" || !hasEvent(tail.events, "run_finished")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tail = await orchestrator.tailRun({ runId: run.id, limit: 20 });
    }

    expect(tail.status).toBe("passed");
    expect(hasEvent(tail.events, "run_started")).toBe(true);
    expect(hasEvent(tail.events, "run_finished")).toBe(true);
  });

  it("stops a detached run and records cancellation events", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state"), adapter: "mock" });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Cancelable",
      goal: "Run mock worker and a long leader check.",
      modules: [{ name: "Cancelable mock", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: ["node -e \"setTimeout(() => {}, 10000)\""]
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id });
    await orchestrator.approveTaskGraph({ graphId: graph.id });
    const run = await orchestrator.startRunDetached({ graphId: graph.id });

    const stopping = await orchestrator.stopRun({ runId: run.id, reason: "test cancellation" });
    expect(["cancel_requested", "canceled"]).toContain(stopping.status);

    let tail = await orchestrator.tailRun({ runId: run.id, limit: 20 });
    for (let attempt = 0; attempt < 40 && tail.status !== "canceled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      tail = await orchestrator.tailRun({ runId: run.id, limit: 20 });
    }

    expect(tail.status).toBe("canceled");
    expect(hasEvent(tail.events, "run_cancel_requested")).toBe(true);
    expect(hasEvent(tail.events, "run_canceled")).toBe(true);
  });

  it("records leader review and rework recommendation when checks keep failing", async () => {
    const fixture = await fixtureProject();
    const orchestrator = new Orchestrator({ stateRoot: join(fixture.root, "state"), adapter: "mock", maxReworkAttempts: 1 });
    const plan = await orchestrator.createPlanBundle({
      projectRoot: fixture.projectRoot,
      title: "Failing check",
      goal: "Run mock worker with a failing check.",
      modules: [{ name: "Mock", description: "No-op task.", paths: [], dependsOn: [], acceptance: [] }],
      checks: ["node -e \"process.exit(1)\""]
    });
    const graph = await orchestrator.refineTaskGraph({ planId: plan.id });
    await orchestrator.approveTaskGraph({ graphId: graph.id });
    const run = await orchestrator.startRun({ graphId: graph.id });

    expect(run.status).toBe("failed");
    expect(run.leaderReviews.length).toBe(2);
    expect(run.leaderReviews[0]?.status).toBe("needs_rework");
    expect(run.acceptancePackage?.leaderReview?.status).toBe("needs_codex_review");
    expect(run.acceptancePackage?.recommendation).toBe("manual_review");
    expect(run.acceptancePackage?.nextTool).toBe("orchestrator_get_acceptance_package");
  });
});

function hasEvent(events: unknown[], type: string): boolean {
  return events.some((event) => typeof event === "object" && event !== null && "type" in event && event.type === type);
}

async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), "owt-orch-"));
  const projectRoot = join(root, "project");
  await ensureDir(projectRoot);
  await writeFile(join(projectRoot, "README.md"), "# fixture\n", "utf8");
  return { root, projectRoot };
}
