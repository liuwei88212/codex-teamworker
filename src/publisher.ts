import { join } from "node:path";
import { createId, nowIso } from "./ids.js";
import {
  copyFileWithParents,
  ensureDir,
  listFiles,
  pathExists,
  readJson,
  removePath,
  writeJson
} from "./fs-utils.js";
import type { PublishEntry, PublishManifest, RunState } from "./types.js";

export class Publisher {
  async buildManifest(run: RunState): Promise<PublishManifest> {
    const backupRoot = join(run.runDir, "publish-backup", createId("backup"));
    const projectFiles = new Set(await listFiles(run.projectRoot));
    const sandboxFiles = new Set(await listFiles(run.sandboxRoot));
    const allFiles = new Set([...projectFiles, ...sandboxFiles]);
    const entries: PublishEntry[] = [];

    for (const file of [...allFiles].sort()) {
      const projectPath = join(run.projectRoot, file);
      const sandboxPath = join(run.sandboxRoot, file);
      const inProject = projectFiles.has(file);
      const inSandbox = sandboxFiles.has(file);
      if (inProject && inSandbox && await sameFile(projectPath, sandboxPath)) continue;
      if (!inProject && inSandbox) {
        entries.push({ path: file, action: "add", sandboxPath });
      } else if (inProject && !inSandbox) {
        entries.push({ path: file, action: "delete", backupPath: join(backupRoot, file) });
      } else {
        entries.push({ path: file, action: "modify", backupPath: join(backupRoot, file), sandboxPath });
      }
    }

    return {
      id: createId("publish"),
      runId: run.id,
      projectRoot: run.projectRoot,
      sandboxRoot: run.sandboxRoot,
      backupRoot,
      createdAt: nowIso(),
      entries
    };
  }

  async publish(run: RunState): Promise<PublishManifest> {
    const manifest = await this.buildManifest(run);
    await ensureDir(manifest.backupRoot);

    for (const entry of manifest.entries) {
      const projectPath = join(manifest.projectRoot, entry.path);
      if ((entry.action === "modify" || entry.action === "delete") && entry.backupPath) {
        if (await pathExists(projectPath)) await copyFileWithParents(projectPath, entry.backupPath);
      }
      if (entry.action === "delete") {
        await removePath(projectPath);
      } else if (entry.sandboxPath) {
        await copyFileWithParents(entry.sandboxPath, projectPath);
      }
    }

    manifest.publishedAt = nowIso();
    await writeJson(join(run.runDir, "publish-manifest.json"), manifest);
    return manifest;
  }

  async rollback(manifestPath: string): Promise<PublishManifest> {
    const manifest = await readJson<PublishManifest>(manifestPath);
    for (const entry of [...manifest.entries].reverse()) {
      const projectPath = join(manifest.projectRoot, entry.path);
      if (entry.action === "add") {
        await removePath(projectPath);
      } else if (entry.backupPath && await pathExists(entry.backupPath)) {
        await copyFileWithParents(entry.backupPath, projectPath);
      }
    }
    manifest.rolledBackAt = nowIso();
    await writeJson(manifestPath, manifest);
    return manifest;
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const [a, b] = await Promise.all([readFile(left), readFile(right)]);
  return a.equals(b);
}
