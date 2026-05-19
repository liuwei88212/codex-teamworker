import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ignoredDirs = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".tmp"]);

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await ensureDir(destination);
  await cp(source, destination, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      return !name || !ignoredDirs.has(name);
    }
  });
}

export interface FileSnapshot {
  files: Record<string, string>;
}

export async function snapshotDirectory(root: string): Promise<FileSnapshot> {
  const files: Record<string, string> = {};
  for (const file of await listFiles(root)) {
    files[file] = await hashFile(join(root, file));
  }
  return { files };
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of Object.entries(after.files)) {
    if (before.files[file] !== hash) changed.add(file);
  }
  for (const file of Object.keys(before.files)) {
    if (!(file in after.files)) changed.add(file);
  }
  return [...changed].sort();
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out.sort();
}

async function walk(root: string, current: string, out: string[]): Promise<void> {
  if (!(await pathExists(current))) return;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
    } else if (entry.isFile()) {
      out.push(relative(root, abs).replace(/\\/g, "/"));
    }
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith("\\\\"))) {
    return resolvedTarget;
  }
  throw new Error(`Path is outside root: ${target}`);
}

export async function copyFileWithParents(source: string, destination: string): Promise<void> {
  await ensureDir(dirname(destination));
  await copyFile(source, destination);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
