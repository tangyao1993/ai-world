export const NPC_ACTION_WHITELIST = [
  "MOVE_TO",
  "SAY",
  "LOOK_AT",
  "WAIT",
  "INTERACT",
  "COLLECT",
  "TALK_TO_NPC",
  "GIFT_TO_NPC",
  "ATTACK_NPC",
] as const;

export type NpcActionType = (typeof NPC_ACTION_WHITELIST)[number];

export type NpcLookDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";
export type NpcSayChannel = "world" | "npc_private";

export interface MoveToAction {
  type: "MOVE_TO";
  x: number;
  y: number;
}

export interface SayAction {
  type: "SAY";
  text: string;
  channel?: NpcSayChannel;
  targetPlayerId?: string;
}

export interface LookAtAction {
  type: "LOOK_AT";
  targetEntityId?: string;
  direction?: NpcLookDirection;
}

export interface WaitAction {
  type: "WAIT";
  durationMs: number;
}

export interface InteractAction {
  type: "INTERACT";
  targetEntityId: string;
}

export interface CollectAction {
  type: "COLLECT";
  resourceId: string;
}

export interface TalkToNpcAction {
  type: "TALK_TO_NPC";
  targetNpcId: string;
  text: string;
}

export interface GiftToNpcAction {
  type: "GIFT_TO_NPC";
  targetNpcId: string;
  itemId: string;
  quantity: number;
}

export interface AttackNpcAction {
  type: "ATTACK_NPC";
  targetNpcId: string;
}

export type NpcAction =
  | MoveToAction
  | SayAction
  | LookAtAction
  | WaitAction
  | InteractAction
  | CollectAction
  | TalkToNpcAction
  | GiftToNpcAction
  | AttackNpcAction;

export interface ValidationIssue {
  code: string;
  field: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationIssue[] };

const MAX_COORDINATE = 100000;
const MAX_SAY_LENGTH = 200;
const MAX_ID_LENGTH = 64;
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 30000;
const MAX_GIFT_QUANTITY = 99;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number
): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function hasAllowedActionType(type: unknown): type is NpcActionType {
  return (
    typeof type === "string" &&
    NPC_ACTION_WHITELIST.includes(type as NpcActionType)
  );
}

export function validateNpcAction(action: unknown): ValidationResult<NpcAction> {
  if (!isRecord(action)) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_ACTION",
          field: "action",
          message: "Action must be an object.",
        },
      ],
    };
  }

  if (!hasAllowedActionType(action.type)) {
    return {
      ok: false,
      errors: [
        {
          code: "ACTION_NOT_ALLOWED",
          field: "type",
          message:
            "Action type is not in whitelist. Allowed: MOVE_TO, SAY, LOOK_AT, WAIT, INTERACT, COLLECT, TALK_TO_NPC, GIFT_TO_NPC, ATTACK_NPC.",
        },
      ],
    };
  }

  switch (action.type) {
    case "MOVE_TO":
      if (!isIntegerInRange(action.x, 0, MAX_COORDINATE)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "x",
              message: `x must be an integer in [0, ${MAX_COORDINATE}].`,
            },
          ],
        };
      }
      if (!isIntegerInRange(action.y, 0, MAX_COORDINATE)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "y",
              message: `y must be an integer in [0, ${MAX_COORDINATE}].`,
            },
          ],
        };
      }
      return {
        ok: true,
        value: {
          type: "MOVE_TO",
          x: action.x,
          y: action.y,
        },
      };
    case "SAY": {
      if (typeof action.text !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "text",
              message: "text must be a string.",
            },
          ],
        };
      }

      const text = action.text.trim();
      if (text.length < 1 || text.length > MAX_SAY_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "text",
              message: `text length must be in [1, ${MAX_SAY_LENGTH}].`,
            },
          ],
        };
      }

      if (
        action.channel !== undefined &&
        action.channel !== "world" &&
        action.channel !== "npc_private"
      ) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "channel",
              message: 'channel must be "world" or "npc_private".',
            },
          ],
        };
      }

      if (action.targetPlayerId !== undefined) {
        if (typeof action.targetPlayerId !== "string") {
          return {
            ok: false,
            errors: [
              {
                code: "INVALID_ARG",
                field: "targetPlayerId",
                message: "targetPlayerId must be a string.",
              },
            ],
          };
        }
        const targetPlayerId = action.targetPlayerId.trim();
        if (targetPlayerId.length < 1 || targetPlayerId.length > MAX_ID_LENGTH) {
          return {
            ok: false,
            errors: [
              {
                code: "INVALID_ARG",
                field: "targetPlayerId",
                message: `targetPlayerId length must be in [1, ${MAX_ID_LENGTH}].`,
              },
            ],
          };
        }
      }

      return {
        ok: true,
        value: {
          type: "SAY",
          text,
          channel: action.channel as NpcSayChannel | undefined,
          targetPlayerId:
            typeof action.targetPlayerId === "string"
              ? action.targetPlayerId.trim()
              : undefined,
        },
      };
    }
    case "LOOK_AT": {
      const hasTarget = action.targetEntityId !== undefined;
      const hasDirection = action.direction !== undefined;
      if (hasTarget === hasDirection) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetEntityId|direction",
              message:
                "LOOK_AT must provide exactly one of targetEntityId or direction.",
            },
          ],
        };
      }

      if (hasTarget) {
        if (typeof action.targetEntityId !== "string") {
          return {
            ok: false,
            errors: [
              {
                code: "INVALID_ARG",
                field: "targetEntityId",
                message: "targetEntityId must be a string.",
              },
            ],
          };
        }
        const targetEntityId = action.targetEntityId.trim();
        if (targetEntityId.length < 1 || targetEntityId.length > MAX_ID_LENGTH) {
          return {
            ok: false,
            errors: [
              {
                code: "INVALID_ARG",
                field: "targetEntityId",
                message: `targetEntityId length must be in [1, ${MAX_ID_LENGTH}].`,
              },
            ],
          };
        }
        return {
          ok: true,
          value: {
            type: "LOOK_AT",
            targetEntityId,
          },
        };
      }

      if (
        action.direction !== "UP" &&
        action.direction !== "DOWN" &&
        action.direction !== "LEFT" &&
        action.direction !== "RIGHT"
      ) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "direction",
              message: 'direction must be one of "UP" | "DOWN" | "LEFT" | "RIGHT".',
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "LOOK_AT",
          direction: action.direction,
        },
      };
    }
    case "WAIT":
      if (!isIntegerInRange(action.durationMs, MIN_WAIT_MS, MAX_WAIT_MS)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "durationMs",
              message: `durationMs must be an integer in [${MIN_WAIT_MS}, ${MAX_WAIT_MS}].`,
            },
          ],
        };
      }
      return {
        ok: true,
        value: {
          type: "WAIT",
          durationMs: action.durationMs,
        },
      };
    case "INTERACT": {
      if (typeof action.targetEntityId !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetEntityId",
              message: "targetEntityId must be a string.",
            },
          ],
        };
      }

      const targetEntityId = action.targetEntityId.trim();
      if (targetEntityId.length < 1 || targetEntityId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetEntityId",
              message: `targetEntityId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "INTERACT",
          targetEntityId,
        },
      };
    }
    case "COLLECT": {
      if (
        typeof action.resourceId !== "string" &&
        typeof action.resourceId !== "number"
      ) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "resourceId",
              message: "resourceId must be a string or number.",
            },
          ],
        };
      }

      const resourceId = String(action.resourceId).trim();
      if (resourceId.length < 1 || resourceId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "resourceId",
              message: `resourceId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "COLLECT",
          resourceId,
        },
      };
    }
    case "TALK_TO_NPC": {
      if (typeof action.targetNpcId !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: "targetNpcId must be a string.",
            },
          ],
        };
      }

      const targetNpcId = action.targetNpcId.trim();
      if (targetNpcId.length < 1 || targetNpcId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: `targetNpcId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }

      if (typeof action.text !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "text",
              message: "text must be a string.",
            },
          ],
        };
      }

      const text = action.text.trim();
      if (text.length < 1 || text.length > MAX_SAY_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "text",
              message: `text length must be in [1, ${MAX_SAY_LENGTH}].`,
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "TALK_TO_NPC",
          targetNpcId,
          text,
        },
      };
    }
    case "GIFT_TO_NPC": {
      if (typeof action.targetNpcId !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: "targetNpcId must be a string.",
            },
          ],
        };
      }

      if (typeof action.itemId !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "itemId",
              message: "itemId must be a string.",
            },
          ],
        };
      }

      if (!isIntegerInRange(action.quantity, 1, MAX_GIFT_QUANTITY)) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "quantity",
              message: `quantity must be an integer in [1, ${MAX_GIFT_QUANTITY}].`,
            },
          ],
        };
      }

      const targetNpcId = action.targetNpcId.trim();
      const itemId = action.itemId.trim();
      if (targetNpcId.length < 1 || targetNpcId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: `targetNpcId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }
      if (itemId.length < 1 || itemId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "itemId",
              message: `itemId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "GIFT_TO_NPC",
          targetNpcId,
          itemId,
          quantity: action.quantity,
        },
      };
    }
    case "ATTACK_NPC": {
      if (typeof action.targetNpcId !== "string") {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: "targetNpcId must be a string.",
            },
          ],
        };
      }

      const targetNpcId = action.targetNpcId.trim();
      if (targetNpcId.length < 1 || targetNpcId.length > MAX_ID_LENGTH) {
        return {
          ok: false,
          errors: [
            {
              code: "INVALID_ARG",
              field: "targetNpcId",
              message: `targetNpcId length must be in [1, ${MAX_ID_LENGTH}].`,
            },
          ],
        };
      }

      return {
        ok: true,
        value: {
          type: "ATTACK_NPC",
          targetNpcId,
        },
      };
    }
    default:
      return {
        ok: false,
        errors: [
          {
            code: "ACTION_NOT_ALLOWED",
            field: "type",
            message: "Unknown action type.",
          },
        ],
      };
  }
}

export function validateNpcActionList(
  actions: unknown
): ValidationResult<NpcAction[]> {
  if (!Array.isArray(actions)) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_ACTION_LIST",
          field: "actions",
          message: "actions must be an array.",
        },
      ],
    };
  }

  const validActions: NpcAction[] = [];
  const errors: ValidationIssue[] = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const result = validateNpcAction(action);
    if ("errors" in result) {
      result.errors.forEach((err) => {
        errors.push({
          ...err,
          field: `actions[${index}].${err.field}`,
        });
      });
      continue;
    }

    validActions.push(result.value);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: validActions };
}
