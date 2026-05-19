import type { Task, TaskGraph } from "./types.js";

export function validateTaskGraph(graph: TaskGraph): void {
  const ids = new Set<string>();
  for (const task of graph.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id} depends on unknown task: ${dep}`);
    }
  }
  topologicalTasks(graph.tasks);
}

export function topologicalTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: Task[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected at task: ${id}`);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    visiting.add(id);
    for (const dep of task.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  }

  for (const task of tasks) visit(task.id);
  return ordered;
}

export function readyTasks(tasks: Task[], completed: Set<string>, running: Set<string>, failed: Set<string>): Task[] {
  return tasks.filter((task) => {
    if (completed.has(task.id) || running.has(task.id) || failed.has(task.id)) return false;
    return task.dependsOn.every((dep) => completed.has(dep));
  });
}
