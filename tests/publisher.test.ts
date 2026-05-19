import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ensureDir } from "../src/fs-utils.js";
import { Publisher } from "../src/publisher.js";
import type { RunState } from "../src/types.js";

describe("publisher", () => {
  it("publishes and rolls back file-level changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "owt-publish-"));
    const projectRoot = join(root, "project");
    const sandboxRoot = join(root, "sandbox");
    const runDir = join(root, "run");
    await ensureDir(projectRoot);
    await ensureDir(sandboxRoot);
    await ensureDir(runDir);
    await writeFile(join(projectRoot, "keep.txt"), "old", "utf8");
    await writeFile(join(sandboxRoot, "keep.txt"), "new", "utf8");
    await writeFile(join(sandboxRoot, "add.txt"), "added", "utf8");

    const run: RunState = {
      id: "run",
      planId: "plan",
      graphId: "graph",
      projectRoot,
      sandboxRoot,
      runDir,
      status: "passed",
      createdAt: new Date().toISOString(),
      taskStatuses: {},
      workerResults: [],
      checks: [],
      leaderReviews: []
    };

    const publisher = new Publisher();
    const manifest = await publisher.publish(run);
    expect(await readFile(join(projectRoot, "keep.txt"), "utf8")).toBe("new");
    expect(await readFile(join(projectRoot, "add.txt"), "utf8")).toBe("added");

    await publisher.rollback(join(runDir, "publish-manifest.json"));
    expect(await readFile(join(projectRoot, "keep.txt"), "utf8")).toBe("old");
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(["add.txt", "keep.txt"]);
  });
});
