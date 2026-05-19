import { describe, expect, it } from "vitest";
import { topologicalTasks, validateTaskGraph } from "../src/graph.js";
import type { TaskGraph } from "../src/types.js";

describe("task graph", () => {
  it("sorts tasks by dependency order", () => {
    const ordered = topologicalTasks([
      task("b", ["a"]),
      task("a", [])
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("rejects cycles", () => {
    const graph: TaskGraph = {
      id: "graph",
      planId: "plan",
      projectRoot: "/tmp/project",
      status: "draft",
      createdAt: new Date().toISOString(),
      tasks: [task("a", ["b"]), task("b", ["a"])],
      checks: [],
      notes: []
    };
    expect(() => validateTaskGraph(graph)).toThrow(/Cycle detected/);
  });
});

function task(id: string, dependsOn: string[]) {
  return {
    id,
    title: id,
    description: id,
    adapter: "mock" as const,
    dependsOn,
    allowedPaths: [],
    inputs: [],
    expectedOutputs: [],
    validation: []
  };
}
