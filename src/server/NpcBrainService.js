const http = require("http");
const https = require("https");
const { validateNpcActionList } = require("./security");

const DEFAULT_CHAT_COMPLETIONS_URL = "http://localhost:11434/v1/chat/completions";
const DEFAULT_LLM_MODEL = "qwen3-coder:latest";
const DEFAULT_LLM_API_KEY = "";
const DEFAULT_WAIT_MS = 1500;
const DEFAULT_MAX_ACTIONS = 4;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_CONTEXT_LENGTH = 240;
const DEFAULT_MAX_OUTPUT_TOKENS = 280;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function trimString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function extractJsonPayload(text) {
  if (typeof text !== "string") return "";

  let normalized = text.trim();
  if (!normalized) return "";

  if (normalized.startsWith("```")) {
    normalized = normalized
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }

  return normalized;
}

function parseJsonSafe(raw) {
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function normalizeJsonForLog(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonForLog(item));
  }

  if (!isRecord(value)) return value;

  const normalized = {};
  Object.entries(value).forEach(([key, currentValue]) => {
    if (typeof currentValue === "string") {
      const parsed = parseJsonSafe(currentValue);
      normalized[key] =
        parsed === null ? currentValue : normalizeJsonForLog(parsed);
      return;
    }

    if (Array.isArray(currentValue) || isRecord(currentValue)) {
      normalized[key] = normalizeJsonForLog(currentValue);
      return;
    }

    normalized[key] = currentValue;
  });

  return normalized;
}

function formatJsonForLog(raw) {
  if (typeof raw !== "string") return String(raw);

  const parsed = parseJsonSafe(raw);
  if (parsed === null) return raw;

  return JSON.stringify(normalizeJsonForLog(parsed), null, 2);
}

function toWaitAction(durationMs) {
  return {
    type: "WAIT",
    durationMs,
  };
}

function buildSystemPrompt(promptPayload, maxActions) {
  const trigger = isRecord(promptPayload?.trigger) ? promptPayload.trigger : {};
  const world = isRecord(promptPayload?.world) ? promptPayload.world : {};
  const npc = isRecord(promptPayload?.npc) ? promptPayload.npc : {};
  const spawn = isRecord(npc.spawn) ? npc.spawn : { x: 0, y: 0 };
  const triggerType =
    typeof trigger.type === "string" ? trigger.type.trim() : "manual";
  const mapWidth = Number.isInteger(world.mapWidth) ? world.mapWidth : 0;
  const mapHeight = Number.isInteger(world.mapHeight) ? world.mapHeight : 0;
  const maxActionCount = Number.isInteger(maxActions) ? maxActions : 4;

  const lines = [
    "你是一个人，只能输出 JSON。",
    "绝对不要输出 markdown、解释、注释、额外文本。",
    "",
    "输出格式必须严格为：",
    '{"actions":[...]}',
    "",
    "动作对象只能使用以下 4 种 schema（字段名必须完全一致）：",
    '{"type":"MOVE_TO","x":<int>,"y":<int>}',
    '{"type":"SAY","text":"<string>","channel":"world"}',
    '{"type":"SAY","text":"<string>","channel":"npc_private","targetPlayerId":"<string>"}',
    '{"type":"LOOK_AT","direction":"DOWN"}',
    '{"type":"LOOK_AT","targetEntityId":"<string>"}',
    '{"type":"WAIT","durationMs":<int>}',
    "",
    "严格禁止使用错误字段，例如：action、duration、message、content。",
    "WAIT 只能使用 durationMs，单位毫秒，范围 100~300。",
    `actions 数量必须在 1~${maxActionCount}。`,
    `地图边界：0 <= x < ${mapWidth}，0 <= y < ${mapHeight}。`,
  ];

  return lines.join("\n");
}

function resolveContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((chunk) => {
      if (!isRecord(chunk)) return "";
      return typeof chunk.text === "string" ? chunk.text : "";
    })
    .join("")
    .trim();
}

function makeHttpRequest(endpoint, headers, body, timeoutMs, traceId) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_error) {
      reject(new Error("INVALID_LLM_ENDPOINT"));
      return;
    }

    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search || ""}`,
        method: "POST",
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          const statusCode = Number(res.statusCode || 0);
          const formattedResponse = formatJsonForLog(raw);
          console.log(
            `[NpcBrain][LLMResponseRaw][${traceId}] status=${statusCode}\n${formattedResponse}`
          );
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `LLM_HTTP_${statusCode || "UNKNOWN"}: ${raw.slice(0, 300)}`
              )
            );
            return;
          }
          resolve(raw);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("LLM_TIMEOUT"));
    });

    req.on("error", (error) => reject(error));
    req.write(body);
    req.end();
  });
}

class NpcBrainService {
  constructor(options = {}) {
    this.provider = trimString(
      options.provider || process.env.NPC_BRAIN_PROVIDER || "ollama",
      32
    ).toLowerCase();
    this.endpoint = trimString(
      options.endpoint || process.env.NPC_BRAIN_ENDPOINT || DEFAULT_CHAT_COMPLETIONS_URL,
      300
    );
    this.model = trimString(
      options.model || process.env.NPC_BRAIN_MODEL || DEFAULT_LLM_MODEL,
      80
    );
    this.apiKey = trimString(
      options.apiKey || process.env.NPC_BRAIN_API_KEY || DEFAULT_LLM_API_KEY,
      300
    );
    this.temperature =
      typeof options.temperature === "number"
        ? options.temperature
        : Number(process.env.NPC_BRAIN_TEMPERATURE || 0.3);
    this.timeoutMs = clampInteger(
      Number(options.timeoutMs || process.env.NPC_BRAIN_TIMEOUT_MS),
      1000,
      60000,
      DEFAULT_TIMEOUT_MS
    );
    this.maxOutputTokens = clampInteger(
      Number(options.maxOutputTokens || process.env.NPC_BRAIN_MAX_OUTPUT_TOKENS),
      60,
      2048,
      DEFAULT_MAX_OUTPUT_TOKENS
    );
    this.maxActions = clampInteger(
      Number(options.maxActions || process.env.NPC_BRAIN_MAX_ACTIONS),
      1,
      20,
      DEFAULT_MAX_ACTIONS
    );
    this.defaultWaitMs = clampInteger(
      Number(options.defaultWaitMs || process.env.NPC_BRAIN_DEFAULT_WAIT_MS),
      100,
      30000,
      DEFAULT_WAIT_MS
    );
    this.maxContextLength = clampInteger(
      Number(options.maxContextLength || process.env.NPC_BRAIN_MAX_CONTEXT_LENGTH),
      80,
      1200,
      DEFAULT_MAX_CONTEXT_LENGTH
    );
  }

  async decidePlan(input = {}) {
    const npc = isRecord(input.npc) ? input.npc : {};
    const npcId = trimString(npc.id, 64);
    const fallbackActions = [toWaitAction(this.defaultWaitMs)];
    const validationContext = isRecord(input.validationContext)
      ? input.validationContext
      : {};

    if (!npcId) {
      return {
        actions: fallbackActions,
        usedFallback: true,
        source: "fallback",
        reason: "NPC_ID_REQUIRED",
      };
    }

    const trigger = isRecord(input.trigger) ? input.trigger : {};
    const availableActions = Array.isArray(input.availableActions)
      ? input.availableActions
      : ["MOVE_TO", "SAY", "LOOK_AT", "WAIT"];
    const promptPayload = {
      npc: {
        id: npcId,
        name: trimString(npc.name, 32) || "NPC",
        soul: trimString(npc.soul, 300),
        personaTags: Array.isArray(npc.personaTags)
          ? npc.personaTags.slice(0, 10)
          : [],
        memorySummary: trimString(npc.memorySummary, 500),
        spawn: isRecord(npc.spawn)
          ? {
              x: Number.isInteger(npc.spawn.x) ? npc.spawn.x : 0,
              y: Number.isInteger(npc.spawn.y) ? npc.spawn.y : 0,
            }
          : undefined,
      },
      trigger: {
        type: trimString(trigger.type, 24) || "manual",
        playerId: trimString(trigger.playerId, 64),
        playerName: trimString(trigger.playerName, 64),
        message: trimString(trigger.message, this.maxContextLength),
        context: trimString(trigger.context, this.maxContextLength),
      },
      world: isRecord(input.worldContext) ? input.worldContext : {},
      availableActions,
      maxActions: this.maxActions,
      outputContract: {
        format: '{ "actions": [ ... ] }',
        note: "only output whitelisted actions",
      },
    };

    let rawResponse = "";
    const source = "remote";

    try {
      rawResponse = await this.requestRemotePlan(promptPayload);
    } catch (error) {
      return {
        actions: fallbackActions,
        usedFallback: true,
        source: "fallback",
        reason: "BRAIN_REQUEST_FAILED",
        details: { message: String(error && error.message ? error.message : error) },
      };
    }

    const parsedActions = this.extractActions(rawResponse);
    if (!parsedActions) {
      return {
        actions: fallbackActions,
        usedFallback: true,
        source: "fallback",
        reason: "BRAIN_OUTPUT_NOT_JSON",
        details: {
          rawPreview: rawResponse.slice(0, 300),
        },
      };
    }

    const limitedActions = parsedActions.slice(0, this.maxActions);
    const validation = validateNpcActionList(limitedActions, validationContext);
    if (!validation.ok) {
      return {
        actions: fallbackActions,
        usedFallback: true,
        source: "fallback",
        reason: validation.reason || "BRAIN_OUTPUT_INVALID",
        details: validation.details || {},
      };
    }

    return {
      actions: validation.value,
      usedFallback: false,
      source,
      reason: null,
    };
  }

  async requestRemotePlan(promptPayload) {
    const traceId = `npc-brain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const systemPrompt = buildSystemPrompt(promptPayload, this.maxActions);
    const requestBody = JSON.stringify({
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: JSON.stringify(promptPayload),
        },
      ],
    });
    const formattedRequest = formatJsonForLog(requestBody);

    console.log(
      `[NpcBrain][LLMRequestRaw][${traceId}] endpoint=${this.endpoint}\n${formattedRequest}`
    );

    const raw = await makeHttpRequest(
      this.endpoint,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      requestBody,
      this.timeoutMs,
      traceId
    );

    const parsed = parseJsonSafe(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.choices) || !parsed.choices[0]) {
      throw new Error("INVALID_LLM_RESPONSE_SHAPE");
    }

    const message = isRecord(parsed.choices[0].message)
      ? parsed.choices[0].message
      : {};
    const content = resolveContentText(message.content);
    if (!content) throw new Error("EMPTY_LLM_CONTENT");

    return content;
  }

  extractActions(rawResponse) {
    const payload = extractJsonPayload(rawResponse);
    const parsed = parseJsonSafe(payload);

    if (Array.isArray(parsed)) return parsed;
    if (!isRecord(parsed)) return null;

    if (Array.isArray(parsed.actions)) return parsed.actions;
    if (isRecord(parsed.output) && Array.isArray(parsed.output.actions)) {
      return parsed.output.actions;
    }

    return null;
  }
}

module.exports = NpcBrainService;
