import { homedir } from "node:os";
import { resolve } from "node:path";

export function defaultStateRoot(): string {
  return resolve(homedir(), ".codex", "open-woker-team", "runs");
}

export function normalizePath(input: string): string {
  return resolve(input);
}
