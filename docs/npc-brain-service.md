# NPC Brain Service（T006）

## 目标

在服务端新增 `NpcBrainService`，把 NPC 的灵魂设定、上下文和动作白名单输入到决策层，产出可直接执行的结构化动作列表。

## 服务端实现

- 文件：`src/server/NpcBrainService.js`
- 默认行为：
  - 默认使用 Ollama（`provider=ollama`，`endpoint=http://localhost:11434/v1/chat/completions`）
  - 当配置了 `NPC_BRAIN_PROVIDER` + `NPC_BRAIN_API_KEY` 时，调用对应 chat completions 接口
- 输出格式：`{ "actions": [ ... ] }`
- 动作会经过 `validateNpcActionList` 二次校验；无效输出自动降级为 `WAIT`
- 每次调用会输出原始请求/响应日志：
  - `[NpcBrain][LLMRequestRaw][traceId] ...`
  - `[NpcBrain][LLMResponseRaw][traceId] ...`

## 环境变量

- `NPC_BRAIN_PROVIDER`：provider 名称（默认 `ollama`）
- `NPC_BRAIN_API_KEY`：远端模型 API Key
- `NPC_BRAIN_MODEL`：模型名（默认 `qwen3-coder:latest`）
- `NPC_BRAIN_ENDPOINT`：Chat Completions 地址（默认 `http://localhost:11434/v1/chat/completions`）
- `NPC_BRAIN_TIMEOUT_MS`：请求超时（毫秒）
- `NPC_BRAIN_MAX_OUTPUT_TOKENS`：模型输出 token 上限
- `NPC_BRAIN_MAX_ACTIONS`：单次动作计划上限
- `NPC_BRAIN_AUTONOMOUS_INTERVAL_MS`：NPC 自动思考间隔（毫秒，默认 6000）
- `NPC_BRAIN_AUTONOMOUS_TICK_MS`：自动思考调度 tick（毫秒，默认 1000）

## 触发方式

1. 聊天触发（自动）
   - 事件：`npc.chat.send`
   - 服务端会调用 `NpcBrainService` 生成动作计划
   - 对玩家拥有的 NPC：通过 `npc.executeActions` 下发执行
   - 对系统 NPC：保持私聊回复链路，不中断对话

2. 手动触发（新增）
   - 事件：`npc.brain.decide`
   - 参数：`{ npcId: string, context?: string }`
   - 权限：仅 NPC 拥有者可触发
   - 客户端聊天指令：`/npc-brain <NPC_ID> [上下文]`

3. 自动触发（新增）
   - 玩家创建 NPC 后，服务端会自动触发一次 `spawn` 决策
   - 之后会按 `NPC_BRAIN_AUTONOMOUS_INTERVAL_MS` 周期触发 `autonomous` 决策
   - 仅对“有在线 owner 的玩家 NPC”生效（系统 NPC 不参与自动执行）

## 验收映射

- 模型输出可被解析并执行：
  - 决策输出统一解析为 `actions`，并进入 `npc.executeActions` 执行链路
- 无效输出可降级为 `WAIT`：
  - 任意解析失败/校验失败/请求失败，统一回退为 `WAIT`
