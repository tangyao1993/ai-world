const path = require("path");
const express = require("express");
const app = express();
const server = require("http").Server(app);
const io = require("socket.io")(server);
const CONFIG = require("../gameConfig.json");
const worldData = require("../../public/assets/map/world.json");
const resourcesData = require("../data/resources.json");
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
const MAP_WIDTH = Number.isInteger(worldData.width) ? worldData.width : 0;
const MAP_HEIGHT = Number.isInteger(worldData.height) ? worldData.height : 0;

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

function buildNpcActionValidationContext(stateRef) {
  return {
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    players: stateRef.players,
    npcs: stateRef.npcs,
    maxSayLength: MAX_CHAT_MESSAGE_LENGTH,
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

  return {
    executionId,
    npcId,
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

function finalizeNpcActionPlan(rawActions, stateRef) {
  const validation = validateNpcActionList(
    Array.isArray(rawActions) ? rawActions : [],
    buildNpcActionValidationContext(stateRef)
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
  npcs: {
    "npc-guide-1": {
      id: "npc-guide-1",
      name: "Guide",
      gender: "unknown",
      soul: "A calm guide that helps players understand the world.",
      personaTags: ["guide", "friendly"],
      spawn: {
        x: CONFIG.PLAYER_SPAWN_POINT.x + 1,
        y: CONFIG.PLAYER_SPAWN_POINT.y,
      },
      memorySummary: "Met recently spawned players near the starting area.",
    },
  },
  npcOwners: {
    "npc-guide-1": SYSTEM_NPC_OWNER,
  },
  chatMessages: [],
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

  const decideNpcActions = async ({
    npc,
    triggerType,
    player,
    message,
    context,
  }) => {
    const decision = await npcBrainService.decidePlan({
      npc,
      trigger: {
        type: triggerType,
        playerId: player?.id || socket.id,
        playerName: player?.name || "",
        message,
        context,
      },
      worldContext: {
        onlinePlayerCount: Object.keys(state.players).length,
        npcCount: Object.keys(state.npcs).length,
      },
      availableActions: ["MOVE_TO", "SAY", "LOOK_AT", "WAIT"],
      validationContext: buildNpcActionValidationContext(state),
    });

    const normalizedPlan = finalizeNpcActionPlan(decision.actions, state);

    return {
      actions: normalizedPlan.actions,
      usedFallback: !!decision.usedFallback || normalizedPlan.usedFallback,
      reason: decision.reason || normalizedPlan.fallbackReason,
      details: decision.details || normalizedPlan.fallbackDetails,
      source: decision.source || "unknown",
    };
  };

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

  socket.on("resource.collect", (id) => {
    if (!consumeRateLimit(socket, "resource.collect", 20, 10000)) return;
    if (!state.resources[id]) {
      rejectEvent(socket, "resource.collect", "RESOURCE_NOT_FOUND", { id });
      return;
    }

    console.log("Resource", id, "collected");
    const newResource = {
      ...state.resources[id],
      level: 1,
      lastTimeGrown: Date.now(),
    };

    state.resources[id] = newResource;

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

    state.npcs[sanitizedNpc.id] = sanitizedNpc;
    state.npcOwners[sanitizedNpc.id] = socket.id;
    io.emit("npc.created", sanitizedNpc);
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
    state.npcs[npcId] = mergedNpc;
    io.emit("npc.updated", mergedNpc);
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

    delete state.npcs[targetNpcId];
    delete state.npcOwners[targetNpcId];
    io.emit("npc.removed", targetNpcId);
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
      buildNpcActionValidationContext(state)
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
        player,
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

    delete npcObservability.pendingExecutions[report.executionId];
    trackNpcExecutionResult(execution, report, socket.id);
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
        player,
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
      delete state.npcOwners[npcId];

      if (state.npcs[npcId]) {
        delete state.npcs[npcId];
        io.emit("npc.removed", npcId);
      }
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

    state.chatMessages.push(sanitizedMessage);

    // Keep only MAX_CHAT_HISTORY messages
    if (state.chatMessages.length > MAX_CHAT_HISTORY) {
      const indexToCut = state.chatMessages.length - MAX_CHAT_HISTORY;
      state.chatMessages = state.chatMessages.slice(indexToCut);
    }
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
  cleanupExpiredNpcExecutions();
  console.log("[NpcMetrics]", JSON.stringify(buildNpcMetricsSnapshot()));
}, NPC_METRICS_LOG_INTERVAL_MS);
