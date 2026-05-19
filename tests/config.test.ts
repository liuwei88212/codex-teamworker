import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes user-facing config aliases", () => {
    const config = normalizeConfig({
      config: {
        adapter: "claudecode",
        leader: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
          apiKey: "DEEPSEEK_API_KEY"
        },
        worker: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          baseUrl: "https://api.deepseek.com",
          apiKey: "DEEPSEEK_API_KEY"
        }
      }
    });

    expect(config.adapter).toBe("claudecode");
    expect(config.leadModel.model).toBe("deepseek-v4-pro");
    expect(config.workerModel.model).toBe("deepseek-v4-flash");
    expect(config.workerModel.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
  });
});
