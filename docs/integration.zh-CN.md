# open-woker-team 集成指南

本文说明如何把 `open-woker-team` 集成到 Codex / MCP 客户端，并完成一次从计划、任务确认、沙箱执行、验收到发布回滚的完整流程。

## 1. 构建项目

```powershell
cd E:\workspace\claudecode\open-woker-team
npm install
npm run build
```

MCP 入口：

```text
E:\workspace\claudecode\open-woker-team\dist\src\server.js
```

## 2. Codex MCP 配置

```toml
[mcp_servers.open_woker_team]
command = "node"
args = ["E:\\workspace\\claudecode\\open-woker-team\\dist\\src\\server.js"]
```

修改后重启 Codex Desktop。

## 3. Adapter 和模型配置

可用 adapter：

```text
opencode | claudecode | mock
```

推荐使用 `claudecode`：

```json
{
  "config": {
    "adapter": "claudecode",
    "leader": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "DEEPSEEK_API_KEY"
    },
    "worker": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "DEEPSEEK_API_KEY"
    }
  }
}
```

## 4. Claude Code CLI 模式

`claudecode` adapter 使用 Claude Code 的非交互 print/headless 模式：

```powershell
claude -p --output-format stream-json --verbose --model deepseek-v4-flash --max-turns 20 --permission-mode bypassPermissions
```

prompt 通过 stdin 写入，避免 Windows npm shim 对长中文参数的转义和编码问题。

## 5. 推荐工作流

1. Codex 生成开发计划，调用 `orchestrator_create_plan_bundle`。
2. 调用 `orchestrator_refine_task_graph`，由组长 worker 生成任务 DAG。
3. Codex 展示返回值里的 `reviewSummary`，让用户确认任务分配。
4. 用户确认后调用 `orchestrator_approve_task_graph`。
5. 调用 `orchestrator_start_run`，立即返回 `runId`，后台开始沙箱执行。
6. Codex 周期性调用 `orchestrator_tail_run` 查看 run 状态、task 状态、worker 工具调用、worker 消息和最近事件。
7. 如果用户或 Codex 决定中断，调用 `orchestrator_stop_run`，传入 `runId` 和取消原因。
8. 组长执行 LeaderReview，必要时在 `maxReworkAttempts` 预算内自动指派返工。
9. run 完成后调用 `orchestrator_get_acceptance_package`。
10. 用户确认验收后才调用 `orchestrator_publish_run`。
11. 发布后如有问题，调用 `orchestrator_rollback_publish`。

这个流程保持：

```text
question -> agent -> subagents -> result
```

Codex 仍是产品经理和最终验收方；open-woker-team 是开发组长；CLI adapter 是子 worker 执行层。

## 6. 任务确认

`orchestrator_refine_task_graph` 返回的任务图默认是 `draft` 状态，并包含 `reviewSummary`。

`reviewSummary` 会列出：

- 每个子任务的 taskId、adapter、模型
- 任务依赖
- 负责路径
- 验收标准
- 整体检查命令

未确认前，`orchestrator_start_run` 会拒绝执行。只有调用 `orchestrator_approve_task_graph` 后，任务图才允许进入沙箱执行。

## 7. 事件和可观测性

每个 run 都会写入：

```text
%USERPROFILE%\.codex\open-woker-team\runs\run_xxx\events.jsonl
```

典型事件：

- `run_started`
- `task_started`
- `worker_session_started`
- `worker_tool_used`
- `worker_message`
- `worker_session_finished`
- `task_finished`
- `run_cancel_requested`
- `run_canceled`
- `run_finished`

`orchestrator_tail_run` 返回最近事件，Codex 可以像调用 worker MCP 的 `tail job` 一样展示阶段性进展。

## 8. 验收包

`orchestrator_get_acceptance_package` 会返回：

- `projectRoot`：真实项目目录
- `runDir`：本次 run 的状态目录
- `sandboxRoot`：沙箱项目目录
- `readmePath` 和 `readmeContent`
- `runInstructions`：运行说明
- `changedFiles`
- `taskResults`
- `checks`
- `leaderReview`
- `recommendation`
- `nextTool`

Codex 应把沙箱位置、运行方式和 README 内容一起展示给用户。

`leaderReview` 是组长给 Codex 的最终审查报告。它会说明每个子任务是否满足要求、有哪些证据、是否还有 gaps、是否建议发布或人工审查。

## 9. 安全边界

- worker 只修改沙箱。
- 真实项目只在 `orchestrator_publish_run` 时写入。
- 发布前创建文件级备份。
- 回滚依赖 `publish-manifest.json` 和备份文件。
- Git 不是硬依赖，无 Git 项目也可以发布和回滚。

## 10. 验证命令

```powershell
npm run typecheck
npm test
npm run build
```
