# NPC 动作协议（白名单）

本协议用于约束 LLM 仅输出可执行、安全的 NPC 动作。  
白名单动作包含：`MOVE_TO`、`SAY`、`LOOK_AT`、`WAIT`、`INTERACT`、`COLLECT`、`TALK_TO_NPC`、`GIFT_TO_NPC`、`ATTACK_NPC`。

## 1. 顶层结构

```json
{
  "actions": [
    {
      "type": "WAIT",
      "durationMs": 1000
    }
  ]
}
```

- `actions` 必须是数组
- 数组中每个元素都必须通过白名单与参数校验

## 2. 动作定义

### 2.1 MOVE_TO

```json
{
  "type": "MOVE_TO",
  "x": 12,
  "y": 18
}
```

- `x`: 整数，范围 `[0, 100000]`
- `y`: 整数，范围 `[0, 100000]`

### 2.2 SAY

```json
{
  "type": "SAY",
  "text": "你好，旅行者。",
  "channel": "npc_private",
  "targetPlayerId": "player-123"
}
```

- `text`: 字符串，去除首尾空白后长度 `[1, 200]`
- `channel`: 可选，`world | npc_private`
- `targetPlayerId`: 可选，字符串长度 `[1, 64]`

### 2.3 LOOK_AT

二选一模式，只能提供一个目标：

```json
{
  "type": "LOOK_AT",
  "targetEntityId": "npc-guard-1"
}
```

```json
{
  "type": "LOOK_AT",
  "direction": "LEFT"
}
```

- `targetEntityId`: 字符串长度 `[1, 64]`
- `direction`: `UP | DOWN | LEFT | RIGHT`
- 约束：`targetEntityId` 与 `direction` 必须且只能出现一个

### 2.4 WAIT

```json
{
  "type": "WAIT",
  "durationMs": 800
}
```

- `durationMs`: 整数，范围 `[100, 30000]`

### 2.5 TALK_TO_NPC

```json
{
  "type": "TALK_TO_NPC",
  "targetNpcId": "npc-guard-1",
  "text": "我们暂时休战。"
}
```

- `targetNpcId`: 字符串长度 `[1, 64]`
- `text`: 非空字符串，长度 `[1, 200]`

### 2.6 GIFT_TO_NPC

```json
{
  "type": "GIFT_TO_NPC",
  "targetNpcId": "npc-merchant-1",
  "itemId": "log_beech",
  "quantity": 2
}
```

- `targetNpcId`: 字符串长度 `[1, 64]`
- `itemId`: 字符串长度 `[1, 64]`
- `quantity`: 整数，范围 `[1, 99]`

### 2.7 ATTACK_NPC

```json
{
  "type": "ATTACK_NPC",
  "targetNpcId": "npc-bandit-1"
}
```

- `targetNpcId`: 字符串长度 `[1, 64]`

## 3. 拒绝策略（非白名单）

- 如果 `type` 不在白名单，返回错误码 `ACTION_NOT_ALLOWED`
- 如果参数不合法，返回错误码 `INVALID_ARG`
- 如果 `actions` 不是数组，返回错误码 `INVALID_ACTION_LIST`

## 4. 参考实现

- 校验器实现：`src/npc/NpcActionProtocol.ts`
- 入口函数：
  - `validateNpcAction(action)`
  - `validateNpcActionList(actions)`
