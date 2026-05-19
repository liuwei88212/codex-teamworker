import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { orchestratorConfigSchema, type OrchestratorConfig } from "./types.js";

export function loadOrchestratorConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const fileConfig = readConfigFile();
  return normalizeConfig({ ...fileConfig, ...overrides });
}

export function normalizeConfig(input: unknown): OrchestratorConfig {
  const raw = unwrapConfig(input);
  const normalized = { ...raw } as Record<string, unknown>;
  if (normalized.leader && !normalized.leadModel) normalized.leadModel = normalized.leader;
  if (normalized.worker && !normalized.workerModel) normalized.workerModel = normalized.worker;
  normalized.leadModel = normalizeModel(normalized.leadModel);
  normalized.workerModel = normalizeModel(normalized.workerModel);
  return orchestratorConfigSchema.parse(normalized);
}

export function defaultConfigPaths(): string[] {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return [
    process.env.OPEN_WOKER_TEAM_CONFIG,
    resolve(homedir(), ".codex", "open-woker-team", "config.json"),
    resolve(projectRoot, "config.json")
  ].filter((item): item is string => Boolean(item));
}

function readConfigFile(): Record<string, unknown> {
  for (const path of defaultConfigPaths()) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return unwrapConfig(parsed);
  }
  return {};
}

function unwrapConfig(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  if (record.config && typeof record.config === "object") return record.config as Record<string, unknown>;
  return record;
}

function normalizeModel(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const model = { ...(input as Record<string, unknown>) };
  if (typeof model.apiKey === "string" && !model.apiKeyEnv) {
    model.apiKeyEnv = model.apiKey;
  }
  return model;
}
