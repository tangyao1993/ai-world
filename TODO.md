# AI NPC 改造 TODO List

> 使用说明
> - `状态` 仅使用：`未开始` / `进行中` / `已完成` / `阻塞`
> - 完成后将状态标记成已完成
> - 每项建议保持“可独立验收”

## 总览

| ID | 任务 | 状态 | 优先级 | 完成说明 |
|---|---|---|---|---|
| T001 | 建立 NPC 数据模型（含灵魂、姓名、性别等） | 已完成 | P0 | 新增 `src/types/Npc.ts` 与 `src/models/Npc.ts`，并在 `WorldScene` 创建示例 NPC 完成可视化验收 |
| T002 | 服务端维护 NPC 状态并同步给客户端 | 已完成 | P0 | 服务端新增 `state.npcs`，连接时下发 `currentNpcs`，并支持 `npc.created` / `npc.updated` / `npc.removed` 实时广播 |
| T003 | 客户端渲染 NPC 并接入现有实体系统 | 已完成 | P0 | 客户端新增 `currentNpcs` 全量同步和 `npc.created` / `npc.updated` / `npc.removed` 增量事件处理，`WorldScene` 已实现 NPC 生命周期管理并注册到 `EntityActionManager` |
| T004 | 定义 AI 可执行动作协议（白名单） | 已完成 | P0 | 新增 `src/npc/NpcActionProtocol.ts` 白名单校验与 `docs/npc-action-protocol.md` 协议文档 |
| T005 | 实现 NPC 动作执行器（移动/对话/朝向/等待） | 已完成 | P0 | 新增 `src/services/NpcActionExecutor.ts`，实现动作校验后顺序入队执行；新增 NPC 专用动作事件并在 `EntityActionProcessor` 完成移动/对话/朝向映射；执行失败自动回退到 `WAIT` |
| T006 | 接入 LLM 决策服务（结构化输出） | 已完成 | P0 | 新增 `src/server/NpcBrainService.js`（支持 mock/远端 LLM），并在 `npc.chat.send` 与 `npc.brain.decide` 中接入“决策->动作计划->执行”链路；无效输出统一回退 `WAIT` |
| T007 | 实现 NPC 对话通道（玩家与 NPC） | 已完成 | P0 | 支持 `/npc <NPC_ID> <消息>` 发起私聊，服务端返回 NPC 回复并仅投递给目标玩家；聊天 UI 已区分世界/私聊并展示 NPC 身份信息 |
| T008 | 实现 NPC 创建面板（姓名/性别/灵魂） | 已完成 | P1 | 新增 NPC 创建弹窗，支持姓名/性别/灵魂/标签录入并通过 `npc.create` 提交；创建请求会显示 NPC ID 提示，服务端校验通过后实时广播创建结果 |
| T009 | 增加安全与约束（动作校验、频率限制、越权防护） | 已完成 | P0 | 服务端新增 `src/server/security.js`，为 `playerMove` / `npc.*` / `chat.*` 增加参数校验、动作白名单 schema 校验、频率限制、NPC 所有权越权防护与结构化拒绝日志 |
| T010 | 增加观测与日志（决策/动作/错误） | 已完成 | P1 | 服务端新增 NPC 决策/执行结构化日志、执行结果回传链路与周期统计快照，覆盖成功率和平均响应时间 |

## 详细任务与验收标准

### T001 建立 NPC 数据模型（含灵魂、姓名、性别等）
- 状态：已完成
- 目标：
  - 新增 `NPC` 实体（继承 `Entity`）
  - 新增 NPC 核心字段：`id`、`name`、`gender`、`soul`、`personaTags`、`spawn`、`memorySummary`
- 验收标准：
  - 可以在代码中创建 NPC 实例并显示名字
  - 字段可序列化（可通过 socket 传输）
- 完成说明：
  - 已新增 `src/types/Npc.ts`：定义 `NpcSnapshot`（含 `id`、`name`、`gender`、`soul`、`personaTags`、`spawn`、`memorySummary`）和创建辅助方法
  - 已新增 `src/models/Npc.ts`：`Npc` 继承 `Entity`，支持 `applySnapshot` 与 `toSnapshot`，可直接序列化/反序列化核心字段
  - 已在 `src/scenes/WorldScene.ts` 中创建 `Guide` 示例 NPC，并默认显示名字，满足“可创建并显示名字”验收

### T002 服务端维护 NPC 状态并同步给客户端
- 状态：已完成
- 目标：
  - 服务端新增 `state.npcs`
  - 增加同步事件：`npc.created`、`npc.updated`、`npc.removed`、`currentNpcs`
- 验收标准：
  - 新连接玩家能收到全量 NPC 列表
  - NPC 变化可实时广播到其他客户端
- 完成说明：
  - 已在 `src/server/index.js` 新增 `state.npcs`，并预置 `npc-guide-1` 示例 NPC
  - 客户端连接后会收到 `currentNpcs` 全量快照
  - 已新增服务端事件入口：`npc.create`、`npc.update`、`npc.remove`，并分别广播 `npc.created`、`npc.updated`、`npc.removed`
  - 新增 NPC 快照清洗逻辑（ID、名字、性别、出生点、标签等）以避免无效数据进入状态树

### T003 客户端渲染 NPC 并接入现有实体系统
- 状态：已完成
- 目标：
  - `WorldScene` 维护 `npcs` 集合
  - 支持 NPC 的创建、更新、销毁
- 验收标准：
  - 客户端可看到服务端下发的 NPC
  - NPC 可参与现有 `EntityActionManager` 动作流程
- 完成说明：
  - 已在 `src/services/ServerConnectorService.ts` 接入 `currentNpcs`、`npc.created`、`npc.updated`、`npc.removed` 事件，支持全量同步 + 增量同步
  - 已在 `src/scenes/WorldScene.ts` 增加 `syncNpcs` / `upsertNpc` / `removeNpc`，统一管理 NPC 创建、更新、销毁
  - 新建 NPC 时会注册到 `EntityActionManager`，删除 NPC 时会反注册，确保 NPC 可进入现有动作队列流程
  - 移除了本地临时创建 NPC 的逻辑，客户端渲染数据来源统一为服务端下发状态

### T004 定义 AI 可执行动作协议（白名单）
- 状态：已完成
- 目标：
  - 设计统一 JSON 协议：`MOVE_TO`、`SAY`、`LOOK_AT`、`WAIT`、（可选）`COLLECT_RESOURCE`
  - 明确每个动作参数、约束、失败返回
- 验收标准：
  - 协议文档可直接用于 LLM function/tool calling
  - 非白名单动作会被拒绝
- 完成说明：
  - 已新增 `src/npc/NpcActionProtocol.ts`，提供动作类型定义、白名单、参数约束与错误结构
  - 已新增 `docs/npc-action-protocol.md`，可直接作为 LLM 结构化输出协议参考

### T005 实现 NPC 动作执行器（移动/对话/朝向/等待）
- 状态：已完成
- 目标：
  - 新增 `NpcActionExecutor`
  - 把 AI 指令映射到现有事件系统与动作队列
- 验收标准：
  - NPC 能按顺序执行动作（含等待）
  - 动作失败时有明确错误和回退策略
- 完成说明：
  - 已新增 `src/services/NpcActionExecutor.ts`，接入 `validateNpcActionList`，并将 `MOVE_TO` / `SAY` / `LOOK_AT` / `WAIT` 映射为 `EntityActionManager` 可执行动作队列
  - 已新增 NPC 专用动作事件：`action.npc.go-to`、`action.npc.say`、`action.npc.look-at`，避免复用玩家移动事件导致的服务端状态误同步
  - 已在 `src/services/EntityActionProcessor.ts` 增加对应事件处理：NPC 移动、NPC 发言（转发到聊天通道）、NPC 朝向目标/方向
  - 已在 `src/scenes/WorldScene.ts` 增加 `executeNpcActions(npcId, actions)` 统一入口，供后续 LLM 决策服务直接调用
  - 已在 `src/server/index.js` 新增 `npc.executeActions` 事件并广播到客户端，形成“提交动作计划 -> 客户端执行器落地”的基础链路
  - 当目标 NPC 不存在、目标不可达、LOOK_AT 目标不存在或动作参数校验失败时，会返回结构化错误并回退为短时 `WAIT`，防止 NPC 动作队列卡死

### T006 接入 LLM 决策服务（结构化输出）
- 状态：已完成
- 目标：
  - 服务端新增 `NpcBrainService`
  - 输入：灵魂设定、上下文、可用动作
  - 输出：结构化动作列表（JSON）
- 验收标准：
  - 模型输出可被解析并执行
  - 出现无效输出时可降级为 `WAIT`
- 完成说明：
  - 已新增 `src/server/NpcBrainService.js`：支持 `mock` 模式与远端 Chat Completions 调用，统一产出 `{"actions":[...]}` 结构
  - 已在 `src/server/index.js` 接入 `npc.chat.send` 决策流程：输入 NPC 灵魂设定 + 玩家消息上下文 + 动作白名单，生成动作计划后进入 `npc.executeActions` 执行链路（系统 NPC 保持私聊回复兼容）
  - 已新增手动触发事件 `npc.brain.decide`（仅 owner 可用），并在前端增加 `/npc-brain <NPC_ID> [上下文]` 指令，便于验证 NPC 决策能力
  - 已对决策输出增加二次校验与统一回退：解析失败、校验失败或请求失败时自动降级为 `WAIT`
  - 已新增文档 `docs/npc-brain-service.md`，说明环境变量、触发方式与验收映射

### T007 实现 NPC 对话通道（玩家与 NPC）
- 状态：已完成
- 目标：
  - 支持玩家向指定 NPC 发消息
  - NPC 回复进入聊天 UI（区分世界聊天与 NPC 私聊）
- 验收标准：
  - 能看到“玩家 -> NPC -> 玩家”的完整对话链路
  - 消息包含 NPC 身份信息（name/id）
- 完成说明：
  - 已在 `src/scenes/UIScene.tsx` 新增私聊指令解析：输入 `/npc <NPC_ID> <消息内容>` 会走 NPC 私聊通道，否则走世界聊天
  - 已在 `src/services/ServerConnectorService.ts` 增加 `ActionType.CHAT_SEND_NPC_MESSAGE` 到服务端事件 `npc.chat.send` 的转发
  - 已在 `src/server/index.js` 新增 `npc.chat.send` 处理：校验 NPC 与消息后返回两条私聊消息（玩家发给 NPC、NPC 回复玩家），形成“玩家 -> NPC -> 玩家”链路
  - 已在 `src/types/Chat.ts` 扩展聊天结构，增加 `channel`、`npcId`、`npcName`、`targetPlayerId` 字段，保证消息携带 NPC 身份
  - 已在 `src/ui-components/common/ChatPopup.tsx` 增加频道标签渲染，明确区分 `[世界]` 与 `[NPC私聊 ...]`

### T008 实现 NPC 创建面板（姓名/性别/灵魂）
- 状态：已完成
- 目标：
  - 前端增加创建 UI：姓名、性别、灵魂文本、标签
  - 服务端校验入参并创建 NPC
- 验收标准：
  - 玩家可在游戏内创建一个 NPC
  - 创建后可立即出现在地图并可交互
- 完成说明：
  - 已新增 `src/ui-components/NpcCreatePopup.tsx`：提供姓名、性别、灵魂文本、标签（逗号分隔）输入，前端会做长度截断、标签去重与基础校验
  - 已在 `src/scenes/UIScene.tsx` 菜单新增 NPC 创建入口（`BOOK` 按钮），并接入弹窗显示/隐藏与提交逻辑
  - 已在 `src/types/Npc.ts` 增加 `NpcCreateRequest`，并在 `src/types/Actions.ts` 新增 `ActionType.NPC_CREATE`
  - 已在 `src/services/ServerConnectorService.ts` 接入 `ActionType.NPC_CREATE -> socket.emit("npc.create")`，复用服务端既有 `sanitizeNpcSnapshot` 校验与 `npc.created` 广播链路
  - 创建时会生成可读的 `npc-<slug>-<suffix>` ID 并通过通知提示，便于立即使用 `/npc <NPC_ID> <消息>` 发起交互

### T009 增加安全与约束（动作校验、频率限制、越权防护）
- 状态：已完成
- 目标：
  - 校验目标坐标合法性、动作频率、消息长度、权限
  - 对 LLM 指令做 schema 校验与白名单校验
- 验收标准：
  - 恶意参数不会导致崩溃或越权操作
  - 日志中可追踪拒绝原因
- 完成说明：
  - 已新增 `src/server/security.js`：实现统一工具，包括坐标合法性校验、NPC 快照清洗、NPC 动作 schema + 白名单校验（`MOVE_TO`/`SAY`/`LOOK_AT`/`WAIT`）与滑动窗口限流器
  - 已在 `src/server/index.js` 接入事件级限流与校验：`playerMove`、`resource.collect`、`npc.create`、`npc.update`、`npc.remove`、`npc.executeActions`、`npc.chat.send`、`chat.sendNewMessage`
  - 已新增 NPC 所有权模型 `state.npcOwners`（系统 NPC 标记 `__system__`），并在更新/删除/执行动作/以 NPC 身份发言时做 owner 鉴权，阻断越权操作
  - 已增加统一拒绝日志 `logSecurityRejection`，所有被拒绝请求都会记录 `socketId`、`event`、`reason`、`details` 便于排障追踪

### T010 增加观测与日志（决策/动作/错误）
- 状态：已完成
- 目标：
  - 记录每次 NPC 决策、执行耗时、失败原因
  - 增加基础统计：动作成功率、平均响应时间
- 验收标准：
  - 可以快速定位某个 NPC 为什么“卡住不动/不说话”
- 完成说明：
  - 已在 `src/server/index.js` 增加 NPC 观测模块：为每次 `npc.executeActions` 生成执行 ID，并记录结构化决策日志（NPC、动作数、发起者、时间）
  - 已新增 `npc.executionResult` 回传事件，客户端执行完成后回传结果；服务端记录执行日志（耗时、成功/失败、错误码、回退状态）并做权限校验
  - 已新增全局与按 NPC 的聚合统计（动作成功率、平均响应时间、最后错误码、pending 执行数），并按周期输出 `[NpcMetrics]` 快照日志，支持快速定位 NPC 卡住原因
