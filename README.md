# teamworker

`teamworker` 是一个 **Vibe Coding Orchestrator MCP**。它的定位是“开发组长 worker”：Codex 负责提出需求、制定计划、确认任务分配和最终验收；teamworker 负责接收计划、拆分任务图、调度子 worker、检查完成质量、必要时发起返工，并把最终结果回报给 Codex。

真实项目目录不会在 worker 执行阶段被修改。所有开发先发生在沙箱副本中；只有你明确调用发布工具后，沙箱结果才会按 `publish-manifest.json` 事务写回真实项目，并支持文件级回滚。

## 核心流程

```text
question -> leader agent -> subagents -> leader review -> result -> Codex approval
```

1. Codex 创建 `PlanBundle`，描述需求、模块、约束、验收标准和检查命令。
2. teamworker 生成 `TaskGraph`，返回 `reviewSummary` 给 Codex 展示。
3. Codex 或用户确认任务分配后，调用 `orchestrator_approve_task_graph`。
4. teamworker 创建沙箱并后台执行任务 DAG。
5. Codex 通过 `orchestrator_tail_run` 查看组长、组员和检查进度。
6. 子 worker 完成后，组长生成 `LeaderReview`。
7. 如果仍有 gaps，组长会在 `maxReworkAttempts` 预算内把任务重新派给对应 worker。
8. 全部完成后生成 `acceptancePackage`，包含沙箱路径、运行说明、README 内容、变更文件、检查结果和下一步建议。
9. Codex 验收通过后，才调用 `orchestrator_publish_run` 发布到真实项目。

## 当前能力

- 接收 Codex 生成的 `PlanBundle`
- 生成可确认的 `TaskGraph` 和任务分配摘要 `reviewSummary`
- 保持 `question -> agent -> subagents -> result` 的组长-组员流程
- 在沙箱中执行任务，默认不修改真实项目
- 支持 `opencode`、`claudecode`、`mock` worker adapter
- 后台启动 run，并通过事件流查看 worker 进度
- 支持 `orchestrator_stop_run` 取消活跃 run
- 组长在 worker 完成后执行 `LeaderReview`
- 支持有限次数自动返工
- 保存 JSON / JSONL 状态、事件、任务结果和验收包
- 支持事务发布和文件级回滚

## 安装

```powershell
cd D:\workspace\codex\codex-teamworker
npm install
npm run build
```

## Codex MCP 配置

推荐直接指向构建后的 server：

```toml
[mcp_servers.teamworker]
command = "node"
args = ["D:\\workspace\\codex\\codex-teamworker\\dist\\src\\server.js"]
```

修改 Codex 配置后通常需要重启 Codex Desktop。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `orchestrator_create_plan_bundle` | 创建 Codex 计划包 |
| `orchestrator_refine_task_graph` | 生成任务 DAG 和待确认任务分配摘要 |
| `orchestrator_approve_task_graph` | 确认任务图，允许进入执行阶段 |
| `orchestrator_start_run` | 创建沙箱并在后台开始执行 |
| `orchestrator_stop_run` | 请求取消活跃 run，并停止当前 worker/check 进程 |
| `orchestrator_tail_run` | 查看 run 状态、任务状态、最近事件和验收摘要 |
| `orchestrator_get_run` | 读取完整 run 状态 |
| `orchestrator_get_acceptance_package` | 读取最终验收包 |
| `orchestrator_publish_run` | Codex 验收后发布沙箱结果到真实项目 |
| `orchestrator_rollback_publish` | 按发布 manifest 回滚 |

## 配置文件

读取优先级：

1. `TEAMWORKER_CONFIG` 指定的文件
2. `OPEN_WOKER_TEAM_CONFIG` 指定的文件（兼容旧配置）
3. `%USERPROFILE%\.codex\teamworker\config.json`
4. `%USERPROFILE%\.codex\open-woker-team\config.json`（兼容旧配置）
5. 项目内 `D:\workspace\codex\codex-teamworker\config.json`

示例：

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
    },
    "adapters": {
      "opencode": {
        "command": "opencode",
        "args": ["run", "--format", "json", "--model", "{{provider}}/{{model}}"],
        "timeoutMs": 180000
      },
      "claudecode": {
        "command": "claude",
        "args": ["-p", "--output-format", "stream-json", "--verbose", "--model", "{{model}}", "--max-turns", "20", "--permission-mode", "bypassPermissions"],
        "timeoutMs": 300000
      }
    },
    "maxReworkAttempts": 1
  }
}
```

`apiKey` 推荐填写环境变量名，例如 `DEEPSEEK_API_KEY`。真实 key 可以放在环境变量里，避免写进项目文件。

可用 adapter：

```text
opencode | claudecode | mock
```

## Worker Adapter

| Adapter | 用途 |
| --- | --- |
| `opencode` | 使用 OpenCode CLI；结果优先通过 session export 读取 |
| `claudecode` | 使用 Claude Code CLI headless 模式；通过 `stream-json` 捕获过程事件 |
| `mock` | 测试和空跑，不做真实代码修改 |

Claude Code adapter 默认使用非交互模式：

```powershell
claude -p --output-format stream-json --verbose --model <model> --max-turns 20 --permission-mode bypassPermissions
```

prompt 会通过 stdin 写入，避免 Windows npm shim 对长中文参数的转义和编码问题。adapter 会把 `system/init`、assistant 文本、工具调用和 `result` 转换为 `events.jsonl` 中的 worker 事件，Codex 可以通过 `orchestrator_tail_run` 看到执行到哪一步。

## 任务确认

`orchestrator_refine_task_graph` 返回的任务图默认是 `draft` 状态，并包含 `reviewSummary`。Codex 应先把这个摘要展示给用户确认，里面包含：

- 每个子任务的 taskId、adapter、模型
- 依赖关系
- 负责路径
- 验收标准
- 整体检查命令

只有调用 `orchestrator_approve_task_graph` 后，`orchestrator_start_run` 才会执行。未确认的任务图会被拒绝。

## 运行与进度

`orchestrator_start_run` 会立即返回 run 状态，真实执行在后台进行。Codex 应周期性调用：

```text
orchestrator_tail_run
```

典型事件包括：

- `run_started`
- `task_started`
- `worker_session_started`
- `worker_tool_used`
- `worker_message`
- `worker_session_finished`
- `task_finished`
- `leader_check_started`
- `leader_check_finished`
- `leader_review_started`
- `leader_review_finished`
- `leader_rework_started`
- `run_finished`

## 停止运行

如果 Codex 或用户决定中断当前开发任务，应调用 `orchestrator_stop_run`：

```json
{
  "runId": "run_xxx",
  "reason": "用户中断本轮开发"
}
```

它会把 run 先标记为 `cancel_requested`，然后向当前 worker CLI 或检查命令发送终止信号；最终状态会落盘为 `canceled`，并在 `events.jsonl` 中记录：

- `run_cancel_requested`
- `run_canceled`

注意：如果 MCP 服务进程本身已经被客户端强制退出，它无法再接收 stop 调用；这种情况下由操作系统或客户端负责清理子进程。只要服务仍在运行，`orchestrator_stop_run` 就是推荐的显式终止入口。

## 组长审查和返工

任务执行后，teamworker 会生成 `leaderReview`：

- 每个任务是否满足分配要求
- 子 worker 结果、变更文件和检查结果证据
- 发现的 gaps
- 是否需要返工
- 建议下一步工具

如果 `leaderReview` 判断需要返工，且还没有超过 `maxReworkAttempts`，组长会把 gaps 追加到原任务描述中，重新派给对应 worker。返工仍然复用原 taskId，方便 Codex 看到同一个任务的修复历史。

最终 `acceptancePackage` 会包含：

- `projectRoot`：真实项目路径
- `runDir`：本次 run 的状态目录
- `sandboxRoot`：沙箱项目路径
- `readmePath` 和 `readmeContent`
- `runInstructions`：运行说明
- `changedFiles`
- `taskResults`
- `checks`
- `leaderReview`
- `recommendation`: `publish | rework | manual_review | ask_codex`
- `nextTool`

Codex 应把沙箱位置、运行方式和 README 内容一起展示给用户。

## 发布与回滚

发布前，teamworker 会比较真实项目和沙箱差异，生成发布 manifest，并备份受影响文件。只有调用 `orchestrator_publish_run` 后，沙箱内容才会写回真实项目。

如果发布后需要撤回，可以调用 `orchestrator_rollback_publish`。回滚基于 `publish-manifest.json` 和 `publish-backup/`，不依赖 Git，因此无 Git 项目也可以发布和回滚。

## 状态目录

默认状态根目录：

```text
%USERPROFILE%\.codex\teamworker\runs
```

每次运行会保存：

- `run.json`
- `events.jsonl`
- `acceptance-package.json`
- `tasks/*.json`
- `sandbox/`
- `publish-manifest.json`
- `publish-backup/`

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

## 集成文档

- [中文集成指南](docs/integration.zh-CN.md)
