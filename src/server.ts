import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Orchestrator } from "./orchestrator.js";
import { adapterSchema, planBundleSchema, taskGraphSchema } from "./types.js";

const server = new McpServer({
  name: "open-woker-team",
  version: "0.1.0"
});

const orchestrator = new Orchestrator();

server.registerTool(
  "orchestrator_create_plan_bundle",
  {
    title: "Create plan bundle",
    description: "Create a Codex-authored plan bundle for the orchestrator lead worker.",
    inputSchema: planBundleSchema.shape
  },
  async (args) => asToolResult(await orchestrator.createPlanBundle(args))
);

server.registerTool(
  "orchestrator_refine_task_graph",
  {
    title: "Refine task graph",
    description: "Turn a plan bundle into a draft task DAG for user review before execution.",
    inputSchema: {
      planId: z.string(),
      adapter: adapterSchema.optional(),
      tasks: z.array(taskGraphSchema.shape.tasks.element).optional()
    }
  },
  async (args) => asToolResult(await orchestrator.refineTaskGraph(args))
);

server.registerTool(
  "orchestrator_approve_task_graph",
  {
    title: "Approve task graph",
    description: "Approve a task graph so it may be executed in a sandbox.",
    inputSchema: {
      graphId: z.string()
    }
  },
  async (args) => asToolResult(await orchestrator.approveTaskGraph(args))
);

server.registerTool(
  "orchestrator_start_run",
  {
    title: "Start orchestrated run",
    description: "Create a sandbox and start executing the approved task graph in the background.",
    inputSchema: {
      graphId: z.string()
    }
  },
  async (args) => asToolResult(await orchestrator.startRunDetached(args))
);

server.registerTool(
  "orchestrator_stop_run",
  {
    title: "Stop orchestrated run",
    description: "Request cancellation for an active run and stop any worker CLI process this server still owns.",
    inputSchema: {
      runId: z.string(),
      reason: z.string().optional()
    }
  },
  async (args) => asToolResult(await orchestrator.stopRun(args))
);

server.registerTool(
  "orchestrator_get_run",
  {
    title: "Get run",
    description: "Read complete run state.",
    inputSchema: {
      runId: z.string(),
      limit: z.number().int().positive().max(200).optional()
    }
  },
  async (args) => asToolResult(await orchestrator.getRun(args))
);

server.registerTool(
  "orchestrator_tail_run",
  {
    title: "Tail run",
    description: "Read compact run status, task statuses, checks, and final acceptance summary.",
    inputSchema: {
      runId: z.string()
    }
  },
  async (args) => asToolResult(await orchestrator.tailRun(args))
);

server.registerTool(
  "orchestrator_get_acceptance_package",
  {
    title: "Get acceptance package",
    description: "Read the final acceptance package for a completed run.",
    inputSchema: {
      runId: z.string()
    }
  },
  async (args) => asToolResult(await orchestrator.getAcceptancePackage(args))
);

server.registerTool(
  "orchestrator_publish_run",
  {
    title: "Publish run",
    description: "After user/Codex approval, transactionally publish sandbox changes to the real project.",
    inputSchema: {
      runId: z.string()
    }
  },
  async (args) => asToolResult(await orchestrator.publishRun(args))
);

server.registerTool(
  "orchestrator_rollback_publish",
  {
    title: "Rollback publish",
    description: "Rollback a published run using its file-level publish manifest.",
    inputSchema: {
      runId: z.string().optional(),
      manifestPath: z.string().optional()
    }
  },
  async (args) => asToolResult(await orchestrator.rollbackPublish(args))
);

function asToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
