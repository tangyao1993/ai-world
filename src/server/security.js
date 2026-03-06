const SYSTEM_NPC_OWNER = "__system__";

const NPC_GENDERS = new Set(["male", "female", "non_binary", "unknown"]);
const NPC_ACTION_TYPES = new Set(["MOVE_TO", "SAY", "LOOK_AT", "WAIT"]);
const LOOK_DIRECTIONS = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);
const CHAT_CHANNELS = new Set(["world", "npc_private"]);

const MAX_ID_LENGTH = 64;
const MAX_NPC_NAME_LENGTH = 32;
const MAX_SOUL_LENGTH = 300;
const MAX_MEMORY_SUMMARY_LENGTH = 500;
const MAX_PERSONA_TAGS = 10;
const MAX_PERSONA_TAG_LENGTH = 24;
const MAX_ACTION_BATCH_SIZE = 20;

const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 30000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeId(value) {
  const normalized = normalizeString(value, MAX_ID_LENGTH);
  if (!normalized) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) return "";
  return normalized;
}

function isValidTileCoordinate(x, y, mapWidth, mapHeight) {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < mapWidth &&
    y < mapHeight
  );
}

function sanitizeNpcSnapshot(payload, options = {}) {
  if (!isRecord(payload)) {
    return {
      ok: false,
      reason: "INVALID_PAYLOAD",
      details: { field: "npc", message: "NPC payload must be an object." },
    };
  }

  const mapWidth = Number.isInteger(options.mapWidth) ? options.mapWidth : 0;
  const mapHeight = Number.isInteger(options.mapHeight) ? options.mapHeight : 0;
  const defaultSpawn = isRecord(options.defaultSpawn)
    ? options.defaultSpawn
    : { x: 0, y: 0 };

  const id = normalizeId(payload.id);
  if (!id) {
    return {
      ok: false,
      reason: "INVALID_NPC_ID",
      details: {
        field: "npc.id",
        message:
          "NPC id is required and must match /^[A-Za-z0-9._:-]+$/ with max length 64.",
      },
    };
  }

  const name = normalizeString(payload.name, MAX_NPC_NAME_LENGTH) || "NPC";
  const gender = NPC_GENDERS.has(payload.gender) ? payload.gender : "unknown";
  const soul = normalizeString(payload.soul, MAX_SOUL_LENGTH);
  const memorySummary = normalizeString(
    payload.memorySummary,
    MAX_MEMORY_SUMMARY_LENGTH
  );

  const rawTags = Array.isArray(payload.personaTags) ? payload.personaTags : [];
  const personaTags = [];
  const dedupe = new Set();

  for (const tag of rawTags) {
    const normalizedTag = normalizeString(tag, MAX_PERSONA_TAG_LENGTH);
    if (!normalizedTag || dedupe.has(normalizedTag)) continue;

    dedupe.add(normalizedTag);
    personaTags.push(normalizedTag);

    if (personaTags.length >= MAX_PERSONA_TAGS) break;
  }

  const spawnX =
    payload.spawn && Number.isInteger(payload.spawn.x)
      ? payload.spawn.x
      : defaultSpawn.x;
  const spawnY =
    payload.spawn && Number.isInteger(payload.spawn.y)
      ? payload.spawn.y
      : defaultSpawn.y;

  if (!isValidTileCoordinate(spawnX, spawnY, mapWidth, mapHeight)) {
    return {
      ok: false,
      reason: "INVALID_NPC_SPAWN",
      details: {
        field: "npc.spawn",
        message: `spawn must be an integer tile coordinate in [0, ${mapWidth - 1}] x [0, ${mapHeight - 1}].`,
      },
    };
  }

  return {
    ok: true,
    value: {
      id,
      name,
      gender,
      soul,
      personaTags,
      spawn: {
        x: spawnX,
        y: spawnY,
      },
      memorySummary,
    },
  };
}

function validateNpcActionList(actions, context = {}) {
  if (!Array.isArray(actions)) {
    return {
      ok: false,
      reason: "INVALID_ACTIONS_PAYLOAD",
      details: { field: "actions", message: "actions must be an array." },
    };
  }

  if (actions.length > MAX_ACTION_BATCH_SIZE) {
    return {
      ok: false,
      reason: "ACTION_BATCH_TOO_LARGE",
      details: {
        field: "actions",
        message: `actions length must be <= ${MAX_ACTION_BATCH_SIZE}.`,
      },
    };
  }

  const mapWidth = Number.isInteger(context.mapWidth) ? context.mapWidth : 0;
  const mapHeight = Number.isInteger(context.mapHeight) ? context.mapHeight : 0;
  const players = isRecord(context.players) ? context.players : {};
  const npcs = isRecord(context.npcs) ? context.npcs : {};
  const maxSayLength = Number.isInteger(context.maxSayLength)
    ? context.maxSayLength
    : 200;

  const normalizedActions = [];

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];

    if (!isRecord(action)) {
      return {
        ok: false,
        reason: "INVALID_ACTION",
        details: {
          actionIndex: i,
          field: `actions[${i}]`,
          message: "action must be an object.",
        },
      };
    }

    if (!NPC_ACTION_TYPES.has(action.type)) {
      return {
        ok: false,
        reason: "ACTION_NOT_ALLOWED",
        details: {
          actionIndex: i,
          field: `actions[${i}].type`,
          message: "action type is not whitelisted.",
        },
      };
    }

    if (action.type === "MOVE_TO") {
      if (!isValidTileCoordinate(action.x, action.y, mapWidth, mapHeight)) {
        return {
          ok: false,
          reason: "INVALID_ACTION_COORDINATE",
          details: {
            actionIndex: i,
            field: `actions[${i}].x|y`,
            message: `MOVE_TO x/y must be integer tile coordinates in [0, ${mapWidth - 1}] x [0, ${mapHeight - 1}].`,
          },
        };
      }

      normalizedActions.push({
        type: "MOVE_TO",
        x: action.x,
        y: action.y,
      });
      continue;
    }

    if (action.type === "SAY") {
      const text = normalizeString(action.text, maxSayLength);
      if (!text) {
        return {
          ok: false,
          reason: "INVALID_SAY_TEXT",
          details: {
            actionIndex: i,
            field: `actions[${i}].text`,
            message: `SAY text must be a non-empty string with max length ${maxSayLength}.`,
          },
        };
      }

      const channel = action.channel === undefined ? "world" : action.channel;
      if (!CHAT_CHANNELS.has(channel)) {
        return {
          ok: false,
          reason: "INVALID_SAY_CHANNEL",
          details: {
            actionIndex: i,
            field: `actions[${i}].channel`,
            message: 'SAY channel must be "world" or "npc_private".',
          },
        };
      }

      let targetPlayerId;
      if (channel === "npc_private") {
        targetPlayerId = normalizeId(action.targetPlayerId);
        if (!targetPlayerId || !players[targetPlayerId]) {
          return {
            ok: false,
            reason: "INVALID_SAY_TARGET_PLAYER",
            details: {
              actionIndex: i,
              field: `actions[${i}].targetPlayerId`,
              message:
                "npc_private SAY requires a valid online targetPlayerId.",
            },
          };
        }
      }

      normalizedActions.push({
        type: "SAY",
        text,
        channel,
        targetPlayerId,
      });
      continue;
    }

    if (action.type === "LOOK_AT") {
      const hasTarget = action.targetEntityId !== undefined;
      const hasDirection = action.direction !== undefined;

      if (hasTarget === hasDirection) {
        return {
          ok: false,
          reason: "INVALID_LOOK_AT_ARGS",
          details: {
            actionIndex: i,
            field: `actions[${i}].targetEntityId|direction`,
            message:
              "LOOK_AT must provide exactly one of targetEntityId or direction.",
          },
        };
      }

      if (hasTarget) {
        const targetEntityId = normalizeId(action.targetEntityId);
        if (!targetEntityId || (!players[targetEntityId] && !npcs[targetEntityId])) {
          return {
            ok: false,
            reason: "INVALID_LOOK_TARGET",
            details: {
              actionIndex: i,
              field: `actions[${i}].targetEntityId`,
              message: "LOOK_AT targetEntityId must be an existing player or NPC id.",
            },
          };
        }

        normalizedActions.push({
          type: "LOOK_AT",
          targetEntityId,
        });
        continue;
      }

      if (!LOOK_DIRECTIONS.has(action.direction)) {
        return {
          ok: false,
          reason: "INVALID_LOOK_DIRECTION",
          details: {
            actionIndex: i,
            field: `actions[${i}].direction`,
            message: 'LOOK_AT direction must be one of "UP" | "DOWN" | "LEFT" | "RIGHT".',
          },
        };
      }

      normalizedActions.push({
        type: "LOOK_AT",
        direction: action.direction,
      });
      continue;
    }

    if (
      !Number.isInteger(action.durationMs) ||
      action.durationMs < MIN_WAIT_MS ||
      action.durationMs > MAX_WAIT_MS
    ) {
      return {
        ok: false,
        reason: "INVALID_WAIT_DURATION",
        details: {
          actionIndex: i,
          field: `actions[${i}].durationMs`,
          message: `WAIT durationMs must be an integer in [${MIN_WAIT_MS}, ${MAX_WAIT_MS}].`,
        },
      };
    }

    normalizedActions.push({
      type: "WAIT",
      durationMs: action.durationMs,
    });
  }

  return {
    ok: true,
    value: normalizedActions,
  };
}

function createRateLimiter() {
  const buckets = new Map();

  return {
    consume(key, limit, windowMs) {
      const now = Date.now();
      const bucket = buckets.get(key) || [];
      const recent = bucket.filter((ts) => now - ts < windowMs);

      if (recent.length >= limit) {
        const retryAfterMs = windowMs - (now - recent[0]);
        buckets.set(key, recent);
        return {
          ok: false,
          retryAfterMs: retryAfterMs > 0 ? retryAfterMs : 0,
        };
      }

      recent.push(now);
      buckets.set(key, recent);
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

function logSecurityRejection({ event, socketId, reason, details }) {
  const context = {
    socketId: socketId || "unknown",
    event: event || "unknown",
    reason: reason || "UNSPECIFIED",
    details: details || {},
  };

  console.warn("[Security] Rejected event", JSON.stringify(context));
}

module.exports = {
  SYSTEM_NPC_OWNER,
  createRateLimiter,
  isValidTileCoordinate,
  logSecurityRejection,
  sanitizeNpcSnapshot,
  validateNpcActionList,
};
