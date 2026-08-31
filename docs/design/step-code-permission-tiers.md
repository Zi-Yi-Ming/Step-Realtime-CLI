# step-code Permission Tiers 设计借鉴

> 来源：`evals/step-code-explore/src/agent/permission/mode.ts`（li-xiu-qi/step-code-explore v0.1.2）
> 目的：提炼其权限分层与 plan 模式守卫设计，评估是否值得引入 step-cli。

## 1. 三层梯度权限模式

step-code 定义了三档用户意图，从"完全不打扰"到"逐项确认"：

| 模式     | 只读工具 | 写工具 | 执行工具 | 语义                    |
| -------- | -------- | ------ | -------- | ----------------------- |
| `yolo`   | allow    | allow  | allow    | 全部放行，从不打扰      |
| `auto`   | allow    | allow  | ask      | 只读/写放行；执行需确认 |
| `manual` | allow    | ask    | ask      | 只读放行；写/执行需确认 |

**关键设计**：

- **只读工具白名单**（`READ_ONLY_TOOLS`）：`read_file`, `list_dir`, `glob`, `grep`, `web_search`, `web_fetch`, `spawn_agent`, `ask_user` 等。这些工具在任何模式下都直接放行。
- **写工具集合**（`WRITE_TOOLS`）：`write_file`, `edit_file`。
- **执行工具集合**（`EXEC_TOOLS`）：`bash`（可执行任意命令，风险最高）。

## 2. Plan 模式硬守卫

step-code 在权限层直接拦截 plan 模式下的写/执行工具：

```typescript
export function planModeDenyReason(toolName: string): string | null {
  if (toolName === "exit_plan_mode") return null; // 唯一放行的出口
  if (READ_ONLY_TOOLS.has(toolName)) return null; // 只读调查放行
  return `计划模式已开启：当前只能做只读调查，不能修改文件或执行命令（${toolName} 被拦截）。请完成调查后调用 exit_plan_mode 提交计划供用户确认。`;
}
```

**设计要点**：

- Plan 模式下**硬拒绝**写/执行工具，不经过确认流程。
- 只放行只读调查工具 + `exit_plan_mode`（作为出口）。
- 拒绝原因作为 `tool_result` 回灌模型，让模型理解为何被拦。

## 3. 会话级批准缓存

step-code 维护 `sessionApprovals` 集合：

- 用户在某次会话中批准过的工具名，后续同类调用直接放行。
- 这减少了重复确认开销，同时保留了用户对单次会话的审计能力。

## 4. 启动模式解析优先级

```
CLI flag (--yolo/--auto) > config.toml permission_mode > 恢复会话存储的 mode > manual（默认）
```

**设计要点**：

- 一次性意图（CLI flag）压过常驻偏好（config）。
- 恢复会话时继承之前的模式，保持连续性。

## 5. 与 step-cli 当前设计的对比

### step-cli 当前权限模型

| 概念       | step-cli                                     | step-code                            |
| ---------- | -------------------------------------------- | ------------------------------------ |
| 全局模式   | `approval-mode`: confirm/auto/strict         | `yolo`/`auto`/`manual`               |
| 非交互行为 | `non-interactive-approval`: allow/deny       | 无显式配置（依赖模式默认）           |
| 单工具覆盖 | `--tool-override <tool>=<mode>`              | 无                                   |
| Plan 守卫  | `--mode plan` + 工具级 `operatingModes` 过滤 | 权限层硬拦截 + `exit_plan_mode` 出口 |
| 工具分类   | `ToolRiskLevel`: read/meta/write/exec        | READ_ONLY / WRITE / EXEC 三集合      |
| 会话缓存   | 无                                           | `sessionApprovals`                   |

### step-cli 的优势

1. **更细粒度的 per-tool override**：`--tool-override` 允许对单个工具设置权限，step-code 没有此机制。
2. **严格的 plan 模式集成**：step-cli 的 `operatingModes` 在工具注册时声明，gateway 在工具发现阶段过滤，模型根本看不到被隐藏的工具。
3. **non-interactive-approval 显式控制**：明确区分"交互式确认"和"非交互式默认行为"。

### step-code 的优势

1. **三档梯度更直觉**：`yolo`/`auto`/`manual` 比 `confirm`/`auto`/`strict` 更容易理解。
2. **Plan 模式守卫更彻底**：权限层直接拦截，拒绝原因回灌模型上下文，而不是单纯隐藏工具。
3. **会话批准缓存**：减少重复确认，提升连续工具调用体验。

## 6. 可借鉴点

### 6.1 引入 `yolo` 别名（低风险）

将 `--approval-mode yolo` 映射为内部 `strict=false, nonInteractive=allow, toolOverride={all: allow}`。

- 无需改核心权限逻辑，仅做 CLI 层别名。
- 降低用户认知成本："yolo" 比 "strict=false + non-interactive-approval allow" 更直觉。

### 6.2 Plan 模式拒绝原因回灌（中风险）

当前 step-cli 在 plan 模式下通过 `filterToolSpecsForOperatingMode` 隐藏写/执行工具。模型看不到这些工具，但也不清楚为何某些调用被忽略。

**借鉴方案**：

- 当模型尝试调用被 plan 模式拦截的工具时，返回结构化 `tool_result`：
  ```json
  {
    "ok": false,
    "summary": "Plan mode active: write/edit/exec tools are blocked",
    "error": {
      "code": "PLAN_MODE_BLOCKED",
      "message": "Use exit_plan_mode to submit your plan for user approval"
    }
  }
  ```
- 这样模型能明确知道"不是工具不存在，而是当前模式不允许"。

### 6.3 会话级工具批准缓存（中风险）

维护一个 `Set<string>` 记录本会话已批准的工具名：

- 用户确认某工具后，后续同类调用直接放行。
- 新会话/重启后清空。
- 需要持久化到 session store 或内存中。

### 6.4 工具风险三级分类（低风险，已部分实现）

step-cli 已有 `ToolRiskLevel`（read/meta/write/exec），可以：

- 显式定义 `READ_ONLY = new Set(["read_file", "list_directory", ...])`
- `WRITE = new Set(["apply_patch", "edit_file", ...])`
- `EXEC = new Set(["exec", "run_command", ...])`
- 在 `approval-mode=auto` 时自动放行 read+write，ask exec。

## 7. 不建议借鉴的部分

1. **step-code 的 `bash` 单工具执行一切**：step-cli 的 Code Mode 架构更安全（exec 沙盒 + 细粒度工具绑定），不应退化为单一大工具。
2. **无 per-tool override**：step-cli 的 `--tool-override` 是差异化优势，应保留。
3. **accessConflict 路径重叠检测**：step-cli 当前是单工作区 + 沙盒路径校验，不需要多 agent 并发访问冲突检测。

## 8. 总结

step-code 的 permission tier 设计核心是**三档梯度 + plan 硬守卫 + 会话缓存**。step-cli 当前的权限模型更细粒度（per-tool override + operatingModes 声明式过滤），但在**用户认知成本**和**plan 模式反馈清晰度**上有提升空间。

最高价值的借鉴是 **plan 模式拒绝原因回灌**（6.2），它直接解决了 FM3 的一个子问题：模型分不清"工具不存在"和"当前模式不允许"。
