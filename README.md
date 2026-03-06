# AI World

一个基于 `Phaser + React + Socket.IO + TypeScript` 的 2D Web MMORPG 原型项目，支持多人同图、资源采集、聊天系统，以及可由 LLM 驱动的 AI NPC（含动作白名单与安全校验）。

## 功能概览

- 实时多人同步（玩家加入、移动、离线）
- 世界聊天与 NPC 私聊通道
- 资源成长与采集（如木材/作物）
- 背包、技能、面板等基础 UI 系统
- NPC 创建、更新、移除与全量/增量同步
- NPC Brain 决策链路（远端模型）
- 动作协议白名单与服务端限流、越权防护、执行观测日志

## 技术栈

- 前端：`Phaser 3`、`React 16`、`TypeScript`、`Vite`
- 后端：`Node.js`、`Express`、`Socket.IO`
- 样式：`TailwindCSS`、`Semantic UI`

## 环境要求

- `Node.js 16.x`（与 `package.json` 中 `engines` 保持一致）
- `npm`（推荐随 Node 16 安装）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动后端（端口 3000）

```bash
npm run server
```

### 3. 启动前端开发服务（端口 8080）

```bash
npm run dev
```

### 4. 访问项目

打开：`http://localhost:8080`

## 常用脚本

- `npm run dev`：启动前端开发服务器（Vite）
- `npm run server`：启动后端服务（nodemon）
- `npm run build`：TypeScript 编译 + Vite 构建
- `npm run serve`：预览前端构建产物

## AI NPC 配置

默认情况下，`NpcBrainService` 已预设为 Ollama 本地接口。  
如需显式配置，可在启动后端前设置环境变量：

```bash
export NPC_BRAIN_PROVIDER=ollama
export NPC_BRAIN_API_KEY=
export NPC_BRAIN_MODEL=qwen3-coder:latest
export NPC_BRAIN_ENDPOINT=http://localhost:11434/v1/chat/completions
export NPC_BRAIN_TEMPERATURE=0.7
export NPC_BRAIN_TIMEOUT_MS=12000
export NPC_BRAIN_MAX_OUTPUT_TOKENS=280
export NPC_BRAIN_MAX_ACTIONS=4
export NPC_BRAIN_AUTONOMOUS_INTERVAL_MS=6000
export NPC_BRAIN_AUTONOMOUS_TICK_MS=1000
```

可选参数（按需）：

- `NPC_BRAIN_TEMPERATURE`
- `NPC_BRAIN_DEFAULT_WAIT_MS`
- `NPC_BRAIN_MAX_CONTEXT_LENGTH`
- `NPC_BRAIN_AUTONOMOUS_INTERVAL_MS`（NPC 自动思考间隔，毫秒）
- `NPC_BRAIN_AUTONOMOUS_TICK_MS`（自动思考调度 tick，毫秒）

## 游戏内交互

- 世界聊天：直接输入消息
- NPC 私聊：`/npc <NPC_ID> <消息内容>`
- 手动触发 NPC 决策：`/npc-brain <NPC_ID> [上下文]`
- 上帝注入世界事件：`/world-event <事件描述>`
- 创建 NPC：UI 菜单中的 `BOOK` 按钮进入创建弹窗
- 自主行为：玩家创建的 NPC 会在创建后自动触发一次决策，并按间隔持续自动决策

## 目录结构

```text
.
├── src/
│   ├── scenes/                # 游戏场景（World/UI/React）
│   ├── services/              # 状态、事件、服务端连接、NPC 执行器
│   ├── server/                # 后端服务与 NPC Brain、安全模块
│   ├── models/                # 玩家、NPC、资源、技能等实体
│   ├── npc/                   # NPC 动作协议校验
│   └── ui-components/         # React UI 组件
├── public/assets/             # 地图、角色、UI 等资源
├── docs/                      # 项目补充文档
└── TODO.md                    # AI NPC 改造任务记录
```

## 文档索引

- [NPC 动作协议](./docs/npc-action-protocol.md)
- [NPC Brain Service](./docs/npc-brain-service.md)
- [AI NPC 改造 TODO](./TODO.md)

## 常见问题

- 前端能打开但玩家不出现：确认 `npm run server` 已启动且监听 `3000`。
- NPC 指令无响应：先确认 NPC ID 是否存在，再检查命令格式是否正确。
- 远端模型未生效：检查 `NPC_BRAIN_PROVIDER` 与 `NPC_BRAIN_API_KEY` 是否已在当前终端导出。
- NPC 仍不动：检查后端日志是否出现 `BRAIN_REQUEST_FAILED`，并查看 `[NpcBrain][LLMRequestRaw]` / `[NpcBrain][LLMResponseRaw]` 原始日志排查模型返回。

## License

ISC
