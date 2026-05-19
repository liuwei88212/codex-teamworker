import { join } from "node:path";
import { createId } from "./ids.js";
import { copyDirectory, diffSnapshots, ensureDir, snapshotDirectory, type FileSnapshot } from "./fs-utils.js";

export interface Sandbox {
  id: string;
  projectRoot: string;
  sandboxRoot: string;
  before: FileSnapshot;
}

export class SandboxManager {
  constructor(private readonly stateRoot: string) {}

  async create(projectRoot: string, runId: string): Promise<Sandbox> {
    const id = createId("sandbox");
    const sandboxRoot = join(this.stateRoot, runId, "sandbox");
    await ensureDir(sandboxRoot);
    await copyDirectory(projectRoot, sandboxRoot);
    return {
      id,
      projectRoot,
      sandboxRoot,
      before: await snapshotDirectory(sandboxRoot)
    };
  }

  async changedFiles(sandbox: Pick<Sandbox, "sandboxRoot" | "before">): Promise<string[]> {
    const after = await snapshotDirectory(sandbox.sandboxRoot);
    return diffSnapshots(sandbox.before, after);
  }
}
