import { describe, expect, it } from "vitest";
import { determineWorkerStatus, parseClaudeCodeOutput, parseOpenCodeExport } from "../src/workers.js";

describe("worker output parsing", () => {
  it("extracts claudecode result text from stream-json output", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial text" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "final text", session_id: "session_1" })
    ].join("\n");

    expect(parseClaudeCodeOutput(stdout)).toBe("final text");
  });

  it("extracts opencode assistant text from export output", () => {
    const stdout = `${JSON.stringify({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        {
          info: { role: "assistant" },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "hello from opencode" }
          ]
        }
      ]
    }, null, 2)}\nExporting session: ses_test`;

    expect(parseOpenCodeExport(stdout)).toBe("hello from opencode");
  });
});

describe("worker status", () => {
  const passingChecks = [{ command: "npm run analyze", exitCode: 0, stdout: "", stderr: "", passed: true }];
  const expectedTask = { expectedOutputs: ["artifacts/state_population.json exists"] };

  it("passes opencode timeout when export summary, changes, and checks are present", () => {
    const status = determineWorkerStatus(
      "opencode",
      { exitCode: null, stdout: "{\"sessionID\":\"ses_test\"}", stderr: "Command timed out after 180000ms." },
      { summary: "Done.", sessionId: "ses_test", exportOk: true },
      ["artifacts/state_population.json"],
      passingChecks,
      expectedTask
    );

    expect(status).toBe("passed");
  });

  it("fails opencode timeout when checks fail", () => {
    const status = determineWorkerStatus(
      "opencode",
      { exitCode: null, stdout: "{\"sessionID\":\"ses_test\"}", stderr: "Command timed out after 180000ms." },
      { summary: "Done.", sessionId: "ses_test", exportOk: true },
      ["artifacts/state_population.json"],
      [{ command: "npm run analyze", exitCode: 1, stdout: "", stderr: "failed", passed: false }],
      expectedTask
    );

    expect(status).toBe("failed");
  });

  it("fails opencode nonzero exit without a session id", () => {
    const status = determineWorkerStatus(
      "opencode",
      { exitCode: 1, stdout: "", stderr: "failed" },
      { summary: "" },
      ["artifacts/state_population.json"],
      passingChecks,
      expectedTask
    );

    expect(status).toBe("failed");
  });

  it("fails opencode timeout when export fails", () => {
    const status = determineWorkerStatus(
      "opencode",
      { exitCode: null, stdout: "{\"sessionID\":\"ses_test\"}", stderr: "Command timed out after 180000ms." },
      { summary: "", sessionId: "ses_test", exportOk: false },
      ["artifacts/state_population.json"],
      passingChecks,
      expectedTask
    );

    expect(status).toBe("failed");
  });

  it("fails when expected outputs are declared but no files changed", () => {
    const status = determineWorkerStatus(
      "opencode",
      { exitCode: 0, stdout: "{\"sessionID\":\"ses_test\"}", stderr: "" },
      { summary: "Done.", sessionId: "ses_test", exportOk: true },
      [],
      passingChecks,
      expectedTask
    );

    expect(status).toBe("failed");
  });
});
