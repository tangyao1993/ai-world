const path = require("path");
const express = require("express");
const app = express();
const server = require("http").Server(app);
const io = require("socket.io")(server);
const CONFIG = require("../gameConfig.json");
const worldData = require("../../public/assets/map/world.json");
const resourcesData = require("../data/resources.json");
const itemsData = require("../data/items.json");
const NpcBrainService = require("./NpcBrainService");
const {
  SYSTEM_NPC_OWNER,
  createRateLimiter,
  isValidTileCoordinate,
  logSecurityRejection,
  sanitizeNpcSnapshot,
  validateNpcActionList,
} = require("./security");
const PORT = process.env.PORT || 3000;
const MAX_CHAT_HISTORY = 100;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const RESOURCE_MAX_LEVEL = 4;
const NPC_EXECUTION_RETENTION_MS = 5 * 60 * 1000;
const NPC_METRICS_LOG_INTERVAL_MS = 60 * 1000;
const NPC_BRAIN_FALLBACK_WAIT_MS = 1500;
const DEFAULT_NPC_AUTONOMOUS_INTERVAL_MS = 6000;
const DEFAULT_NPC_AUTONOMOUS_TICK_MS = 1000;
const NPC_AUTONOMOUS_INTERVAL_MS = (() => {
  const configured = Number(process.env.NPC_BRAIN_AUTONOMOUS_INTERVAL_MS);
  if (!Number.isInteger(configured)) return DEFAULT_NPC_AUTONOMOUS_INTERVAL_MS;
  return Math.max(1500, Math.min(60000, configured));
})();
const NPC_AUTONOMOUS_TICK_MS = (() => {
  const configured = Number(process.env.NPC_BRAIN_AUTONOMOUS_TICK_MS);
  if (!Number.isInteger(configured)) return DEFAULT_NPC_AUTONOMOUS_TICK_MS;
  return Math.max(500, Math.min(5000, configured));
})();
const NPC_AUTONOMOUS_INITIAL_DELAY_MS = 800;
const MAP_WIDTH = Number.isInteger(worldData.width) ? worldData.width : 0;
const MAP_HEIGHT = Number.isInteger(worldData.height) ? worldData.height : 0;
const NPC_PERCEPTION_WINDOW_WIDTH_TILES = 24;
const NPC_PERCEPTION_WINDOW_HEIGHT_TILES = 14;
const OBSERVER_MODE_ENABLED =
  String(process.env.WORLD_GOD_VIEW_MODE || "true").toLowerCase() !== "false";
const NPC_MAX_HP = 3;
const NPC_ATTACK_DAMAGE = 1;
const NPC_MAX_INVENTORY_ITEM_QUANTITY = 999;
const NPC_AFFINITY_MAX = 100;
const MAX_WORLD_EVENT_LENGTH = 240;
const MAX_WORLD_EVENTS = 20;
const MAX_COMBAT_HISTORY = 120;
const MAX_BRAIN_WORLD_CHAT_CONTEXT = 15;
const MAX_BRAIN_COMBAT_CONTEXT = 15;
const MAX_BRAIN_CHAT_MESSAGE_LENGTH = 120;

const rateLimiter = createRateLimiter();
const npcBrainService = new NpcBrainService();

const avatars = [
  "https://react.semantic-ui.com/images/avatar/small/tom.jpg",
  "https://react.semantic-ui.com/images/avatar/small/matt.jpg",
  "https://react.semantic-ui.com/images/avatar/small/matthew.png",
  "https://react.semantic-ui.com/images/avatar/small/rachel.png",
  "https://react.semantic-ui.com/images/avatar/small/lindsay.png",
  "https://react.semantic-ui.com/images/avatar/small/jenny.jpg",
  "https://react.semantic-ui.com/images/avatar/small/veronika.jpg",
];

function normalizeChatMessage(value) {
  if (typeof value !== "string") return "";

  const normalized = value.trim();
  if (!normalized) return "";

  return normalized.slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

function sanitizeChatMessage(payload, fallbackAuthor) {
  if (!payload || typeof payload !== "object") return null;

  const message = normalizeChatMessage(payload.message);
  if (!message) return null;

  const author =
    typeof payload.author === "string" && payload.author.trim()
      ? payload.author.trim().slice(0, 64)
      : fallbackAuthor;
  const channel = payload.channel === "npc_private" ? "npc_private" : "world";
  const creationDate =
    typeof payload.creationDate === "number" ? payload.creationDate : Date.now();
  const image =
    typeof payload.image === "string" && payload.image.trim()
      ? payload.image.trim()
      : undefined;

  const sanitized = {
    author,
    message,
    creationDate,
    channel,
  };

  if (image) sanitized.image = image;

  if (typeof payload.npcId === "string" && payload.npcId.trim()) {
    sanitized.npcId = payload.npcId.trim();
  }
  if (typeof payload.npcName === "string" && payload.npcName.trim()) {
    sanitized.npcName = payload.npcName.trim();
  }

  if (channel === "npc_private") {
    const targetPlayerId =
      typeof payload.targetPlayerId === "string" && payload.targetPlayerId.trim()
        ? payload.targetPlayerId.trim()
        : "";
    if (!targetPlayerId) return null;

    sanitized.targetPlayerId = targetPlayerId;

    if (!sanitized.npcId) return null;
  }

  return sanitized;
}

function buildNpcReplyMessage(npc, playerName, playerMessage) {
  const soulHint =
    typeof npc.soul === "string" && npc.soul.trim()
      ? `我会按“${npc.soul.trim().slice(0, 36)}”来回应你。`
      : "我已收到你的消息。";
  return `${playerName}，你说“${playerMessage}”，${soulHint}`;
}

function buildNpcActionValidationContext(stateRef, actorNpcId = "") {
  return {
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    players: stateRef.players,
    npcs: stateRef.npcs,
    resources: stateRef.resources,
    items: itemsData,
    actorNpcId,
    resourceMaxLevel: RESOURCE_MAX_LEVEL,
    maxSayLength: MAX_CHAT_MESSAGE_LENGTH,
  };
}

function buildBrainWorldChatContext(chatMessages) {
  if (!Array.isArray(chatMessages)) return [];

  return chatMessages
    .slice(-MAX_BRAIN_WORLD_CHAT_CONTEXT)
    .map((message) => {
      if (!isRecord(message)) return null;

      const text = normalizeChatMessage(message.message).slice(
        0,
        MAX_BRAIN_CHAT_MESSAGE_LENGTH
      );
      if (!text) return null;

      const author =
        typeof message.author === "string" && message.author.trim()
          ? message.author.trim().slice(0, 64)
          : "Unknown";
      const entry = {
        author,
        message: text,
        channel: "world",
      };

      if (typeof message.npcId === "string" && message.npcId.trim()) {
        entry.npcId = message.npcId.trim().slice(0, 64);
      }
      if (typeof message.npcName === "string" && message.npcName.trim()) {
        entry.npcName = message.npcName.trim().slice(0, 64);
      }
      if (Number.isInteger(message.creationDate)) {
        entry.creationDate = message.creationDate;
      }

      return entry;
    })
    .filter(Boolean);
}

function buildBrainCombatContext(combatEvents) {
  if (!Array.isArray(combatEvents)) return [];

  return combatEvents
    .slice(-MAX_BRAIN_COMBAT_CONTEXT)
    .map((event) => {
      if (!isRecord(event)) return null;

      const type =
        typeof event.type === "string" && event.type.trim()
          ? event.type.trim().slice(0, 32)
          : "";
      if (!type) return null;

      const entry = { type };
      if (Number.isInteger(event.createdAt)) {
        entry.createdAt = event.createdAt;
      }
      if (typeof event.attackerNpcId === "string" && event.attackerNpcId.trim()) {
        entry.attackerNpcId = event.attackerNpcId.trim().slice(0, 64);
      }
      if (typeof event.attackerNpcName === "string" && event.attackerNpcName.trim()) {
        entry.attackerNpcName = event.attackerNpcName.trim().slice(0, 64);
      }
      if (typeof event.targetNpcId === "string" && event.targetNpcId.trim()) {
        entry.targetNpcId = event.targetNpcId.trim().slice(0, 64);
      }
      if (typeof event.targetNpcName === "string" && event.targetNpcName.trim()) {
        entry.targetNpcName = event.targetNpcName.trim().slice(0, 64);
      }
      if (Number.isInteger(event.damage)) {
        entry.damage = event.damage;
      }
      if (Number.isInteger(event.targetHp)) {
        entry.targetHp = event.targetHp;
      }
      if (Number.isInteger(event.targetMaxHp)) {
        entry.targetMaxHp = event.targetMaxHp;
      }
      if (typeof event.targetAlive === "boolean") {
        entry.targetAlive = event.targetAlive;
      }
      if (typeof event.npcId === "string" && event.npcId.trim()) {
        entry.npcId = event.npcId.trim().slice(0, 64);
      }
      if (typeof event.npcName === "string" && event.npcName.trim()) {
        entry.npcName = event.npcName.trim().slice(0, 64);
      }
      if (Number.isInteger(event.hp)) {
        entry.hp = event.hp;
      }

      return entry;
    })
    .filter(Boolean);
}

function buildNpcWorldContext(stateRef, npc) {
  const runtimeNpc = ensureNpcRuntimeState(npc) || {
    hp: NPC_MAX_HP,
    alive: true,
    affinityByNpcId: {},
    inventory: {},
  };

  return {
    onlinePlayerCount: Object.keys(stateRef.players || {}).length,
    npcCount: Object.keys(stateRef.npcs || {}).length,
    observerModeEnabled: OBSERVER_MODE_ENABLED,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    recentWorldEvents: Array.isArray(stateRef.worldEvents)
      ? stateRef.worldEvents.slice(-5)
      : [],
    recentWorldChatMessages: buildBrainWorldChatContext(stateRef.chatMessages),
    recentCombatEvents: buildBrainCombatContext(stateRef.combatEvents),
    selfStatus: {
      hp: runtimeNpc.hp,
      alive: runtimeNpc.alive,
      inventory: getNpcInventorySummary(runtimeNpc),
      affinityByNpcId: { ...runtimeNpc.affinityByNpcId },
    },
    perception: buildNpcPerceptionContext(stateRef, npc),
  };
}

function buildNpcFallbackWaitActions() {
  return [
    {
      type: "WAIT",
      durationMs: NPC_BRAIN_FALLBACK_WAIT_MS,
    },
  ];
}

function normalizeBrainContext(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 240);
}

function normalizeWorldEventDescription(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_WORLD_EVENT_LENGTH);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  if (typeof value !== "string") return "";
  return value.trim().slice(0, 64);
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampQuantity(value, max = NPC_MAX_INVENTORY_ITEM_QUANTITY) {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

function ensureNpcRuntimeState(npc) {
  if (!isRecord(npc)) return null;

  npc.hp = clampInteger(npc.hp, 0, NPC_MAX_HP, NPC_MAX_HP);
  npc.alive = npc.alive !== false;
  if (!npc.alive && npc.hp > 0) npc.hp = 0;
  if (!isRecord(npc.inventory)) npc.inventory = {};
  if (!isRecord(npc.affinityByNpcId)) npc.affinityByNpcId = {};
  npc.combatCooldownUntil = Number.isInteger(npc.combatCooldownUntil)
    ? npc.combatCooldownUntil
    : 0;

  return npc;
}

function getNpcInventorySummary(npc) {
  if (!isRecord(npc?.inventory)) return {};

  const summary = {};
  Object.entries(npc.inventory).forEach(([itemId, quantity]) => {
    const normalizedItemId = normalizeRuntimeId(itemId);
    if (!normalizedItemId) return;

    const normalizedQuantity = clampQuantity(quantity);
    if (normalizedQuantity <= 0) return;
    summary[normalizedItemId] = normalizedQuantity;
  });
  return summary;
}

function addNpcInventoryItem(npc, itemId, quantity) {
  const npcRef = ensureNpcRuntimeState(npc);
  const normalizedItemId = normalizeRuntimeId(itemId);
  const delta = clampQuantity(quantity);
  if (!npcRef || !normalizedItemId || delta <= 0) return 0;

  const current = clampQuantity(npcRef.inventory[normalizedItemId]);
  const next = clampQuantity(current + delta);
  npcRef.inventory[normalizedItemId] = next;
  return next - current;
}

function removeNpcInventoryItem(npc, itemId, quantity) {
  const npcRef = ensureNpcRuntimeState(npc);
  const normalizedItemId = normalizeRuntimeId(itemId);
  const delta = clampQuantity(quantity);
  if (!npcRef || !normalizedItemId || delta <= 0) return 0;

  const current = clampQuantity(npcRef.inventory[normalizedItemId]);
  if (current < delta) return 0;

  const next = clampQuantity(current - delta);
  if (next <= 0) delete npcRef.inventory[normalizedItemId];
  else npcRef.inventory[normalizedItemId] = next;

  return delta;
}

function increaseNpcAffinity(targetNpc, fromNpcId, delta) {
  const targetRef = ensureNpcRuntimeState(targetNpc);
  const normalizedFromNpcId = normalizeRuntimeId(fromNpcId);
  const normalizedDelta = clampQuantity(delta, NPC_AFFINITY_MAX);
  if (!targetRef || !normalizedFromNpcId || normalizedDelta <= 0) return 0;

  const current = clampInteger(
    targetRef.affinityByNpcId[normalizedFromNpcId],
    0,
    NPC_AFFINITY_MAX,
    0
  );
  const next = clampInteger(
    current + normalizedDelta,
    0,
    NPC_AFFINITY_MAX,
    NPC_AFFINITY_MAX
  );
  targetRef.affinityByNpcId[normalizedFromNpcId] = next;
  return next - current;
}

function getResourceDrop(resource) {
  if (!isRecord(resource)) return null;
  const resourceType =
    typeof resource.type === "string" ? resource.type.trim() : "";
  if (!resourceType || !isRecord(resourcesData[resourceType])) return null;

  const definition = resourcesData[resourceType];
  const itemId = normalizeRuntimeId(definition.item);
  const quantity = clampQuantity(definition.itemQuantity || 1, 99);
  if (!itemId || quantity <= 0) return null;

  return {
    itemId,
    quantity,
  };
}

function appendWorldChatMessage(message) {
  if (!isRecord(message)) return;
  if (message.channel !== "world") return;

  state.chatMessages.push(message);
  if (state.chatMessages.length > MAX_CHAT_HISTORY) {
    state.chatMessages = state.chatMessages.slice(
      state.chatMessages.length - MAX_CHAT_HISTORY
    );
  }
}

function appendCombatEvent(event) {
  if (!isRecord(event)) return;

  state.combatEvents.push(event);
  if (state.combatEvents.length > MAX_COMBAT_HISTORY) {
    state.combatEvents = state.combatEvents.slice(
      state.combatEvents.length - MAX_COMBAT_HISTORY
    );
  }
}

function hasValidTile(tile) {
  if (!isRecord(tile)) return false;

  return isValidTileCoordinate(tile.x, tile.y, MAP_WIDTH, MAP_HEIGHT);
}

function resolveNpcRuntimeTile(npc) {
  if (isRecord(npc?.runtimeTile) && hasValidTile(npc.runtimeTile)) {
    return {
      x: npc.runtimeTile.x,
      y: npc.runtimeTile.y,
    };
  }

  if (isRecord(npc?.spawn) && hasValidTile(npc.spawn)) {
    return {
      x: npc.spawn.x,
      y: npc.spawn.y,
    };
  }

  return { x: 0, y: 0 };
}

function toTileCoordinate(worldCoordinate) {
  if (typeof worldCoordinate !== "number" || !Number.isFinite(worldCoordinate)) {
    return null;
  }

  return Math.floor(worldCoordinate / CONFIG.TILE_SIZE);
}

function resolveResourceTile(resource) {
  if (!isRecord(resource)) return null;

  const x = toTileCoordinate(resource.x);
  const y = toTileCoordinate(resource.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (!isValidTileCoordinate(x, y, MAP_WIDTH, MAP_HEIGHT)) return null;

  return { x, y };
}

function createPerceptionWindowBounds(centerTile) {
  const width = Math.max(1, NPC_PERCEPTION_WINDOW_WIDTH_TILES);
  const height = Math.max(1, NPC_PERCEPTION_WINDOW_HEIGHT_TILES);
  const leftSpan = Math.floor((width - 1) / 2);
  const rightSpan = width - 1 - leftSpan;
  const topSpan = Math.floor((height - 1) / 2);
  const bottomSpan = height - 1 - topSpan;

  return {
    minX: Math.max(0, centerTile.x - leftSpan),
    maxX: Math.min(MAP_WIDTH - 1, centerTile.x + rightSpan),
    minY: Math.max(0, centerTile.y - topSpan),
    maxY: Math.min(MAP_HEIGHT - 1, centerTile.y + bottomSpan),
    widthTiles: width,
    heightTiles: height,
    center: {
      x: centerTile.x,
      y: centerTile.y,
    },
  };
}

function isTileInsideWindow(tile, bounds) {
  return (
    tile.x >= bounds.minX &&
    tile.x <= bounds.maxX &&
    tile.y >= bounds.minY &&
    tile.y <= bounds.maxY
  );
}

function getTileDistance(fromTile, toTile) {
  return Number(
    Math.hypot(fromTile.x - toTile.x, fromTile.y - toTile.y).toFixed(2)
  );
}

function sortPerceptionEntries(entries) {
  return entries.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const aId = typeof a.id === "string" ? a.id : "";
    const bId = typeof b.id === "string" ? b.id : "";
    return aId.localeCompare(bId);
  });
}

function buildNpcPerceptionContext(stateRef, npc) {
  const selfNpc = ensureNpcRuntimeState(npc) || {};
  const selfTile = resolveNpcRuntimeTile(selfNpc);
  const window = createPerceptionWindowBounds(selfTile);
  const players = [];
  const npcs = [];
  const resources = [];

  if (!OBSERVER_MODE_ENABLED) {
    Object.values(stateRef.players || {}).forEach((player) => {
      if (!isRecord(player)) return;
      if (!isValidTileCoordinate(player.x, player.y, MAP_WIDTH, MAP_HEIGHT)) return;
      const playerId = normalizeRuntimeId(player.id);
      if (!playerId) return;

      const tile = { x: player.x, y: player.y };
      if (!isTileInsideWindow(tile, window)) return;

      players.push({
        id: playerId,
        name: typeof player.name === "string" ? player.name : "",
        x: tile.x,
        y: tile.y,
        distance: getTileDistance(selfTile, tile),
      });
    });
  }

  Object.values(stateRef.npcs || {}).forEach((otherNpc) => {
    const otherNpcRef = ensureNpcRuntimeState(otherNpc);
    if (!isRecord(otherNpcRef)) return;

    const npcId = normalizeRuntimeId(otherNpcRef.id);
    const selfId = normalizeRuntimeId(selfNpc.id);
    if (!npcId || npcId === selfId) return;

    const tile = resolveNpcRuntimeTile(otherNpcRef);
    if (!isTileInsideWindow(tile, window)) return;

    npcs.push({
      id: npcId,
      name: typeof otherNpcRef.name === "string" ? otherNpcRef.name : "",
      hp: otherNpcRef.hp,
      alive: otherNpcRef.alive,
      affinityFromSelf: clampInteger(
        selfNpc?.affinityByNpcId?.[npcId],
        0,
        NPC_AFFINITY_MAX,
        0
      ),
      x: tile.x,
      y: tile.y,
      distance: getTileDistance(selfTile, tile),
    });
  });

  Object.entries(stateRef.resources || {}).forEach(([resourceKey, resource]) => {
    const resourceTile = resolveResourceTile(resource);
    if (!resourceTile || !isTileInsideWindow(resourceTile, window)) return;
    const isCollectable =
      Number.isInteger(resource?.level) && resource.level >= RESOURCE_MAX_LEVEL;
    if (!isCollectable) return;

    const resourceId = normalizeRuntimeId(
      isRecord(resource) && resource.id !== undefined ? resource.id : resourceKey
    );
    if (!resourceId) return;

    resources.push({
      id: resourceId,
      resourceId,
      type: typeof resource?.type === "string" ? resource.type : "",
      level: Number.isInteger(resource?.level) ? resource.level : 0,
      isCollectable: true,
      x: resourceTile.x,
      y: resourceTile.y,
      distance: getTileDistance(selfTile, resourceTile),
    });
  });

  return {
    self: {
      id: normalizeRuntimeId(selfNpc.id),
      name: typeof selfNpc.name === "string" ? selfNpc.name : "",
      hp: selfNpc.hp,
      alive: selfNpc.alive,
      inventory: getNpcInventorySummary(selfNpc),
      x: selfTile.x,
      y: selfTile.y,
    },
    window,
    players: sortPerceptionEntries(players),
    npcs: sortPerceptionEntries(npcs),
    resources: sortPerceptionEntries(resources),
  };
}

function resolveNpcPrivateReplyText(actions, targetPlayerId) {
  if (!Array.isArray(actions)) return "";

  const matchedAction = actions.find((action) => {
    if (!action || typeof action !== "object") return false;
    if (action.type !== "SAY") return false;
    if (action.channel !== "npc_private") return false;
    return action.targetPlayerId === targetPlayerId;
  });

  if (!matchedAction || typeof matchedAction.text !== "string") return "";
  return matchedAction.text.trim();
}

function rejectEvent(socket, event, reason, details = {}) {
  logSecurityRejection({
    event,
    socketId: socket.id,
    reason,
    details,
  });
}

function consumeRateLimit(socket, event, limit, windowMs) {
  const result = rateLimiter.consume(`${socket.id}:${event}`, limit, windowMs);
  if (result.ok) return true;

  rejectEvent(socket, event, "RATE_LIMITED", {
    limit,
    windowMs,
    retryAfterMs: result.retryAfterMs,
  });
  return false;
}

function canManageNpc(socketId, npcId, npcOwners) {
  return npcOwners[npcId] === socketId;
}

function createNpcMetricsBucket() {
  return {
    decisions: 0,
    plannedActions: 0,
    executionReports: 0,
    succeededExecutions: 0,
    failedExecutions: 0,
    totalResponseMs: 0,
    lastDecisionAt: null,
    lastExecutionAt: null,
    lastErrorCode: null,
  };
}

const npcObservability = {
  nextExecutionSeq: 1,
  pendingExecutions: {},
  totals: createNpcMetricsBucket(),
  byNpc: {},
};

function ensureNpcMetricsBucket(npcId) {
  if (!npcObservability.byNpc[npcId]) {
    npcObservability.byNpc[npcId] = createNpcMetricsBucket();
  }

  return npcObservability.byNpc[npcId];
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function average(total, count) {
  if (!count) return 0;
  return Number((total / count).toFixed(2));
}

function buildNpcMetricsFromBucket(bucket) {
  return {
    decisions: bucket.decisions,
    plannedActions: bucket.plannedActions,
    executionReports: bucket.executionReports,
    succeededExecutions: bucket.succeededExecutions,
    failedExecutions: bucket.failedExecutions,
    actionSuccessRate: ratio(bucket.succeededExecutions, bucket.executionReports),
    averageResponseMs: average(bucket.totalResponseMs, bucket.executionReports),
    lastDecisionAt: bucket.lastDecisionAt,
    lastExecutionAt: bucket.lastExecutionAt,
    lastErrorCode: bucket.lastErrorCode,
  };
}

function buildNpcMetricsSnapshot() {
  const byNpc = Object.fromEntries(
    Object.entries(npcObservability.byNpc).map(([npcId, bucket]) => [
      npcId,
      buildNpcMetricsFromBucket(bucket),
    ])
  );

  return {
    generatedAt: Date.now(),
    pendingExecutions: Object.keys(npcObservability.pendingExecutions).length,
    totals: buildNpcMetricsFromBucket(npcObservability.totals),
    byNpc,
  };
}

function reserveNpcExecutionId() {
  const seq = npcObservability.nextExecutionSeq;
  npcObservability.nextExecutionSeq += 1;
  return `npc-exec-${Date.now()}-${seq}`;
}

function trackNpcDecision({ executionId, npcId, ownerSocketId, actionCount, decisionAt }) {
  npcObservability.pendingExecutions[executionId] = {
    executionId,
    npcId,
    ownerSocketId,
    actionCount,
    decisionAt,
  };

  const totalMetrics = npcObservability.totals;
  const npcMetrics = ensureNpcMetricsBucket(npcId);

  totalMetrics.decisions += 1;
  totalMetrics.plannedActions += actionCount;
  totalMetrics.lastDecisionAt = decisionAt;

  npcMetrics.decisions += 1;
  npcMetrics.plannedActions += actionCount;
  npcMetrics.lastDecisionAt = decisionAt;

  console.log(
    "[NpcDecision]",
    JSON.stringify({
      executionId,
      npcId,
      ownerSocketId,
      actionCount,
      decisionAt,
    })
  );
}

function getNpcExecutionReport(payload) {
  if (!payload || typeof payload !== "object") return null;

  const executionId =
    typeof payload.executionId === "string" ? payload.executionId.trim() : "";
  if (!executionId) return null;

  const result =
    payload.result && typeof payload.result === "object" ? payload.result : null;
  if (!result || typeof result.ok !== "boolean") return null;

  const npcId = typeof payload.npcId === "string" ? payload.npcId.trim() : "";
  const acceptedActions = Number.isInteger(result.acceptedActions)
    ? result.acceptedActions
    : 0;
  const queuedActions = Number.isInteger(result.queuedActions)
    ? result.queuedActions
    : 0;
  const fallbackApplied = !!result.fallbackApplied;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const hasTilePayload = isRecord(payload.npcState) && isRecord(payload.npcState.tile);
  const tile = hasTilePayload
    ? {
        x: payload.npcState.tile.x,
        y: payload.npcState.tile.y,
      }
    : null;
  const npcState =
    tile && isValidTileCoordinate(tile.x, tile.y, MAP_WIDTH, MAP_HEIGHT)
      ? { tile }
      : undefined;

  return {
    executionId,
    npcId,
    npcState,
    result: {
      ok: result.ok,
      acceptedActions,
      queuedActions,
      fallbackApplied,
      errors,
    },
  };
}

function trackNpcExecutionResult(execution, report, reporterSocketId) {
  const completedAt = Date.now();
  const responseMs = Math.max(0, completedAt - execution.decisionAt);
  const firstError = report.result.errors[0];
  const firstErrorCode =
    firstError && typeof firstError.code === "string"
      ? firstError.code
      : report.result.ok
        ? null
        : "UNKNOWN";

  const totalMetrics = npcObservability.totals;
  const npcMetrics = ensureNpcMetricsBucket(execution.npcId);
  const isSuccess = report.result.ok;

  totalMetrics.executionReports += 1;
  totalMetrics.totalResponseMs += responseMs;
  totalMetrics.lastExecutionAt = completedAt;
  totalMetrics.lastErrorCode = isSuccess ? null : firstErrorCode;
  if (isSuccess) totalMetrics.succeededExecutions += 1;
  else totalMetrics.failedExecutions += 1;

  npcMetrics.executionReports += 1;
  npcMetrics.totalResponseMs += responseMs;
  npcMetrics.lastExecutionAt = completedAt;
  npcMetrics.lastErrorCode = isSuccess ? null : firstErrorCode;
  if (isSuccess) npcMetrics.succeededExecutions += 1;
  else npcMetrics.failedExecutions += 1;

  console.log(
    "[NpcExecution]",
    JSON.stringify({
      executionId: execution.executionId,
      npcId: execution.npcId,
      ownerSocketId: execution.ownerSocketId,
      reporterSocketId,
      actionCount: execution.actionCount,
      acceptedActions: report.result.acceptedActions,
      queuedActions: report.result.queuedActions,
      ok: report.result.ok,
      fallbackApplied: report.result.fallbackApplied,
      errorCount: report.result.errors.length,
      firstErrorCode,
      responseMs,
      completedAt,
    })
  );
}

function clearPendingExecutionsByOwner(socketId) {
  Object.entries(npcObservability.pendingExecutions).forEach(
    ([executionId, execution]) => {
      if (execution.ownerSocketId !== socketId) return;

      delete npcObservability.pendingExecutions[executionId];
      console.warn(
        "[NpcExecution] pending execution dropped because owner disconnected",
        JSON.stringify({
          executionId,
          npcId: execution.npcId,
          ownerSocketId: socketId,
          droppedAt: Date.now(),
        })
      );
    }
  );
}

function cleanupExpiredNpcExecutions() {
  const now = Date.now();

  Object.entries(npcObservability.pendingExecutions).forEach(
    ([executionId, execution]) => {
      if (now - execution.decisionAt <= NPC_EXECUTION_RETENTION_MS) return;

      delete npcObservability.pendingExecutions[executionId];
      console.warn(
        "[NpcExecution] pending execution expired",
        JSON.stringify({
          executionId,
          npcId: execution.npcId,
          ownerSocketId: execution.ownerSocketId,
          decisionAt: execution.decisionAt,
          expiredAt: now,
        })
      );
    }
  );
}

function finalizeNpcActionPlan(rawActions, stateRef, actorNpcId = "") {
  const validation = validateNpcActionList(
    Array.isArray(rawActions) ? rawActions : [],
    buildNpcActionValidationContext(stateRef, actorNpcId)
  );

  if (validation.ok) {
    return {
      actions: validation.value,
      usedFallback: false,
      fallbackReason: null,
      fallbackDetails: {},
    };
  }

  return {
    actions: buildNpcFallbackWaitActions(),
    usedFallback: true,
    fallbackReason: validation.reason || "INVALID_ACTIONS",
    fallbackDetails: validation.details || {},
  };
}

function dispatchNpcActionPlan(npcId, ownerSocketId, actions) {
  const executionId = reserveNpcExecutionId();
  const decisionAt = Date.now();

  trackNpcDecision({
    executionId,
    npcId,
    ownerSocketId,
    actionCount: actions.length,
    decisionAt,
  });

  io.emit("npc.executeActions", npcId, actions, {
    executionId,
    ownerSocketId,
    decisionAt,
  });

  return { executionId, decisionAt };
}

// Game state
const state = {
  players: {},
  npcs: {},
  npcOwners: {},
  chatMessages: [],
  combatEvents: [],
  worldEvents: [],
  resources: worldData.layers[4].objects.reduce(
    (resources, resourceData) => ({
      ...resources,
      [resourceData.id]: {
        ...resourceData,
        level: 1,
        lastTimeGrown: Date.now(),
        x: resourceData.x + (resourceData.width || CONFIG.TILE_SIZE) / 2,
        y: resourceData.y - CONFIG.TILE_SIZE,
      },
    }),
    {}
  ),
};

Object.values(state.npcs).forEach((npc) => {
  ensureNpcRuntimeState(npc);
});

const npcAutonomousRuntime = {
  isRunning: false,
  inFlightByNpc: {},
  lastDecisionAtByNpc: {},
};

function removeNpcFromState(npcId, options = {}) {
  const normalizedNpcId = normalizeRuntimeId(npcId);
  if (!normalizedNpcId || !state.npcs[normalizedNpcId]) return null;

  const npc = state.npcs[normalizedNpcId];
  delete state.npcs[normalizedNpcId];
  delete state.npcOwners[normalizedNpcId];
  delete npcAutonomousRuntime.inFlightByNpc[normalizedNpcId];
  delete npcAutonomousRuntime.lastDecisionAtByNpc[normalizedNpcId];

  if (options.emitRemoved !== false) {
    io.emit("npc.removed", normalizedNpcId);
  }

  return npc;
}

function hasPendingExecutionForNpc(npcId) {
  return Object.values(npcObservability.pendingExecutions).some(
    (execution) => execution.npcId === npcId
  );
}

async function decideNpcActions({
  npc,
  triggerType,
  playerId,
  playerName,
  message,
  context,
}) {
  const decision = await npcBrainService.decidePlan({
    npc,
    trigger: {
      type: triggerType,
      playerId: playerId || "",
      playerName: playerName || "",
      message,
      context,
    },
    worldContext: buildNpcWorldContext(state, npc),
    availableActions: [
      "MOVE_TO",
      "SAY",
      "LOOK_AT",
      "WAIT",
      "INTERACT",
      "COLLECT",
      "TALK_TO_NPC",
      "GIFT_TO_NPC",
      "ATTACK_NPC",
    ],
    validationContext: buildNpcActionValidationContext(state, npc.id),
  });

  const normalizedPlan = finalizeNpcActionPlan(decision.actions, state, npc.id);

  return {
    actions: normalizedPlan.actions,
    usedFallback: !!decision.usedFallback || normalizedPlan.usedFallback,
    reason: decision.reason || normalizedPlan.fallbackReason,
    details: decision.details || normalizedPlan.fallbackDetails,
    source: decision.source || "unknown",
  };
}

async function runNpcAutonomousLoop() {
  if (npcAutonomousRuntime.isRunning) return;

  npcAutonomousRuntime.isRunning = true;

  try {
    const now = Date.now();
    const npcEntries = Object.values(state.npcs);

    for (const npc of npcEntries) {
      if (!npc || typeof npc.id !== "string") continue;

      const npcId = npc.id.trim();
      if (!npcId) continue;
      const runtimeNpc = ensureNpcRuntimeState(npc);
      if (!runtimeNpc || runtimeNpc.alive === false) continue;

      const ownerSocketId = state.npcOwners[npcId];
      if (
        typeof ownerSocketId !== "string" ||
        !ownerSocketId ||
        ownerSocketId === SYSTEM_NPC_OWNER
      ) {
        continue;
      }

      if (!io.sockets.sockets.get(ownerSocketId)) continue;
      if (npcAutonomousRuntime.inFlightByNpc[npcId]) continue;
      if (hasPendingExecutionForNpc(npcId)) continue;

      const lastDecisionAt = npcAutonomousRuntime.lastDecisionAtByNpc[npcId] || 0;
      if (now - lastDecisionAt < NPC_AUTONOMOUS_INTERVAL_MS) continue;

      npcAutonomousRuntime.inFlightByNpc[npcId] = true;
      npcAutonomousRuntime.lastDecisionAtByNpc[npcId] = now;

      const ownerPlayer = state.players[ownerSocketId];

      try {
        const plan = await decideNpcActions({
          npc,
          triggerType: "autonomous",
          playerId: ownerPlayer?.id || ownerSocketId,
          playerName: ownerPlayer?.name || "",
          context: "autonomous_tick",
        });

        dispatchNpcActionPlan(npcId, ownerSocketId, plan.actions);

        const ownerSocket = io.sockets.sockets.get(ownerSocketId);
        if (ownerSocket) {
          ownerSocket.emit("npc.brain.decision", {
            npcId,
            triggerType: "autonomous",
            source: plan.source,
            usedFallback: plan.usedFallback,
            reason: plan.reason || null,
            actions: plan.actions,
          });
        }
      } catch (error) {
        console.warn(
          "[NpcAutonomous] decision failed",
          JSON.stringify({
            npcId,
            ownerSocketId,
            message: String(error && error.message ? error.message : error),
          })
        );
      } finally {
        delete npcAutonomousRuntime.inFlightByNpc[npcId];
      }
    }
  } finally {
    npcAutonomousRuntime.isRunning = false;
  }
}

function emitWorldNpcMessage({ author, message, npcId, npcName }) {
  const normalizedMessage = normalizeChatMessage(message);
  if (!normalizedMessage) return;

  const payload = {
    author: normalizeRuntimeId(author) || String(author || "System"),
    message: normalizedMessage,
    creationDate: Date.now(),
    channel: "world",
    npcId: npcId || undefined,
    npcName: npcName || undefined,
  };

  io.emit("chat.newMessage", [payload]);
  appendWorldChatMessage(payload);
}

console.log("Alkito Server - Starting...");
console.log("Resources populated: ", Object.keys(state.resources).length);

server.listen(PORT, () => {
  console.log(`Alkito Server - Ready (port ${PORT})`);
});

const distPath = path.join(__dirname, "../../dist");

app.use(express.static(distPath));

io.on("connect_error", (err) => {
  console.log(`connect_error due to ${err.message}`);
});

io.on("connection", function (socket) {
  const newPlayer = {
    id: socket.id,
    name: "Player #" + Math.floor(Math.random() * 1000),
    avatar: avatars[Math.floor(Math.random() * 7)],
    x: CONFIG.PLAYER_SPAWN_POINT.x,
    y: CONFIG.PLAYER_SPAWN_POINT.y,
  };

  state.players[socket.id] = newPlayer;

  console.log("User connected: ", newPlayer.name, newPlayer.id);

  // Emit player newly created and current game state
  socket.emit("playerCreated", state.players[socket.id]);
  socket.emit("currentPlayers", state.players);
  socket.emit("currentNpcs", state.npcs);
  socket.emit("currentResources", state.resources);

  // Send chat history after 1 second
  setTimeout(() => {
    const welcomeMessage = {
      author: "Alkito",
      message:
        "Welcome to Alkito ! A web based MMORPG in Javascript and Node.js",
      creationDate: Date.now(),
      channel: "world",
    };

    socket.emit("chat.newMessage", [...state.chatMessages, welcomeMessage]);
  }, 1000);
  // Broadcast the new player to other players
  socket.broadcast.emit("newPlayer", state.players[socket.id]);

  socket.on("playerMove", (x, y) => {
    if (!consumeRateLimit(socket, "playerMove", 25, 1000)) return;
    if (OBSERVER_MODE_ENABLED) return;

    const player = state.players[socket.id];
    if (!player) {
      rejectEvent(socket, "playerMove", "PLAYER_NOT_FOUND");
      return;
    }

    if (!isValidTileCoordinate(x, y, MAP_WIDTH, MAP_HEIGHT)) {
      rejectEvent(socket, "playerMove", "INVALID_COORDINATE", {
        x,
        y,
        mapWidth: MAP_WIDTH,
        mapHeight: MAP_HEIGHT,
      });
      return;
    }

    player.x = x;
    player.y = y;

    socket.broadcast.emit("playerMoved", player);
  });

  socket.on("resource.collect", (payload) => {
    if (!consumeRateLimit(socket, "resource.collect", 20, 10000)) return;
    const resourceId = normalizeRuntimeId(
      typeof payload === "string" || typeof payload === "number"
        ? payload
        : payload?.resourceId
    );
    const collectorEntityId =
      normalizeRuntimeId(payload?.collectorEntityId) || socket.id;

    if (!resourceId || !state.resources[resourceId]) {
      rejectEvent(socket, "resource.collect", "RESOURCE_NOT_FOUND", { resourceId });
      return;
    }

    const isCollectorPlayer = collectorEntityId === socket.id;
    const isCollectorNpc =
      !!collectorEntityId && state.npcOwners[collectorEntityId] === socket.id;
    if (OBSERVER_MODE_ENABLED && isCollectorPlayer) {
      rejectEvent(socket, "resource.collect", "PLAYER_COLLECT_DISABLED_IN_OBSERVER_MODE", {
        collectorEntityId,
      });
      return;
    }
    if (!isCollectorPlayer && !isCollectorNpc) {
      rejectEvent(socket, "resource.collect", "COLLECTOR_PERMISSION_DENIED", {
        collectorEntityId,
        resourceId,
      });
      return;
    }

    if (
      !Number.isInteger(state.resources[resourceId].level) ||
      state.resources[resourceId].level < RESOURCE_MAX_LEVEL
    ) {
      rejectEvent(socket, "resource.collect", "RESOURCE_NOT_READY", {
        resourceId,
        level: state.resources[resourceId].level,
        requiredLevel: RESOURCE_MAX_LEVEL,
      });
      return;
    }

    console.log("Resource", resourceId, "collected");
    const newResource = {
      ...state.resources[resourceId],
      level: 1,
      lastTimeGrown: Date.now(),
    };

    state.resources[resourceId] = newResource;

    if (isCollectorNpc && state.npcs[collectorEntityId]) {
      const drop = getResourceDrop(newResource);
      if (drop) {
        addNpcInventoryItem(state.npcs[collectorEntityId], drop.itemId, drop.quantity);
        io.emit("npc.updated", state.npcs[collectorEntityId]);
      }
    }

    io.emit("resource.grown", newResource.id, newResource.level);
  });

  socket.on("npc.create", (npcSnapshot) => {
    if (!consumeRateLimit(socket, "npc.create", 3, 60000)) return;

    const player = state.players[socket.id];
    const defaultSpawn = player
      ? { x: player.x, y: player.y }
      : CONFIG.PLAYER_SPAWN_POINT;
    const sanitizeResult = sanitizeNpcSnapshot(npcSnapshot, {
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      defaultSpawn,
    });
    if (!sanitizeResult.ok) {
      rejectEvent(socket, "npc.create", sanitizeResult.reason, sanitizeResult.details);
      return;
    }

    const sanitizedNpc = sanitizeResult.value;
    if (state.npcs[sanitizedNpc.id]) {
      rejectEvent(socket, "npc.create", "NPC_ALREADY_EXISTS", {
        npcId: sanitizedNpc.id,
      });
      return;
    }

    state.npcs[sanitizedNpc.id] = ensureNpcRuntimeState({
      ...sanitizedNpc,
      runtimeTile: {
        x: sanitizedNpc.spawn.x,
        y: sanitizedNpc.spawn.y,
      },
      hp: NPC_MAX_HP,
      alive: true,
      inventory: {},
      affinityByNpcId: {},
      combatCooldownUntil: 0,
    });
    state.npcOwners[sanitizedNpc.id] = socket.id;
    npcAutonomousRuntime.lastDecisionAtByNpc[sanitizedNpc.id] = 0;
    io.emit("npc.created", state.npcs[sanitizedNpc.id]);

    const ownerPlayer = state.players[socket.id];
    setTimeout(async () => {
      if (!state.npcs[sanitizedNpc.id]) return;
      if (state.npcOwners[sanitizedNpc.id] !== socket.id) return;

      try {
        const plan = await decideNpcActions({
          npc: state.npcs[sanitizedNpc.id],
          triggerType: "spawn",
          playerId: ownerPlayer?.id || socket.id,
          playerName: ownerPlayer?.name || "",
          context: "after_create",
        });

        dispatchNpcActionPlan(sanitizedNpc.id, socket.id, plan.actions);
        npcAutonomousRuntime.lastDecisionAtByNpc[sanitizedNpc.id] = Date.now();

        socket.emit("npc.brain.decision", {
          npcId: sanitizedNpc.id,
          triggerType: "spawn",
          source: plan.source,
          usedFallback: plan.usedFallback,
          reason: plan.reason || null,
          actions: plan.actions,
        });
      } catch (error) {
        console.warn(
          "[NpcCreate] initial decision failed",
          JSON.stringify({
            npcId: sanitizedNpc.id,
            ownerSocketId: socket.id,
            message: String(error && error.message ? error.message : error),
          })
        );
      }
    }, NPC_AUTONOMOUS_INITIAL_DELAY_MS);
  });

  socket.on("npc.update", (npcSnapshot) => {
    if (!consumeRateLimit(socket, "npc.update", 12, 60000)) return;
    if (!npcSnapshot || typeof npcSnapshot !== "object") {
      rejectEvent(socket, "npc.update", "INVALID_PAYLOAD");
      return;
    }

    const npcId =
      typeof npcSnapshot.id === "string" ? npcSnapshot.id.trim() : "";
    if (!npcId || !state.npcs[npcId]) {
      rejectEvent(socket, "npc.update", "NPC_NOT_FOUND", { npcId });
      return;
    }

    if (!canManageNpc(socket.id, npcId, state.npcOwners)) {
      rejectEvent(socket, "npc.update", "NPC_PERMISSION_DENIED", { npcId });
      return;
    }

    const sanitizeResult = sanitizeNpcSnapshot({
      ...state.npcs[npcId],
      ...npcSnapshot,
      spawn: {
        ...state.npcs[npcId].spawn,
        ...(npcSnapshot.spawn || {}),
      },
    }, {
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      defaultSpawn: state.npcs[npcId].spawn,
    });
    if (!sanitizeResult.ok) {
      rejectEvent(socket, "npc.update", sanitizeResult.reason, sanitizeResult.details);
      return;
    }

    const mergedNpc = sanitizeResult.value;
    const runtimeTile = resolveNpcRuntimeTile(state.npcs[npcId]);
    state.npcs[npcId] = ensureNpcRuntimeState({
      ...state.npcs[npcId],
      ...mergedNpc,
      runtimeTile,
    });
    io.emit("npc.updated", state.npcs[npcId]);
  });

  socket.on("npc.remove", (npcId) => {
    if (!consumeRateLimit(socket, "npc.remove", 6, 60000)) return;
    if (typeof npcId !== "string" || !npcId.trim()) {
      rejectEvent(socket, "npc.remove", "INVALID_NPC_ID");
      return;
    }

    const targetNpcId = npcId.trim();
    if (!state.npcs[targetNpcId]) {
      rejectEvent(socket, "npc.remove", "NPC_NOT_FOUND", { npcId: targetNpcId });
      return;
    }
    if (!canManageNpc(socket.id, targetNpcId, state.npcOwners)) {
      rejectEvent(socket, "npc.remove", "NPC_PERMISSION_DENIED", {
        npcId: targetNpcId,
      });
      return;
    }

    removeNpcFromState(targetNpcId);
  });

  socket.on("npc.executeActions", (npcId, actions) => {
    if (!consumeRateLimit(socket, "npc.executeActions", 10, 10000)) return;
    if (typeof npcId !== "string" || !npcId.trim()) {
      rejectEvent(socket, "npc.executeActions", "INVALID_NPC_ID");
      return;
    }

    const targetNpcId = npcId.trim();
    if (!state.npcs[targetNpcId]) {
      rejectEvent(socket, "npc.executeActions", "NPC_NOT_FOUND", {
        npcId: targetNpcId,
      });
      return;
    }
    if (!canManageNpc(socket.id, targetNpcId, state.npcOwners)) {
      rejectEvent(socket, "npc.executeActions", "NPC_PERMISSION_DENIED", {
        npcId: targetNpcId,
      });
      return;
    }

    const validation = validateNpcActionList(
      actions,
      buildNpcActionValidationContext(state, targetNpcId)
    );
    if (!validation.ok) {
      rejectEvent(socket, "npc.executeActions", validation.reason, validation.details);
      return;
    }

    dispatchNpcActionPlan(targetNpcId, socket.id, validation.value);
  });

  socket.on("npc.brain.decide", async (payload) => {
    if (!consumeRateLimit(socket, "npc.brain.decide", 8, 10000)) return;
    if (!payload || typeof payload !== "object") {
      rejectEvent(socket, "npc.brain.decide", "INVALID_PAYLOAD");
      return;
    }

    const npcId = typeof payload.npcId === "string" ? payload.npcId.trim() : "";
    if (!npcId) {
      rejectEvent(socket, "npc.brain.decide", "INVALID_NPC_ID");
      return;
    }

    const npc = state.npcs[npcId];
    if (!npc) {
      rejectEvent(socket, "npc.brain.decide", "NPC_NOT_FOUND", { npcId });
      return;
    }
    const runtimeNpc = ensureNpcRuntimeState(npc);
    if (!runtimeNpc.alive) {
      rejectEvent(socket, "npc.brain.decide", "NPC_IS_DEAD", { npcId });
      return;
    }

    if (!canManageNpc(socket.id, npcId, state.npcOwners)) {
      rejectEvent(socket, "npc.brain.decide", "NPC_PERMISSION_DENIED", { npcId });
      return;
    }

    const player = state.players[socket.id];
    const context = normalizeBrainContext(payload.context);

    try {
      const plan = await decideNpcActions({
        npc,
        triggerType: "manual",
        playerId: player?.id || socket.id,
        playerName: player?.name || "",
        context,
      });

      dispatchNpcActionPlan(npcId, socket.id, plan.actions);

      socket.emit("npc.brain.decision", {
        npcId,
        source: plan.source,
        usedFallback: plan.usedFallback,
        reason: plan.reason || null,
        actions: plan.actions,
      });
    } catch (error) {
      rejectEvent(socket, "npc.brain.decide", "BRAIN_DECISION_FAILED", {
        npcId,
        message: String(error && error.message ? error.message : error),
      });
    }
  });

  socket.on("npc.executionResult", (payload) => {
    if (!consumeRateLimit(socket, "npc.executionResult", 20, 10000)) return;

    const report = getNpcExecutionReport(payload);
    if (!report) {
      rejectEvent(socket, "npc.executionResult", "INVALID_EXECUTION_RESULT_PAYLOAD");
      return;
    }

    const execution = npcObservability.pendingExecutions[report.executionId];
    if (!execution) {
      rejectEvent(socket, "npc.executionResult", "EXECUTION_NOT_FOUND", {
        executionId: report.executionId,
      });
      return;
    }

    if (execution.ownerSocketId !== socket.id) {
      rejectEvent(socket, "npc.executionResult", "NPC_PERMISSION_DENIED", {
        executionId: report.executionId,
        expectedOwnerSocketId: execution.ownerSocketId,
      });
      return;
    }

    if (report.npcId && report.npcId !== execution.npcId) {
      rejectEvent(socket, "npc.executionResult", "EXECUTION_NPC_MISMATCH", {
        executionId: report.executionId,
        npcId: report.npcId,
        expectedNpcId: execution.npcId,
      });
      return;
    }

    if (report.npcState?.tile && state.npcs[execution.npcId]) {
      state.npcs[execution.npcId].runtimeTile = {
        x: report.npcState.tile.x,
        y: report.npcState.tile.y,
      };
    }

    delete npcObservability.pendingExecutions[report.executionId];
    trackNpcExecutionResult(execution, report, socket.id);
  });

  socket.on("world.event.inject", (payload) => {
    if (!consumeRateLimit(socket, "world.event.inject", 6, 10000)) return;
    const description = normalizeWorldEventDescription(payload?.description);
    if (!description) {
      rejectEvent(socket, "world.event.inject", "INVALID_WORLD_EVENT_DESCRIPTION");
      return;
    }

    const worldEvent = {
      id: `world-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description,
      createdAt: Date.now(),
      creatorSocketId: socket.id,
      creatorName: state.players[socket.id]?.name || "Observer",
    };
    state.worldEvents.push(worldEvent);
    if (state.worldEvents.length > MAX_WORLD_EVENTS) {
      state.worldEvents = state.worldEvents.slice(
        state.worldEvents.length - MAX_WORLD_EVENTS
      );
    }

    Object.keys(npcAutonomousRuntime.lastDecisionAtByNpc).forEach((npcId) => {
      npcAutonomousRuntime.lastDecisionAtByNpc[npcId] = 0;
    });

    emitWorldNpcMessage({
      author: "WorldEvent",
      message: `世界事件：${description}`,
    });
  });

  socket.on("npc.social.talk", (payload) => {
    if (!consumeRateLimit(socket, "npc.social.talk", 20, 10000)) return;
    const fromNpcId =
      typeof payload?.fromNpcId === "string" ? payload.fromNpcId.trim() : "";
    const targetNpcId =
      typeof payload?.targetNpcId === "string" ? payload.targetNpcId.trim() : "";
    const text = normalizeChatMessage(payload?.text);
    if (!fromNpcId || !targetNpcId || !text) {
      rejectEvent(socket, "npc.social.talk", "INVALID_PAYLOAD");
      return;
    }
    if (!canManageNpc(socket.id, fromNpcId, state.npcOwners)) {
      rejectEvent(socket, "npc.social.talk", "NPC_PERMISSION_DENIED", { fromNpcId });
      return;
    }

    const fromNpc = ensureNpcRuntimeState(state.npcs[fromNpcId]);
    const targetNpc = ensureNpcRuntimeState(state.npcs[targetNpcId]);
    if (!fromNpc || !targetNpc) {
      rejectEvent(socket, "npc.social.talk", "NPC_NOT_FOUND", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }
    if (!fromNpc.alive || !targetNpc.alive) {
      rejectEvent(socket, "npc.social.talk", "NPC_IS_DEAD", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }

    fromNpc.lastInteractionAt = Date.now();
    targetNpc.lastInteractionAt = Date.now();
    emitWorldNpcMessage({
      author: fromNpc.name,
      message: `对 ${targetNpc.name} 说：${text}`,
      npcId: fromNpc.id,
      npcName: fromNpc.name,
    });
  });

  socket.on("npc.social.gift", (payload) => {
    if (!consumeRateLimit(socket, "npc.social.gift", 20, 10000)) return;
    const fromNpcId =
      typeof payload?.fromNpcId === "string" ? payload.fromNpcId.trim() : "";
    const targetNpcId =
      typeof payload?.targetNpcId === "string" ? payload.targetNpcId.trim() : "";
    const itemId =
      typeof payload?.itemId === "string" ? payload.itemId.trim() : "";
    const quantity = Number.isInteger(payload?.quantity) ? payload.quantity : 0;
    if (!fromNpcId || !targetNpcId || !itemId || quantity <= 0 || quantity > 99) {
      rejectEvent(socket, "npc.social.gift", "INVALID_PAYLOAD");
      return;
    }
    if (!canManageNpc(socket.id, fromNpcId, state.npcOwners)) {
      rejectEvent(socket, "npc.social.gift", "NPC_PERMISSION_DENIED", { fromNpcId });
      return;
    }
    if (!itemsData[itemId]) {
      rejectEvent(socket, "npc.social.gift", "INVALID_ITEM_ID", { itemId });
      return;
    }

    const fromNpc = ensureNpcRuntimeState(state.npcs[fromNpcId]);
    const targetNpc = ensureNpcRuntimeState(state.npcs[targetNpcId]);
    if (!fromNpc || !targetNpc) {
      rejectEvent(socket, "npc.social.gift", "NPC_NOT_FOUND", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }
    if (!fromNpc.alive || !targetNpc.alive) {
      rejectEvent(socket, "npc.social.gift", "NPC_IS_DEAD", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }

    const removed = removeNpcInventoryItem(fromNpc, itemId, quantity);
    if (removed < quantity) {
      rejectEvent(socket, "npc.social.gift", "NPC_ITEM_NOT_ENOUGH", {
        fromNpcId,
        targetNpcId,
        itemId,
        required: quantity,
      });
      return;
    }

    addNpcInventoryItem(targetNpc, itemId, quantity);
    const itemPrice = Number.isFinite(itemsData[itemId]?.price)
      ? Math.max(1, Math.floor(itemsData[itemId].price))
      : 1;
    const affinityDelta = increaseNpcAffinity(
      targetNpc,
      fromNpc.id,
      Math.min(30, itemPrice * quantity)
    );

    io.emit("npc.updated", fromNpc);
    io.emit("npc.updated", targetNpc);

    emitWorldNpcMessage({
      author: fromNpc.name,
      message: `向 ${targetNpc.name} 赠送了 ${itemId} x${quantity}，好感 +${affinityDelta}。`,
      npcId: fromNpc.id,
      npcName: fromNpc.name,
    });
  });

  socket.on("npc.combat.attack", (payload) => {
    if (!consumeRateLimit(socket, "npc.combat.attack", 25, 10000)) return;
    const fromNpcId =
      typeof payload?.fromNpcId === "string" ? payload.fromNpcId.trim() : "";
    const targetNpcId =
      typeof payload?.targetNpcId === "string" ? payload.targetNpcId.trim() : "";
    if (!fromNpcId || !targetNpcId) {
      rejectEvent(socket, "npc.combat.attack", "INVALID_PAYLOAD");
      return;
    }
    if (!canManageNpc(socket.id, fromNpcId, state.npcOwners)) {
      rejectEvent(socket, "npc.combat.attack", "NPC_PERMISSION_DENIED", {
        fromNpcId,
      });
      return;
    }
    if (fromNpcId === targetNpcId) {
      rejectEvent(socket, "npc.combat.attack", "ATTACK_SELF_FORBIDDEN", {
        fromNpcId,
      });
      return;
    }

    const fromNpc = ensureNpcRuntimeState(state.npcs[fromNpcId]);
    const targetNpc = ensureNpcRuntimeState(state.npcs[targetNpcId]);
    if (!fromNpc || !targetNpc) {
      rejectEvent(socket, "npc.combat.attack", "NPC_NOT_FOUND", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }
    if (!fromNpc.alive || !targetNpc.alive) {
      rejectEvent(socket, "npc.combat.attack", "NPC_IS_DEAD", {
        fromNpcId,
        targetNpcId,
      });
      return;
    }

    const now = Date.now();
    const fromTile = resolveNpcRuntimeTile(fromNpc);
    const targetTile = resolveNpcRuntimeTile(targetNpc);
    const distance = getTileDistance(fromTile, targetTile);
    if (distance > 3) {
      rejectEvent(socket, "npc.combat.attack", "ATTACK_TARGET_TOO_FAR", {
        fromNpcId,
        targetNpcId,
        distance,
      });
      return;
    }

    targetNpc.hp = clampInteger(
      targetNpc.hp - NPC_ATTACK_DAMAGE,
      0,
      NPC_MAX_HP,
      0
    );
    targetNpc.lastInteractionAt = now;

    if (targetNpc.hp <= 0) {
      targetNpc.alive = false;
    }

    appendCombatEvent({
      id: `combat-${now}-${Math.random().toString(36).slice(2, 8)}`,
      type: "npc_attack",
      createdAt: now,
      attackerNpcId: fromNpc.id,
      attackerNpcName: fromNpc.name,
      targetNpcId: targetNpc.id,
      targetNpcName: targetNpc.name,
      damage: NPC_ATTACK_DAMAGE,
      targetHp: targetNpc.hp,
      targetMaxHp: NPC_MAX_HP,
      targetAlive: targetNpc.alive,
    });

    emitWorldNpcMessage({
      author: fromNpc.name,
      message: `攻击了 ${targetNpc.name}，造成 ${NPC_ATTACK_DAMAGE} 点伤害（${targetNpc.hp}/${NPC_MAX_HP}）。`,
      npcId: fromNpc.id,
      npcName: fromNpc.name,
    });

    if (targetNpc.alive) {
      io.emit("npc.updated", targetNpc);
    } else {
      removeNpcFromState(targetNpc.id);

      appendCombatEvent({
        id: `combat-${now}-${Math.random().toString(36).slice(2, 8)}`,
        type: "npc_killed",
        createdAt: now,
        attackerNpcId: fromNpc.id,
        attackerNpcName: fromNpc.name,
        targetNpcId: targetNpc.id,
        targetNpcName: targetNpc.name,
      });

      emitWorldNpcMessage({
        author: "System",
        message: `${targetNpc.name} 已被 ${fromNpc.name} 击杀并永久消失。`,
        npcId: targetNpc.id,
        npcName: targetNpc.name,
      });
    }
  });

  socket.on("npc.chat.send", async (payload) => {
    if (!consumeRateLimit(socket, "npc.chat.send", 8, 10000)) return;
    const npcId =
      typeof payload?.npcId === "string" ? payload.npcId.trim() : "";
    const message = normalizeChatMessage(payload?.message);
    if (!npcId || !message) {
      rejectEvent(socket, "npc.chat.send", "INVALID_CHAT_PAYLOAD");
      return;
    }

    const npc = state.npcs[npcId];
    const player = state.players[socket.id];
    if (!npc || !player) {
      rejectEvent(socket, "npc.chat.send", "NPC_OR_PLAYER_NOT_FOUND", { npcId });
      return;
    }
    const runtimeNpc = ensureNpcRuntimeState(npc);
    if (!runtimeNpc.alive) {
      rejectEvent(socket, "npc.chat.send", "NPC_IS_DEAD", { npcId });
      return;
    }

    const creationDate = Date.now();
    const playerToNpc = {
      author: player.name,
      image: player.avatar,
      message,
      creationDate,
      channel: "npc_private",
      targetPlayerId: socket.id,
      npcId: npc.id,
      npcName: npc.name,
    };

    socket.emit("chat.newMessage", [playerToNpc]);

    try {
      const plan = await decideNpcActions({
        npc,
        triggerType: "chat",
        playerId: player.id,
        playerName: player.name,
        message,
        context: normalizeBrainContext(payload?.context),
      });
      const npcOwnerSocketId = state.npcOwners[npc.id];
      const shouldDispatchActionPlan =
        typeof npcOwnerSocketId === "string" &&
        npcOwnerSocketId &&
        npcOwnerSocketId !== SYSTEM_NPC_OWNER;

      if (shouldDispatchActionPlan) {
        dispatchNpcActionPlan(npc.id, npcOwnerSocketId, plan.actions);
      }

      const privateReplyText = resolveNpcPrivateReplyText(plan.actions, socket.id);
      if (!shouldDispatchActionPlan || !privateReplyText) {
        const npcReply = {
          author: npc.name,
          message: privateReplyText || buildNpcReplyMessage(npc, player.name, message),
          creationDate: creationDate + 1,
          channel: "npc_private",
          targetPlayerId: socket.id,
          npcId: npc.id,
          npcName: npc.name,
        };

        socket.emit("chat.newMessage", [npcReply]);
      }
    } catch (error) {
      rejectEvent(socket, "npc.chat.send", "BRAIN_DECISION_FAILED", {
        npcId,
        message: String(error && error.message ? error.message : error),
      });

      const fallbackReply = {
        author: npc.name,
        message: buildNpcReplyMessage(npc, player.name, message),
        creationDate: creationDate + 1,
        channel: "npc_private",
        targetPlayerId: socket.id,
        npcId: npc.id,
        npcName: npc.name,
      };
      socket.emit("chat.newMessage", [fallbackReply]);
    }
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("playerDisconnected", state.players[socket.id]);

    Object.entries(state.npcOwners).forEach(([npcId, ownerSocketId]) => {
      if (ownerSocketId !== socket.id) return;
      removeNpcFromState(npcId);
    });

    clearPendingExecutionsByOwner(socket.id);
    delete state.players[socket.id];
  });

  socket.on("chat.sendNewMessage", (newMessage) => {
    if (!consumeRateLimit(socket, "chat.sendNewMessage", 15, 10000)) return;

    const currentPlayer = state.players[socket.id];
    if (!currentPlayer) {
      rejectEvent(socket, "chat.sendNewMessage", "PLAYER_NOT_FOUND");
      return;
    }

    const sanitizedMessage = sanitizeChatMessage(newMessage, currentPlayer.name);
    if (!sanitizedMessage) {
      rejectEvent(socket, "chat.sendNewMessage", "INVALID_CHAT_MESSAGE");
      return;
    }

    const npcId =
      typeof sanitizedMessage.npcId === "string"
        ? sanitizedMessage.npcId.trim()
        : "";
    const npc = npcId ? state.npcs[npcId] : null;
    const isNpcMessage = !!npc;

    if (isNpcMessage) {
      if (!canManageNpc(socket.id, npcId, state.npcOwners)) {
        rejectEvent(socket, "chat.sendNewMessage", "NPC_PERMISSION_DENIED", { npcId });
        return;
      }
      const runtimeNpc = ensureNpcRuntimeState(npc);
      if (!runtimeNpc.alive) {
        rejectEvent(socket, "chat.sendNewMessage", "NPC_IS_DEAD", { npcId });
        return;
      }

      sanitizedMessage.author = npc.name;
      sanitizedMessage.npcId = npc.id;
      sanitizedMessage.npcName = npc.name;
      delete sanitizedMessage.image;
    } else {
      if (sanitizedMessage.channel === "npc_private") {
        rejectEvent(socket, "chat.sendNewMessage", "PRIVATE_CHANNEL_FORBIDDEN");
        return;
      }

      sanitizedMessage.author = currentPlayer.name;
      sanitizedMessage.image = currentPlayer.avatar;
      delete sanitizedMessage.npcId;
      delete sanitizedMessage.npcName;
      delete sanitizedMessage.targetPlayerId;
    }

    console.log(`> [${sanitizedMessage.author}] ${sanitizedMessage.message}`);

    if (sanitizedMessage.channel === "npc_private") {
      const targetSocketId = sanitizedMessage.targetPlayerId;
      if (!targetSocketId || !state.players[targetSocketId]) {
        rejectEvent(socket, "chat.sendNewMessage", "INVALID_PRIVATE_TARGET", {
          targetPlayerId: targetSocketId,
        });
        return;
      }

      const targetSocket = io.sockets.sockets.get(
        targetSocketId
      );
      if (targetSocket) {
        targetSocket.emit("chat.newMessage", [sanitizedMessage]);
      }
      return;
    }

    io.emit("chat.newMessage", [sanitizedMessage]);
    appendWorldChatMessage(sanitizedMessage);
  });
});

// Resources lifecycle
setInterval(() => {
  const now = Date.now();

  Object.values(state.resources).forEach((resource) => {
    const resourceRef = resourcesData[resource.type];

    if (!resourceRef || resource.level >= RESOURCE_MAX_LEVEL) return;

    if (
      now - resource.lastTimeGrown >=
      resourcesData[resource.type].timeToGrowLevel
    ) {
      const newResource = {
        ...resource,
        level: resource.level + 1,
        lastTimeGrown: now,
      };

      state.resources[resource.id] = newResource;

      io.emit("resource.grown", newResource.id, newResource.level);
    }
  });
}, 1000);

setInterval(() => {
  void runNpcAutonomousLoop();
}, NPC_AUTONOMOUS_TICK_MS);

setInterval(() => {
  cleanupExpiredNpcExecutions();
  console.log("[NpcMetrics]", JSON.stringify(buildNpcMetricsSnapshot()));
}, NPC_METRICS_LOG_INTERVAL_MS);
