# NPC Brain Service（T006）

## 目标

在服务端新增 `NpcBrainService`，把 NPC 的灵魂设定、上下文和动作白名单输入到决策层，产出可直接执行的结构化动作列表。

## 服务端实现

- 文件：`src/server/NpcBrainService.js`
- 默认行为：
  - 当未配置 LLM 凭证时，走 `mock` 决策（本地可用）
  - 当配置了 `NPC_BRAIN_PROVIDER` + `NPC_BRAIN_API_KEY` 时，调用远端 chat completions 接口
- 输出格式：`{ "actions": [ ... ] }`
- 动作会经过 `validateNpcActionList` 二次校验；无效输出自动降级为 `WAIT`

## 环境变量

- `NPC_BRAIN_PROVIDER`：`mock`（默认）或其他自定义 provider 名称
- `NPC_BRAIN_API_KEY`：远端模型 API Key
- `NPC_BRAIN_MODEL`：模型名（默认 `gpt-4o-mini`）
- `NPC_BRAIN_ENDPOINT`：Chat Completions 地址（默认 `https://api.openai.com/v1/chat/completions`）
- `NPC_BRAIN_TIMEOUT_MS`：请求超时（毫秒）
- `NPC_BRAIN_MAX_OUTPUT_TOKENS`：模型输出 token 上限
- `NPC_BRAIN_MAX_ACTIONS`：单次动作计划上限

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

## 验收映射

- 模型输出可被解析并执行：
  - 决策输出统一解析为 `actions`，并进入 `npc.executeActions` 执行链路
- 无效输出可降级为 `WAIT`：
  - 任意解析失败/校验失败/请求失败，统一回退为 `WAIT`
